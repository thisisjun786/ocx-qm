import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MINUTE, expired } from './time.mjs';
const WINDOWS = { session: ['five-hour', '5시간'], weekly: ['weekly', '주간'], monthly: ['monthly', '월간'] };
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function parseOllamaUsage(body) {
  const result = {};
  for (const name of Object.keys(WINDOWS)) {
    const value = body?.limits?.[name];
    if (!finite(value?.usage)) continue;
    const models = Object.create(null);
    for (const m of Array.isArray(value.models) ? value.models : []) {
      if (typeof m.name === 'string' && m.name.length <= 200 && Number.isSafeInteger(m.request_count) && m.request_count >= 0) models[m.name] = m.request_count;
    }
    result[name] = { used: value.usage * 100, models };
  }
  if (!Object.keys(result).length) throw new Error('Ollama usage unavailable');
  return result;
}

// Calibrate only isolated, counter-matched model runs. Input/output ratios describe
// the observed workload mix; they are not separately identified GPU coefficients.
export function calibrateOllama(observations, usageRows, window) {
  const totals = new Map();
  let start = observations[0];
  for (let i = 1; i < observations.length; i++) {
    const end = observations[i], previous = observations[i - 1];
    const a = start?.limits[window], b = end.limits[window], prev = previous.limits[window];
    if (!a || !b || !prev || (end.at <= previous.at || end.at - previous.at > 3 * MINUTE) || b.used < prev.used ||
      Object.entries(prev.models).some(([m, n]) => (b.models[m] ?? 0) < n)) { start = end; continue; }
    const delta = b.used - a.used;
    if (end.at - start.at < 5 * MINUTE || delta < .2) continue;
    const changes = Object.entries(b.models).map(([model, n]) => [model, n - (a.models[model] ?? 0)]).filter(([, n]) => n > 0);
    const rows = usageRows.filter(r => r.at > start.at && r.at <= end.at);
    if (changes.length === 1) {
      const [model, count] = changes[0];
      const matches = rows.filter(r => r.model === model && finite(r.input) && finite(r.output));
      if (rows.length === count && matches.length === count && matches.every(r => r.input + r.output > 0)) {
        const t = totals.get(model) ?? { model, intervals: 0, requests: 0, deltaPp: 0, inputTokens: 0, outputTokens: 0, apiUsd: 0, priced: true };
        t.intervals++; t.requests += count; t.deltaPp += delta;
        for (const r of matches) { t.inputTokens += r.input; t.outputTokens += r.output; t.priced &&= finite(r.usd); t.apiUsd += r.usd ?? 0; }
        totals.set(model, t);
      }
    }
    start = end;
  }
  return [...totals.values()].map(t => ({ ...t, inputTokensPerPp: t.inputTokens / t.deltaPp,
    outputTokensPerPp: t.outputTokens / t.deltaPp, apiUsdPerPp: t.priced ? t.apiUsd / t.deltaPp : null }));
}

export function createOllamaMonitor({ home, store, now = Date.now, fetcher = fetch }) {
  store.db.exec('CREATE TABLE IF NOT EXISTS ollama_observations (source TEXT, at INTEGER, payload TEXT, PRIMARY KEY(source,at))');
  let sources = [], failed = false, lastAttemptAt = null;
  async function collect() {
    lastAttemptAt = now();
    try {
      const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
      const p = config.providers?.['ollama-cloud'];
      sources = [];
      if (!p || p.disabled) return;
      const url = new URL(p.baseUrl ?? 'https://ollama.com');
      if (url.origin !== 'https://ollama.com' || url.username || url.password || !['/', '/v1', '/v1/', '/api', '/api/'].includes(url.pathname)) return;
      const keys = (p.apiKeyPool ?? []).filter(k => typeof k.id === 'string' && typeof k.key === 'string' && k.key);
      if (typeof p.apiKey === 'string' && p.apiKey && !keys.some(k => k.key === p.apiKey)) keys.push({ id: 'default', key: p.apiKey });
      failed = false;
      for (const k of keys) {
        const source = createHash('sha256').update('quota-monitor-ollama\0' + k.key).digest('hex');
        const row = { id: `key:${k.id}`, source, isolated: keys.length === 1, failed: false };
        sources.push(row);
        try {
          const response = await fetcher('https://ollama.com/api/usage', { headers: { Accept: 'application/json', Authorization: `Bearer ${k.key}` }, redirect: 'error', signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error('Usage request failed');
          const body = await response.text();
          if (body.length > 1024 * 1024) throw new Error('Usage response too large');
          const limits = parseOllamaUsage(JSON.parse(body));
          store.db.prepare('INSERT OR IGNORE INTO ollama_observations VALUES (?,?,?)').run(source, now(), JSON.stringify(limits));
        } catch { row.failed = true; }
      }
    } catch { failed = true; }
  }
  function enrich(snapshot) {
    const time = now();
    const provider = snapshot.providers.find(p => p.id === 'ollama-cloud');
    if (!provider) return snapshot;
    for (const { id, source, isolated, failed: sourceFailed } of sources) {
      const account = provider.accounts.find(a => a.id === id);
      if (!account) continue;
      account.refresh = { status: failed || sourceFailed ? 'delayed' : 'ok', lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(), nextAttemptAt: null };
      const observations = store.db.prepare('SELECT at,payload FROM ollama_observations WHERE source=? AND at>? ORDER BY at').all(source, time - 30 * 86400000).map(r => ({ at: r.at, limits: JSON.parse(r.payload) }));
      const latest = observations.at(-1);
      if (!latest) continue;
      const stale = expired(latest.at, time);
      account.updatedAt = new Date(latest.at).toISOString(); account.status = stale ? 'stale' : 'ok'; account.quotaMode = 'observed';
      account.windows = Object.entries(latest.limits).map(([name, value]) => ({ id: WINDOWS[name][0], label: WINDOWS[name][1],
        usedPercent: Math.min(100, value.used), remainingPercent: Math.max(0, 100 - value.used), resetAt: null, stale }));
      // Bare-provider historical requests are not assigned to today's key. They
      // can support calibration only during monitoring with a single key and
      // exact provider-side counter agreement.
      const usage = isolated && observations.length > 1 ? store.db.prepare("SELECT u.at,u.model,u.input,u.output,u.usd FROM usage u JOIN usage_timings t ON t.id=u.id WHERE u.provider='ollama-cloud' AND t.tokensReported=1 AND u.at>? AND u.at<=? ORDER BY u.at").all(observations[0].at, latest.at) : [];
      account.ollama = { status: stale ? 'stale' : 'collecting', windows: Object.keys(latest.limits).map(name => ({ id: WINDOWS[name][0], label: WINDOWS[name][1], models: isolated ? calibrateOllama(observations, usage, name) : [] })) };
    }
    return snapshot;
  }
  return { collect, enrich };
}
