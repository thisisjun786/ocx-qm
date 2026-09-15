import {ACCOUNT_BINDINGS, credentialBinding, addBinding} from './subscription-identity.mjs';
export {ACCOUNT_BINDINGS} from './subscription-identity.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { iso, epochIso, expired } from './time.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Values that must never be published as a model name, carried beside the projection
// on a symbol key. JSON.stringify ignores symbol-keyed properties, so this reaches the
// collector without ever entering the response, and no file is read twice.
// Values that must never be published as a model name or an account label, carried
// beside the projection on a symbol key. JSON.stringify ignores symbol-keyed
// properties, so this reaches the collector without ever entering the response, and
// no file is read twice.
export const MODEL_EXCLUSIONS = Symbol('quota-monitor.modelExclusions');
const NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', cursor: 'Cursor',
  'ollama-cloud': 'Ollama Cloud', 'opencode-go': 'OpenCode Go', devin: 'Devin', 'command-code': 'Command Code' };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(record) : [];
const text = value => typeof value === 'string' && value.length <= 200 ? value : null;
// Model IDs are projected field by field as validated strings. No configuration object
// is ever spread into the response, so a neighbouring credential cannot ride along.
// Real IDs carry namespaces and version suffixes (Pro/deepseek-ai/DeepSeek-V3,
// claude-sonnet-4@20250514, gpt-oss:120b), so segments are permitted — but a relative
// or absolute path is not a model ID, and neither is anything with whitespace or a
// control character. That keeps a filesystem path from being published as a model name.
// The tilde is the catalog's alias marker (~anthropic/claude-opus-latest), not a home
// shortcut: a path is already excluded by the segment rules below.
// Brackets carry a real context variant in installed OCX ids (k3[1m], glm-5.3[1m],
// claude-opus-4-8[1m]). They are allowed only as a trailing marker on a non-empty base,
// and only in a bare or vendor-prefixed id, because every registered bracketed id has
// that shape. A looser allowance would readmit paths such as C:/Users/x[1]/.opencodex
// and ~root/[private], which the segment rules alone do not exclude.
const MODEL_SEGMENT = /^[\w.:+@~-]+(?:\[[A-Za-z0-9]+\])?$/;
const MODEL_BASE = part => part.split('[')[0];
// Every bracketed id the installed package registers is a bare model name: k3[1m],
// glm-5.3[1m], claude-opus-4-8[1m]. Permitting a vendor prefix as well would readmit
// C:/secret[1m] and ~root/secret[1m], which a drive letter and a named home make look
// like ordinary segments. A prefixed variant can be allowed when one actually exists.
const MAX_BRACKET_SEGMENTS = 1;
export const modelId = value => {
  const id = text(value);
  if (id === null || !id.length || id.length > 100) return null;
  const segments = id.split('/');
  // A single letter before a colon is a Windows drive, not a model tag: every real
  // tagged id (gpt-oss:120b, qwen3.5:397b) carries a full name before the colon.
  if (segments.some(part => /^[A-Za-z]:/.test(part))) return null;
  // A dot-leading segment is a hidden file or directory, never a model name: no id in
  // the installed package or the models.dev cache has one, and dots in real ids are
  // always interior (glm-5.3, Qwen3.6-35B). This is what makes ~jun/.opencodex/... a path.
  if (segments.some(part => MODEL_BASE(part).startsWith('.'))) return null;
  // The catalog's alias marker is always a SINGLE leading tilde on a two-segment id
  // (~anthropic/claude-opus-latest, 16 of 16 in the cache carry exactly one). Anywhere
  // else a tilde is a home reference, so ~jun/x/y, a bare ~name, and any id carrying a
  // second tilde such as ~~jun/config.json are not model names.
  const tildes = [...id].filter(character => character === '~').length;
  if (tildes && !(tildes === 1 && id[0] === '~' && segments.length === 2)) return null;
  // A bracketed marker never appears deep inside a namespace, so a deep path carrying
  // one is not a model id.
  if (segments.some(part => part.includes('[')) && segments.length > MAX_BRACKET_SEGMENTS) return null;
  // Some providers namespace deeply (fireworks_ai/accounts/fireworks/models/<name>).
  // A bare "~" segment is a home reference, while the catalog's alias marker always
  // carries the vendor in the same segment (~anthropic/claude-opus-latest).
  return segments.length <= 6 && segments.every(part =>
    part.length && !['.', '..', '~'].includes(MODEL_BASE(part)) && MODEL_SEGMENT.test(part)) ? id : null;
};
// A disable entry qualifies a model with its provider. The provider is split off first
// so the qualification never consumes the model's own segment and length allowance.
const disabledKey = value => {
  const entry = text(value);
  if (entry === null) return null;
  const slash = entry.indexOf('/');
  if (slash <= 0) return null;
  const provider = entry.slice(0, slash), model = modelId(entry.slice(slash + 1));
  return model === null || !MODEL_SEGMENT.test(provider) ? null : `${provider}/${model}`;
};
// A configured key is a secret wherever it stands as a complete piece of a value, so
// "vendor/<key>", "<key>[1m]", "hf:<key>" and "backup <key>" all publish it. A piece is
// delimited by whitespace or by the model-syntax punctuation modelId admits around a
// name. The in-word characters - . _ + @ are deliberately NOT delimiters: a key of
// "gemini-3" must not delete gemini-3.8-flash, and a raw substring rule that did exactly
// that deleted 126 real model names in an earlier revision.
//
// The consequence is a deliberate collision: a key written as a whole piece of a real id
// deletes that id, so apiKey "k3" removes k3[1m]. That is intended and tested. It cannot
// be avoided without reopening the decorated-key exposure this rule exists to close.
const SECRET_DELIMITER = /[\s/:[\]~]/;
export const carriesSecret = (value, secrets) => {
  if (!secrets?.size || typeof value !== 'string') return false;
  for (const secret of secrets) {
    if (value === secret) return true;
    if (!secret.length) continue;
    // Every occurrence, advancing one character: in "xa/a/a" the key "a/a" is unbounded
    // at index 1 and bounded at index 3, and skipping a whole match would miss it.
    for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1)) {
      const before = at === 0 ? '' : value[at - 1];
      const after = value[at + secret.length] ?? '';
      if ((before === '' || SECRET_DELIMITER.test(before)) && (after === '' || SECRET_DELIMITER.test(after))) return true;
    }
  }
  return false;
};
const modelList = (value, secrets = new Set()) => Array.isArray(value)
  ? value.map(modelId).filter(id => id !== null && !carriesSecret(id, secrets))
  : [];

