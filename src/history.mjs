import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { attributeUsage } from './identity.mjs';
const BATCH_BYTES = 1024 * 1024;
const DAY = 86400000;
// While a quota reading is unchanged, keep one sample every four minutes instead of
// every collection. That stays well inside the twenty-minute gap threshold, so idle
// time still reads as observed rather than as a collection gap, while a month of
// history stops costing a quarter million rows per window.
const IDLE_SAMPLE_MS = 4 * 60000;
const num = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const totalTokens = (usage, row) => num(usage.totalTokens ?? row.totalTokens ?? (num(usage.inputTokens) + num(usage.outputTokens)));
const cachedTokens = usage => num(usage.cacheReadInputTokens ?? usage.cachedInputTokens);
const modelName = row => typeof row.model === 'string' ? row.model.slice(0, 200) : null;

export async function openHistory(directory, { retentionDays = 90, maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 31 || retentionDays > 3650 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024) throw new Error('Invalid history storage limits');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'history.sqlite');
  const db = new DatabaseSync(file); await chmod(file, 0o600);
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const maxPages = Math.floor(maxBytes / pageSize);
  if (db.prepare('PRAGMA page_count').get().page_count > maxPages) {
    db.close(); throw new Error('Existing history exceeds the configured limit; preserve or archive it before lowering the limit');
  }
  db.exec(`PRAGMA max_page_count=${maxPages}; PRAGMA journal_size_limit=16777216; PRAGMA wal_autocheckpoint=1000;`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL,
      account TEXT, model TEXT, input REAL, output REAL, cached REAL, tokens REAL, usd REAL, basis TEXT);
    CREATE INDEX IF NOT EXISTS usage_time ON usage(at,provider,account);
    CREATE TABLE IF NOT EXISTS samples (provider TEXT, account TEXT, window TEXT, at INTEGER,
      reset INTEGER, used REAL, PRIMARY KEY(provider,account,window,at));
    CREATE INDEX IF NOT EXISTS samples_time ON samples(at);
    CREATE TABLE IF NOT EXISTS usage_timings (id TEXT PRIMARY KEY, durationMs REAL, firstOutputMs REAL, tokensReported INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cursor_cache_costs (id TEXT PRIMARY KEY, noCacheUsd REAL NOT NULL, fullCacheUsd REAL NOT NULL, eligibleInputTokens REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS claude_cache_costs (id TEXT PRIMARY KEY, fiveMinuteUsd REAL NOT NULL, oneHourUsd REAL NOT NULL, cacheWriteTokens REAL NOT NULL);
    CREATE TEMP VIEW usage_valued AS
      WITH assumption AS (SELECT CASE WHEN json_type(value,'$.appliedRate') IN ('real','integer')
        AND json_extract(value,'$.appliedRate') BETWEEN 0 AND 1 THEN json_extract(value,'$.appliedRate') END rate
        FROM meta WHERE key='cursorCacheReference'),
      claude AS (SELECT CASE WHEN json_extract(value,'$.ttl')='1h'
        AND json_type(value,'$.from') IN ('real','integer') THEN json_extract(value,'$.from') END fromTs
        FROM meta WHERE key='claudeCacheAssumption')
      SELECT u.id,u.at,u.provider,u.account,u.model,u.input,u.output,u.cached,u.tokens,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.noCacheUsd*(1-a.rate)+c.fullCacheUsd*a.rate
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN cc.oneHourUsd
             ELSE u.usd END usd,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN 'local-catalog'
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN 'local-catalog'
             ELSE u.basis END basis,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN 1 ELSE 0 END cacheEstimated,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.eligibleInputTokens*a.rate ELSE 0 END estimatedCachedTokens,
        CASE WHEN c.id IS NOT NULL AND a.rate IS NOT NULL THEN c.noCacheUsd
             WHEN cc.id IS NOT NULL AND cl.fromTs IS NOT NULL AND u.at>=cl.fromTs THEN cc.oneHourUsd
             ELSE u.usd END noCacheUsd
      FROM usage u LEFT JOIN cursor_cache_costs c ON c.id=u.id AND u.provider='cursor'
      LEFT JOIN claude_cache_costs cc ON cc.id=u.id AND u.provider='anthropic'
      LEFT JOIN assumption a ON 1=1 LEFT JOIN claude cl ON 1=1;`);
  const get = key => { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  // Every write path commits or leaves the database untouched; a partial batch
  // would desynchronize the import cursor from the rows it claims to cover.
  const transact = run => {
    db.exec('BEGIN');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const insert = db.prepare(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET usd=excluded.usd,basis=excluded.basis
    WHERE usage.usd IS NULL AND excluded.usd IS NOT NULL
    AND usage.provider=excluded.provider AND usage.model IS excluded.model AND usage.at=excluded.at
    AND usage.input=excluded.input AND usage.output=excluded.output AND usage.cached=excluded.cached AND usage.tokens=excluded.tokens`);
  const timing = db.prepare('INSERT OR IGNORE INTO usage_timings VALUES (?,?,?,?)');
  const cacheCost = db.prepare(`INSERT OR IGNORE INTO cursor_cache_costs
    SELECT id,?,?,? FROM usage WHERE id=? AND provider='cursor' AND model IS ? AND at=?
      AND input=? AND output=? AND cached=? AND tokens=?`);
  // The sidecar only attaches to the stored row it was priced from: same identity,
  // shape and the original 5m amount (a tiny float tolerance covers repricing noise).
  const claudeCacheCost = db.prepare(`INSERT OR IGNORE INTO claude_cache_costs
    SELECT id,?,?,? FROM usage WHERE id=? AND provider='anthropic' AND model IS ? AND at=?
      AND input=? AND output=? AND cached=? AND tokens=?
      AND usd IS NOT NULL AND abs(usd-?)<=1e-9*max(abs(usd),abs(?),1)`);
  const sample = db.prepare('INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?)');
  const lastSample = db.prepare('SELECT at,reset,used FROM samples WHERE provider=? AND account=? AND window=? ORDER BY at DESC LIMIT 1');

  // The oldest instant we still hold complete records for. Retention deletes below it
  // and ingestion refuses to import below it, so it only ever moves forward. It marks
  // a conservative completeness boundary, not evidence that rows were deleted.
  const excludeBefore = cutoff => {
    const prior = get('usageExcludedBefore');
    if (!Number.isFinite(prior) || cutoff > prior) set('usageExcludedBefore', cutoff);
  };

  // Start a fresh observation run. The endpoint and any unresolved record belong to the
  // run that saw them, so both are dropped with it rather than inherited.
  const restartObservation = at => {
    set('usageObservedSince', at);
    set('usageObservedThrough', null);
    set('usageTailPending', null);
  };

  // account: undefined reads every account, null only unattributed rows, a string one
  // account. { listed: ids } counts only those accounts and { unlisted: ids } every
  // attributed account outside them, so a provider total splits into three parts that
  // are queried separately rather than derived from one another. An empty listed set
  // matches nothing; an empty unlisted set matches every attributed row.
  const accountFilter = (provider, from, to, account) => {
    const listed = account?.listed, unlisted = account?.unlisted;
    const ids = listed ?? unlisted;
    if (Array.isArray(ids)) {
      const places = ids.map(() => '?').join(',');
      return { args: [provider, from, to, ...ids], clause: listed
        ? (ids.length ? ' AND account IN (' + places + ')' : ' AND 0')
        : ' AND account IS NOT NULL' + (ids.length ? ' AND account NOT IN (' + places + ')' : '') };
    }
    return {
      clause: account === undefined ? '' : account === null ? ' AND account IS NULL' : ' AND account=?',
      args: typeof account === 'string' ? [provider, from, to, account] : [provider, from, to],
    };
  };

  const readFingerprint = async (handle, size) => {
    const prefix = Buffer.alloc(Math.min(64, size));
    await handle.read(prefix, 0, prefix.length, 0);
    return prefix.length === 64 ? createHash('sha256').update(prefix).digest('hex') : null;
  };

  // An append-only log never rewrites bytes it has already written. Hashing a byte
  // range lets a later read prove that what we consumed, and any record we left
  // unresolved, is still the same text. This detects a rewrite; it does not prove
  // the file was never altered between two reads.
  const digestRange = async (handle, from, length) => {
    if (!(length > 0) || from < 0) return null;
    // Hash in fixed-size chunks. An unfinished record can be megabytes long, and one
    // buffer the size of the range would make every poll allocate alongside it.
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(BATCH_BYTES, length));
    for (let read = 0; read < length;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - read), from + read);
      // Nothing more to read before the range ends: these bytes are not all there.
      if (!bytesRead) return null;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    return hash.digest('hex');
  };
  const boundaryOf = (handle, offset) => digestRange(handle, Math.max(0, offset - 64), Math.min(64, offset));

  // A birth timestamp separates a recreated file that reused an inode from the
  // original. Some platforms fill it from the change time instead, where every
  // append would move it, so an absent or ctime-shaped value counts as unknown.
  const birthOf = info => Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 &&
    info.birthtimeMs !== info.ctimeMs ? info.birthtimeMs : null;

  // A tariff or catalog change re-reads the log to fill only previously unpriced
  // amounts. Known values stay, and lines counted as invalid are not recounted.
  function planIngest(info, fingerprint, revision) {
    const previous = get('usageCursor');
    const pending = get('pricingReplay');
    const sameFile = value => value?.ino === String(info.ino) && (!value.fingerprint || value.fingerprint === fingerprint);
    const replay = get('pricingRevision') !== revision || !get('ollamaPricingReplayV1') ||
      !get('codexAliasPricingReplayV1') || !get('cursorGrokPricingReplayV1');
    let cursor = previous;
    let replayThrough = 0;
    if (replay) {
      replayThrough = sameFile(previous) && previous.offset <= info.size ? previous.offset : 0;
      if (sameFile(pending) && pending.through <= info.size) replayThrough = Math.max(replayThrough, pending.through);
      if (!(sameFile(pending) && pending.revision === revision)) {
        cursor = { ino: String(info.ino), offset: 0, fingerprint };
        transact(() => {
          set('usageCursor', cursor);
          set('pricingReplay', { ...cursor, revision, through: replayThrough });
        });
      }
    }
    if (!cursor || cursor.ino !== String(info.ino) || cursor.offset > info.size ||
        (cursor.fingerprint && fingerprint && cursor.fingerprint !== fingerprint)) cursor = { ino: String(info.ino), offset: 0 };
    cursor.fingerprint = fingerprint;
    return { cursor, replayThrough };
  }

  // Skip one record longer than a whole batch, preserving the first complete record after it.
  async function skipOversizedRecord(handle, from, end) {
    let offset = from;
    while (offset < end) {
      const chunk = Buffer.alloc(Math.min(BATCH_BYTES, end - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      const newline = chunk.indexOf(10);
      if (newline >= 0) return offset + newline + 1;
      offset += bytesRead;
    }
    return null;
  }

  // One physical attempt: the usage row, its cache valuation inputs and ollama timings.
  function recordAttempt(entry, row, index, identities, priceUsage) {
    const { provider, account } = attributeUsage(row, identities);
    const usage = row.usage ?? {};
    const cost = priceUsage({ ...row, timestamp: entry.timestamp });
    const id = createHash('sha256').update(entry.requestId + '\0' + index).digest('hex');
    const model = modelName(row);
    const tokens = totalTokens(usage, row);
    insert.run(id, entry.timestamp, provider, account, model, num(usage.inputTokens), num(usage.outputTokens),
      cachedTokens(usage), tokens, Number.isFinite(cost.usd) && cost.usd >= 0 ? cost.usd : null, cost.basis ?? 'unknown');
    const cache = cost.cursorCache;
    if (provider === 'cursor' && cache && [cache.noCacheUsd, cache.fullCacheUsd, cache.eligibleInputTokens]
        .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      cacheCost.run(cache.noCacheUsd, cache.fullCacheUsd, cache.eligibleInputTokens, id, model, entry.timestamp,
        num(usage.inputTokens), num(usage.outputTokens), cachedTokens(usage), tokens);
    }
    // A coefficient set only makes sense as a real cache-write price: positive 5m
    // amount (it must equal the stored USD), a 1h amount at least as high, and a
    // positive token count it applies to. Anything else is a malformed quote.
    const claude = cost.claudeCache;
    if (provider === 'anthropic' && claude &&
        [claude.fiveMinuteUsd, claude.oneHourUsd, claude.cacheWriteTokens]
          .every(n => typeof n === 'number' && Number.isFinite(n)) &&
        claude.fiveMinuteUsd > 0 && claude.oneHourUsd >= claude.fiveMinuteUsd && claude.cacheWriteTokens > 0) {
      claudeCacheCost.run(claude.fiveMinuteUsd, claude.oneHourUsd, claude.cacheWriteTokens, id, model, entry.timestamp,
        num(usage.inputTokens), num(usage.outputTokens), cachedTokens(usage), tokens,
        claude.fiveMinuteUsd, claude.fiveMinuteUsd);
    }
    if (provider === 'ollama-cloud') {
      timing.run(id, Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
        Number.isFinite(row.firstOutputMs) && row.firstOutputMs >= 0 ? row.firstOutputMs : null,
        row.usageStatus === 'reported' && [usage.inputTokens, usage.outputTokens]
          .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ? 1 : 0);
    }
  }

  // Returns the running invalid-line count; callers commit it with the cursor.
  function ingestLines(batch, startOffset, { replayThrough, resetAt, identities, priceUsage, now, invalid }) {
    let offset = startOffset;
    let counted = invalid;
    for (const line of batch.split('\n')) {
      const alreadyCounted = offset < replayThrough;
      offset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { if (!alreadyCounted) counted++; continue; }
      if (!entry || !Number.isFinite(entry.timestamp) || entry.timestamp <= 0 ||
          entry.timestamp > now + 60000 || typeof entry.requestId !== 'string') { if (!alreadyCounted) counted++; continue; }
      if (entry.timestamp < now - retentionDays * DAY) continue;
      if (resetAt != null && entry.timestamp < resetAt) continue;
      const attempts = Array.isArray(entry.attempts) && entry.attempts.length ? entry.attempts : [entry];
      for (const [index, row] of attempts.entries()) {
        if (!row || row.locallyAnswered === true) continue;
        recordAttempt(entry, row, index, identities, priceUsage);
      }
    }
    return counted;
  }

  return {
    db, get, set, transact, close: () => db.close(),
    maintain(now) {
      if (now - (get('lastMaintenanceAt') ?? 0) < DAY) return;
      const cutoff = now - retentionDays * DAY;
      transact(() => {
        db.prepare('DELETE FROM usage_timings WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM cursor_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM claude_cache_costs WHERE id IN (SELECT id FROM usage WHERE at<?)').run(cutoff);
        db.prepare('DELETE FROM usage WHERE at<?').run(cutoff);
        db.prepare('DELETE FROM samples WHERE at<?').run(cutoff);
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ollama_observations'").get()) {
          db.prepare('DELETE FROM ollama_observations WHERE at<?').run(cutoff);
        }
        excludeBefore(cutoff);
        set('lastMaintenanceAt', now);
      });
      // Free pages are reused. Avoid VACUUM's extra disk and exclusive rewrite.
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    },
    capture(snapshot, now) {
      transact(() => {
        const resetAt = get('historyResetAt');
        for (const p of snapshot.providers) for (const a of p.accounts) for (const w of a.windows) {
          const at = Date.parse(a.updatedAt);
          if (w.stale || !Number.isFinite(at) || at > now || at < now - retentionDays * DAY || (resetAt != null && at < resetAt) || !Number.isFinite(w.usedPercent)) continue;
          const reset = w.resetAt ? Date.parse(w.resetAt) : null;
          const previous = lastSample.get(p.id, a.id, w.id);
          // Rolling windows nudge their reset timestamp on every refresh. Treat a drift
          // the analytics already tolerates as the same cycle, or nothing ever dedupes.
          const sameCycle = previous && (previous.reset === reset ||
            (Number.isFinite(previous.reset) && Number.isFinite(reset) && Math.abs(previous.reset - reset) <= 60000));
          if (sameCycle && previous.used === w.usedPercent &&
              at > previous.at && at - previous.at < IDLE_SAMPLE_MS) continue;
          sample.run(p.id, a.id, w.id, at, reset, w.usedPercent);
        }
        if (!get('historyStartedAt')) set('historyStartedAt', now);
        set('lastCollectedAt', now);
      });
    },
    async ingest(file, identities, priceUsage, now) {
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        const resetAt = get('historyResetAt');
        const revision = priceUsage.revision ?? 'legacy-pricing';
        const fingerprint = await readFingerprint(handle, info.size);
        // Decide continuity from what we last consumed, before planIngest can rewrite
        // the cursor for a pricing replay. A replay re-reads the same file and keeps
        // its rows, so it is not a break; a different or rewritten file is.
        const previous = get('usageCursor');
        const pending = get('usageTailPending');
        const birth = birthOf(info);
        const sameLog = previous?.ino === String(info.ino) && previous.offset <= info.size &&
          (!previous.fingerprint || !fingerprint || previous.fingerprint === fingerprint) &&
          (!previous.birthtimeMs || !birth || previous.birthtimeMs === birth);
        const consumedIntact = sameLog && (!previous.boundaryDigest ||
          await boundaryOf(handle, previous.offset) === previous.boundaryDigest);
        // A record we already saw but could not finish reading must still be there.
        // Cursor movement alone would let an unrelated byte stand in for it.
        // A stored null means we never managed to read that record. Comparing it with
        // another failed read would let a shrinking file pass as an unbroken run.
        const pendingIntact = !pending || (pending.digest !== null &&
          await digestRange(handle, pending.from, pending.length) === pending.digest);
        if (!sameLog || !consumedIntact || !pendingIntact || !Number.isFinite(get('usageObservedSince'))) {
          transact(() => restartObservation(now));
        }
        const { cursor, replayThrough } = planIngest(info, fingerprint, revision);
        const end = info.size;
        let invalid = get('invalidUsageLines') ?? 0;
        while (cursor.offset < end) {
          const buffer = Buffer.alloc(Math.min(BATCH_BYTES, end - cursor.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
          const last = buffer.lastIndexOf(10, bytesRead - 1);
          if (last < 0) {
            if (bytesRead < BATCH_BYTES) break; // a concurrently written final line stays pending
            const resume = await skipOversizedRecord(handle, cursor.offset + bytesRead, end);
            if (resume === null) break;
            if (cursor.offset >= replayThrough) invalid++;
            cursor.offset = resume;
            // A record we could not decode is history we cannot account for.
            transact(() => { set('usageCursor', cursor); set('invalidUsageLines', invalid); restartObservation(now); });
            continue;
          }
          invalid = transact(() => {
            const counted = ingestLines(buffer.subarray(0, last).toString('utf8'), cursor.offset,
              { replayThrough, resetAt, identities, priceUsage, now, invalid });
            cursor.offset += last + 1;
            set('usageCursor', cursor);
            set('invalidUsageLines', counted);
            if (counted > invalid) restartObservation(now);
            return counted;
          });
          await new Promise(resolve => setImmediate(resolve));
        }
        const boundaryDigest = await boundaryOf(handle, cursor.offset);
        const tail = cursor.offset < end
          ? { from: cursor.offset, length: end - cursor.offset, digest: await digestRange(handle, cursor.offset, end - cursor.offset) }
          : null;
        transact(() => {
          set('usageCursor', { ...cursor, birthtimeMs: birth, boundaryDigest });
          set('usageTailPending', tail);
          // Only a read that reached the end of the file extends the observed interval.
          if (!tail) set('usageObservedThrough', now);
          excludeBefore(now - retentionDays * DAY);
          set('usageReadAt', now);
          set('ollamaPricingReplayV1', true);
          set('codexAliasPricingReplayV1', true);
          set('cursorGrokPricingReplayV1', true);
          set('pricingRevision', revision);
          set('pricingReplay', null);
        });
      } finally { await handle.close(); }
    },
    // The scope narrows which usage rows count. It never narrows the interval.
    stats(provider, account, from, to, scope = null) {
      let { clause: filter, args } = accountFilter(provider, from, to, account);
      const models = scope?.models;
      if (models?.length) {
        const globs = models.map(() => 'lower(model) GLOB ?').join(' OR ');
        // A row with no recorded model cannot be placed in or out of the set, so it
        // stays in and keeps marking uncertainty instead of silently vanishing.
        filter += scope.exclude ? ` AND (model IS NULL OR NOT (${globs}))` : ` AND (model IS NULL OR ${globs})`;
        args.push(...models.map(pattern => pattern.toLowerCase()));
      }
      const r = db.prepare(`SELECT count(*) requests, sum(tokens) tokens, sum(input) inputTokens,
        sum(output) outputTokens, sum(cached) cachedTokens, count(usd) pricedRequests, sum(usd) apiUsd,
        sum(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) unknownPriceRequests,
        sum(CASE WHEN basis='local-catalog' THEN 1 ELSE 0 END) localPriceRequests,
        sum(cacheEstimated) cacheEstimatedRequests,sum(estimatedCachedTokens) estimatedCachedTokens,sum(noCacheUsd) noCacheApiUsd
        FROM usage_valued WHERE provider=? AND at>? AND at<=?${filter}`).get(...args);
      for (const key of Object.keys(r)) if (!['apiUsd','noCacheApiUsd'].includes(key)) r[key] ??= 0;
      return { ...r };
    },
    points(provider, account, window, from) {
      return db.prepare('SELECT at,reset,used FROM samples WHERE provider=? AND account=? AND window=? AND at>=? ORDER BY at').all(provider, account, window, from);
    },
    unpricedModels(provider, from, to) {
      return db.prepare(`SELECT model,count(*) requests FROM usage WHERE provider=? AND at>? AND at<=? AND usd IS NULL
        GROUP BY model ORDER BY requests DESC,model LIMIT 20`).all(provider,from,to).map(row=>({...row}));
    },
    // Every distinct model actually recorded for this provider, priced or not. Unlike
    // unpricedModels this is not capped: a model must not vanish from the price list
    // because twenty others were noisier.
    observedModels(provider, from, to) {
      return db.prepare(`SELECT model,count(*) requests,sum(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) unpricedRequests
        FROM usage WHERE provider=? AND at>? AND at<=? AND model IS NOT NULL
        GROUP BY model ORDER BY requests DESC,model`).all(provider,from,to).map(row=>({...row}));
    },
    bounds(provider, account) {
      if (!provider) return db.prepare('SELECT min(at) since, max(at) through FROM usage').get();
      if (typeof account === 'string') return db.prepare('SELECT min(at) since, max(at) through FROM usage WHERE provider=? AND account=?').get(provider,account);
      return db.prepare('SELECT min(at) since, max(at) through FROM usage WHERE provider=?').get(provider);
    },
    pricedBounds(provider, from, to, account) {
      const { clause: filter, args } = accountFilter(provider, from, to, account);
      return db.prepare(`SELECT min(at) since,max(at) through FROM usage_valued WHERE provider=? AND at>? AND at<=? AND usd>0${filter}`).get(...args);
    },
    peakFiveHour(provider, from, to) {
      const rows = db.prepare('SELECT at,usd FROM usage_valued WHERE provider=? AND at>? AND at<=? ORDER BY at').all(provider,from,to);
      let first=0, sum=0, peak=0;
      for (let last=0;last<rows.length;last++) {
        sum += rows[last].usd ?? 0;
        while (rows[last].at-rows[first].at >= 5*3600000) { sum -= rows[first].usd ?? 0; first++; }
        peak = Math.max(peak,sum);
      }
      return peak;
    },
  };
}
