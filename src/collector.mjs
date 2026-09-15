import { readSnapshot, modelId, carriesSecret, MODEL_EXCLUSIONS, ACCOUNT_BINDINGS } from './snapshot.mjs';
import { readIdentities } from './identity.mjs';
import { openHistory } from './history.mjs';
import { enrichSnapshot } from './analytics.mjs';
import * as pricing from './pricing.mjs';
import { createProviderRefresh } from './provider-refresh.mjs';
import { createOllamaMonitor } from './ollama.mjs';
import { createPricingCatalog } from './pricing-catalog.mjs';
import { compareOllamaUsage } from './ollama-comparison.mjs';
import { join } from 'node:path';

// A strict ISO instant: Date.parse alone accepts RFC-2822 strings like
// "September 1, 2026 GMT+0000" and normalizes calendar overflows such as
// 2026-02-30, neither of which is a valid configured instant.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseIsoInstant(value) {
  if (typeof value !== 'string') return NaN;
  const m = ISO_INSTANT.exec(value);
  if (!m) return NaN;
  const [, Y, M, D, hh, mm, ss, zone] = m;
  const year = +Y, month = +M, day = +D, hour = +hh, minute = +mm, second = +(ss ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
  if (zone !== 'Z') { const z = /([+-])(\d{2}):(\d{2})/.exec(zone); if (+z[2] > 23 || +z[3] > 59) return NaN; }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return Date.parse(value);
}