function label(value, fallback, secrets) {
  const s = text(value);
  if (!s) return fallback;
  // A label is free text from the same configuration that holds the keys. One that
  // carries a key's value is replaced by the generic name rather than published.
  if (carriesSecret(s, secrets)) return fallback;
  if (!s.includes('@')) return s;
  const [local, domain] = s.split('@');
  return `${local.slice(0, 2)}•••@${domain}`;
}

async function readObject(path, warnings, name, required = false) {
  try {
    const raw = await readFile(path);
    if (raw.length > MAX_FILE_BYTES) throw new Error('size');
    const result = JSON.parse(raw.toString());
    if (!record(result)) throw new Error('shape');
    return result;
  } catch {
    if (required) throw new Error('OpenCodex configuration unavailable');
    warnings.push(`${name} 정보를 읽지 못했습니다. OpenCodex 상태를 확인해 주세요.`);
    return {};
  }
}

export function projectQuotaAccount(id, name, plan, active, quota, now, state = {}) {
  const q = record(quota) ? quota : {};
  const updatedAt = typeof q.updatedAt === 'number' ? iso(q.updatedAt) : null;
  const old = !updatedAt || expired(q.updatedAt, now);
  const windows = [];
  const add = (key, title, value, reset) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    const usedPercent = Math.min(100, value);
    const resetAt = epochIso(reset);
    windows.push({ id: key, label: title, usedPercent, remainingPercent: 100 - usedPercent,
      resetAt, stale: old || (resetAt !== null && Date.parse(resetAt) <= now) });
  };
  add('five-hour', '5시간', q.fiveHourPercent, q.fiveHourResetAt);
  add('short', typeof q.shortWindowSeconds === 'number' ? `${Math.round(q.shortWindowSeconds / 3600 * 10) / 10}시간` : '단기', q.shortPercent, q.shortResetAt);
  add('weekly', '주간', q.weeklyPercent, q.weeklyResetAt);
  add('monthly', '월간', q.monthlyPercent, q.monthlyResetAt);
  rows(q.customWindows).forEach((w, i) => add(`custom-${i}`, text(w.label) ?? '추가 한도', w.percent, w.resetAt));
  if (record(q.creditsUsd) && q.creditsUsd.unlimited !== true) add('credits', '크레딧', q.creditsUsd.percent, q.creditsUsd.expiresAt);
  return { id, label: name, plan: text(plan), active, status: state.reauth ? 'reauth' : state.paused ? 'paused' : !windows.length ? 'unavailable' : windows.some(w => w.stale) ? 'stale' : 'ok',
    updatedAt, windows, quotaMode: windows.length ? 'observed' : 'unavailable' };
}

/** Read-only projection. No source object or credential is returned across the API. */
export async function readSnapshot(home = join(homedir(), '.opencodex'), now = Date.now(), codexHome = join(homedir(), '.codex')) {
  const warnings = [];
  const config = await readObject(join(home, 'config.json'), warnings, '설정', true);
  if (!record(config.providers)) throw new Error('OpenCodex providers unavailable');
  const [auth, codex, providerQuota, credentials, native] = await Promise.all([
    readObject(join(home, 'auth.json'), warnings, '로그인'),
    readObject(join(home, 'codex-quota-cache.json'), warnings, 'OpenAI 사용량'),
    readObject(join(home, 'provider-account-quota-cache.json'), warnings, '프로바이더 사용량'),
    readObject(join(home, 'codex-accounts.json'), warnings, 'OpenAI 계정'),
    readObject(join(codexHome, 'auth.json'), warnings, 'Codex 기본 로그인'),
  ]);
  const cq = codex.version === 1 && record(codex.quotas) ? codex.quotas : {};
  const pq = providerQuota.version === 1 && record(providerQuota.rows) ? providerQuota.rows : {};
  if (codex.version !== 1 || providerQuota.version !== 1) warnings.push('사용량 저장 형식을 확인할 수 없습니다. 일부 값이 표시되지 않을 수 있습니다.');
  const providers = [];
  const bindings = new Map();
  // A credential is a secret wherever it appears, not only inside the provider that
  // declares it, so the exclusion set is one union over the configuration already read.
  const secrets = new Set();
  for (const p of Object.values(config.providers)) {
    if (!record(p)) continue;
    for (const key of [p.apiKey, ...rows(p.apiKeyPool).map(k => k.key)]) {
      if (typeof key === 'string' && key.length) secrets.add(key);
    }
  }
  // OCX disables models with a provider-qualified id, so the same bare name stays
  // available under another provider.
  const disabledModels = new Set(Array.isArray(config.disabledModels) ? config.disabledModels.map(disabledKey).filter(key => key !== null) : []);
  for (const [id, p] of Object.entries(config.providers)) {
    if (!record(p)) { warnings.push('일부 프로바이더 설정을 읽지 못했습니다.'); continue; }
    const accounts = [];
    if (id === 'openai') {
      addBinding(bindings,id,'__main__',credentialBinding(id,native.tokens));
      const nativeId = record(native.tokens) ? text(native.tokens.account_id) : null;
      if (nativeId) {
        const hash = createHash('sha256').update('opencodex-main-quota-v1\0').update(nativeId).digest('hex');
        const bound = record(codex.mainPolicyQuota) && codex.mainPolicyQuota.identityKey === hash ? codex.mainPolicyQuota.quota : null;
        if (!bound) warnings.push('Codex 기본 계정의 사용량을 현재 로그인과 연결할 수 없습니다.');
        accounts.push(projectQuotaAccount('__main__', 'Codex 기본 계정', null, config.activeCodexAccountId === '__main__', bound, now,
          { paused: config.pausedCodexAccountIds?.includes?.('__main__') === true }));
      }
      if (!nativeId) {
        warnings.push('Codex 기본 로그인 정보를 확인할 수 없습니다.');
        accounts.push(projectQuotaAccount('__main__', 'Codex 기본 계정', null, false, null, now));
      }
      for (const a of rows(config.codexAccounts)) {
        if (!text(a.id) || a.isMain === true || a.id === '__main__') continue;
        const stored = record(credentials[a.id]) ? credentials[a.id] : {};
        const credential = record(stored.credential) ? stored.credential : stored;
        addBinding(bindings,id,a.id,stored.deletedAt ? null : credentialBinding(id,credential));
        const present = typeof credential.accessToken === 'string' && credential.accessToken.length > 0 && !stored.deletedAt;
        accounts.push(projectQuotaAccount(a.id, label(a.alias ?? a.email, `OpenAI 계정 ${accounts.length + 1}`, secrets), a.plan, config.activeCodexAccountId === a.id,
          present ? cq[a.id] : null, now, { reauth: !present, paused: config.pausedCodexAccountIds?.includes?.(a.id) === true }));
      }
    } else {
      const set = record(auth[id]) ? auth[id] : {};
      for (const a of rows(set.accounts)) {
        if (!text(a.id)) continue;
        const cr = record(a.credential) ? a.credential : {};
        addBinding(bindings,id,a.id,credentialBinding(id,cr));
        accounts.push(projectQuotaAccount(a.id, label(a.alias ?? cr.email, `${NAMES[id] ?? id} 계정 ${accounts.length + 1}`, secrets), a.plan ?? cr.plan,
          set.activeAccountId === a.id, pq[`${id}\0${a.id}`], now, { reauth: a.needsReauth === true }));
      }
      const keys = rows(p.apiKeyPool);
      for (const k of keys) {
        if (!text(k.id) || typeof k.key !== 'string' || !k.key) continue;
        addBinding(bindings,id,`key:${k.id}`,credentialBinding(id,k.key,true));
        accounts.push(projectQuotaAccount(`key:${k.id}`, label(k.label ?? k.alias, `API 계정 ${accounts.length + 1}`, secrets), null, p.apiKey === k.key,
          null, now));
      }
      if (typeof p.apiKey === 'string' && p.apiKey && !keys.some(k => k.key === p.apiKey)) {
        addBinding(bindings,id,'key:default',credentialBinding(id,p.apiKey,true));
        accounts.push(projectQuotaAccount('key:default', 'API 기본 계정', null, true, null, now));
      }
    }
    // The default selector is published as a model name, so it passes the same shape
    // and secret checks as the list. Its nullable contract is unchanged.
    const defaultModel = modelList([p.defaultModel], secrets)[0] ?? null;
    // Every configured model is kept: a price list that silently truncates would hide
    // exactly the unpriced models this list exists to show.
    const supportedModels = [...new Set([...modelList(p.models, secrets), ...(defaultModel === null ? [] : [defaultModel])])]
      .filter(model => !disabledModels.has(`${id}/${model}`));
    providers.push({ id, name: NAMES[id] ?? id, enabled: p.disabled !== true, defaultModel, supportedModels, accounts });
  }
  return { schemaVersion: 1, observedAt: new Date(now).toISOString(), source: 'opencodex-local-snapshot', refreshIntervalSeconds: 10, warnings, providers, [MODEL_EXCLUSIONS]: secrets, [ACCOUNT_BINDINGS]:bindings };
}