// Three separate discovery sources, never merged into one claim of support:
// what OCX lists in its configuration, and what the usage log actually recorded.
// The models.dev cache supplies prices to these rows; it does not create them, so a
// catalog of several thousand foreign rows never lands in the response.
// Records are built field by field — no configuration or catalog object is spread.
function describeModelPrices(provider, store, lookupModelPrice, from, to, excluded = new Set()) {
  const entries = new Map();
  for (const model of Array.isArray(provider.supportedModels) ? provider.supportedModels : []) {
    entries.set(model, { model, sources: ['ocx-config'], requests: 0, unpricedRequests: 0 });
  }
  for (const row of store.observedModels(provider.id, from, to)) {
    // A recorded model name reaches the response through the same shape gate as a
    // configured one. The usage log is another product's file, so a name that is not a
    // model ID is not republished as one.
    if (modelId(row.model) === null || carriesSecret(row.model, excluded)) continue;
    const found = entries.get(row.model);
    entries.set(row.model, { model: row.model, sources: found ? [...found.sources, 'observed'] : ['observed'],
      requests: row.requests, unpricedRequests: row.unpricedRequests });
  }
  return [...entries.values()].map(entry => {
    // Priced as of this snapshot: peak schedules and published end dates both depend on
    // the instant asked about, so an absent timestamp would quote the wrong tariff.
    const price = lookupModelPrice(provider.id, entry.model, { timestamp: to });
    return { model: entry.model, sources: entry.sources, requests: entry.requests,
      unpricedRequests: entry.unpricedRequests,
      // The stored provider is the attribution key, not proof of the key that priced the
      // original call, and these are current prices rather than a historical tariff.
      providerBasis: 'attributed',
      status: price.status, unit: price.unit,
      rates: { input: price.rates.input, output: price.rates.output,
        cacheRead: price.rates.cacheRead, cacheWrite: price.rates.cacheWrite },
      sourceUrl: price.sourceUrl, checkedAt: price.checkedAt,
      effectiveFrom: price.effectiveFrom, effectiveTo: price.effectiveTo,
      conditions: [...price.conditions], unsupported: [...price.unsupported],
      conflict: price.conflict === null ? null : { status: price.conflict.status,
        rates: { ...price.conflict.rates }, reason: price.conflict.reason },
      reason: price.reason };
  }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
}

export async function createCollector({ home, codexHome, claudeHome, claudeProfile, dataDir, storage, catalogPath, managementOrigin = null, intervalMs = 10000, now = Date.now, claudeCacheTtl = '5m', claudeCacheFrom = null, subscriptions = null }) {
  // The cache-write TTL is a user assumption, so it is validated before any state
  // is opened: a bad setting must fail here, not after a database exists.
  if (claudeCacheTtl !== '5m' && claudeCacheTtl !== '1h') throw new Error('claudeCacheTtl must be 5m or 1h');
  let claudeCache = null;
  if (claudeCacheTtl === '1h') {
    const from = parseIsoInstant(claudeCacheFrom);
    if (!Number.isFinite(from)) throw new Error('claudeCacheFrom must be a valid ISO timestamp with a timezone when claudeCacheTtl is 1h');
    claudeCache = { ttl: '1h', from, basis: 'user-assumption' };
  }
  const catalog = await createPricingCatalog({file:catalogPath,now});
  const store = await openHistory(dataDir, storage);
  store.set('claudeCacheAssumption', claudeCache);
  const ollama = createOllamaMonitor({ home, store, now });
  const providers = createProviderRefresh({ home, codexHome, store, now, origin: managementOrigin });
  const observed = snapshot => providers.enrich(ollama.enrich(snapshot));
  let flight, timer, stopped = false, failure = null, identities = { labels: new Map(), plans: new Map() };
  let nextCacheReadAt = 0;
  async function collect() {
    if (stopped) return;
    if (flight) return flight;
    flight = (async () => {
      try {
        store.maintain(now());
        identities = await readIdentities(home, { codexHome, claudeHome, claudeProfile });
        await Promise.all([ollama.collect(), providers.collect(), catalog.refresh()]);
        store.capture(observed(await readSnapshot(home, now(), codexHome)), now());
        const usageFile = join(home, 'usage.jsonl');
        let reference = null;
        if (now() >= nextCacheReadAt) {
          const to = now(), comparison = await compareOllamaUsage(usageFile,{from:to-30*86400000,to});
          reference = {...comparison.cache,from:comparison.from,through:comparison.through,updatedAt:to,invalidLines:comparison.invalidLines};
        }
        await store.ingest(usageFile, identities, catalog.priceUsage, now());
        if (reference) {store.set('cursorCacheReference',reference);nextCacheReadAt=now()+5*60000;}
        failure = null;
      } catch { failure = 'collection-failed'; console.error('quota-monitor: analytics collection failed'); }
    })().finally(() => { flight = null; });
    return flight;
  }
  return {
    async start() { await collect(); timer = setInterval(() => void collect(), intervalMs); timer.unref(); },
    collect,
    async snapshot() {
      // One instant for the whole snapshot: observation time, analytics and quoted
      // prices must not straddle a clock tick and disagree with each other.
      const at = now();
      const snapshot = await readSnapshot(home, at, codexHome);
      const enriched = enrichSnapshot(observed(snapshot), store, identities, { ...pricing, subscriptionFor: (p,a) => subscriptions?.forAccount(p,a,snapshot[ACCOUNT_BINDINGS]?.get(p+"\0"+a)) ?? ({label:null,monthlyUsd:null,basis:"unselected"}) }, at, failure);
      enriched.analytics.pricingCatalog = catalog.diagnostics();
      enriched.analytics.sampleIntervalSeconds = intervalMs / 1000;
      // The full retained history, not the thirty-day analytics horizon: a model that
      // stopped being called still has a price worth showing.
      const observedSince = store.bounds().since ?? 0;
      // One union for every provider: a key is a secret wherever it appears.
      const excluded = enriched[MODEL_EXCLUSIONS];
      // The 1-hour cache-write assumption applies only from its configured instant:
      // quotes before it keep the 5-minute rate.
      const cacheActive = claudeCache !== null && at >= claudeCache.from;
      const quoteLookup = (p, m, o) => catalog.lookupModelPrice(p, m,
        { ...o, ...(p === 'anthropic' && cacheActive ? { claudeCacheTtl: '1h' } : {}) });
      for (const provider of enriched.providers) {
        provider.analytics.modelPrices = describeModelPrices(provider, store, quoteLookup,
          observedSince - 1, at, excluded);
      }
      const anthropic = enriched.providers.find(p => p.id === 'anthropic');
      if (anthropic) anthropic.analytics.cacheWriteAssumption = cacheActive
        ? { ttl: '1h', from: new Date(claudeCache.from).toISOString(), basis: 'user-assumption' } : null;
      enriched.analytics.modelPriceConditions = pricing.PRICE_CONDITIONS;
      const reference = store.get('cursorCacheReference');
      const cursor = enriched.providers.find(p=>p.id==='cursor');
      if (cursor) cursor.analytics.cacheAssumption = reference ? {...reference,stale:Boolean(failure)||at-reference.updatedAt>15*60000} : {appliedRate:null,stale:false};
      return enriched;
    },
    async close() { stopped = true; clearInterval(timer); await flight; store.close(); },
  };
}
