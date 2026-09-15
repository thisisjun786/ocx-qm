import { recommendSubscriptions } from './recommendation.mjs';
import { HOUR, STALE_MS, iso } from './time.mjs';
import { resolveScope, scopePublishes } from './window-scope.mjs';
import { modelId, carriesSecret, MODEL_EXCLUSIONS } from './snapshot.mjs';
const WEEK = 168 * HOUR, MONTH = 30 * 24 * HOUR;
const MIN_INTERVAL = 5 * 60000;
const MAX_GAP = 20 * 60000;
const MIN_FORECAST_INTERVAL = 15 * 60000;
const MIN_FORECAST_DELTA = 2;

const WINDOW_HOURS = { 'five-hour': 5, weekly: 168, monthly: 720 };
const windowHours = window => {
  if (WINDOW_HOURS[window.id]) return WINDOW_HOURS[window.id];
  const labelled = window.id === 'short' ? /^([\d.]+)시간$/.exec(String(window.label).trim()) : null;
  return labelled ? Number(labelled[1]) : null;
};

// The five trailing usage periods, shortest first. These are aggregation spans,
// not provider limits: WINDOW_HOURS above is how long a quota cycle runs before
// the provider resets it. Keeping the two tables apart is what stops a one-hour
// aggregation from being read as a one-hour limit.
export const USAGE_PERIODS = [['oneHour', HOUR], ['fiveHour', 5 * HOUR],
  ['twentyFourHour', 24 * HOUR], ['weekly', WEEK], ['monthly', MONTH]];

// A shorter window sits inside a longer one, so its 100% allowance cannot be worth
// more dollars: spending that much inside the short window would have driven the
// long one past 100% first. Each window is calibrated from its own runs and never
// sees that constraint, so a noisy short window can outrank the limit containing
// it. Project the impossible value back onto the bound instead of publishing it.
function constrainNestedWindows(windows) {
  // An absent scope means the all-model default; only a narrower scope such as the
  // Fable window counts a different usage set and must not be compared with these.
  const ranked = windows.map(w => ({ window: w, hours: windowHours(w), scope: w.usageScope ?? 'all' }))
    .filter(entry => entry.hours !== null && Number.isFinite(entry.window.analytics.capacityApiUsd));
  for (const entry of ranked) {
    const longer = ranked.filter(other => other.scope === entry.scope && other.hours > entry.hours);
    if (!longer.length) continue;
    const bound = longer.reduce((lowest, other) =>
      other.window.analytics.capacityApiUsd < lowest.window.analytics.capacityApiUsd ? other : lowest);
    const analytics = entry.window.analytics;
    const limit = bound.window.analytics.capacityApiUsd;
    if (analytics.capacityApiUsd <= limit) continue;
    analytics.capacityApiUsd = limit;
    analytics.remainingApiUsd = limit * entry.window.remainingPercent / 100;
    analytics.confidence = 'low';
    analytics.capacityReason = `${analytics.capacityReason ?? ''} 이 한도의 자체 관측값은 이를 포함하는 ${bound.window.label} 한도보다 커서 성립할 수 없습니다. ${bound.window.label} 한도 값으로 낮춰 표시합니다.`.trim();
  }
}

const NO_RATES = { hours: 0, delta: 0, recentHours: 0, recentDelta: 0 };
const NO_CAPACITY = { matchedUsd: 0, matchedDelta: 0, matchedRequests: 0, localPrices: 0,
  incomplete: false, observedDelta: 0, unexplainedDelta: 0, latestMatchedAt: null, historical: false };

// Provider-side corrections can nudge usedPercent down by about a point inside
// one quota cycle. We treat a drop within tolerance as reporting noise and hold
// each sample at the segment's running high, so one blip must not split a
// contiguous run or inflate the measured burn — a real 1pp refund cannot be
// distinguished and is absorbed the same way. A larger drop, a reset change, a
// gap, or time going backwards starts a fresh segment anchored at that point's
// own reset — anchors are never chained from a drifting timestamp.
const DIP_TOLERANCE_PP = 1;
function normalizeQuotaPoints(points) {
  const normalized = [];
  let adjustedSamples = 0;
  let anchor = null, high = -Infinity, previousAt = null;
  let segmentId = -1;
  for (const point of points) {
    const gap = previousAt === null ? null : point.at - previousAt;
    const drop = high - point.used;
    if (!anchor || !Number.isFinite(point.reset) || !Number.isFinite(anchor.reset) ||
        Math.abs(point.reset - anchor.reset) > 60000 ||
        (gap !== null && (gap <= 0 || gap > MAX_GAP)) || drop > DIP_TOLERANCE_PP) {
      anchor = point;
      high = point.used;
      segmentId++;
    } else if (point.used > high) {
      high = point.used;
    } else if (drop > 0) {
      adjustedSamples++;
    }
    // Segment identity is explicit: every downstream consumer (contiguous run,
    // forecast cycle, capacity run) requires a matching segmentId, so a drifted
    // timestamp that happens to sit near the window reset cannot re-bridge a
    // boundary the segmenter already drew. The anchor's reset rides along for
    // the freshness and historical checks that compare against the window.
    normalized.push({ ...point, used: high, reset: anchor.reset, segmentId });
    previousAt = point.at;
  }
  return { points: normalized, adjustedSamples };
}

// Cap the transported history at roughly 180 points, always keeping the newest.
const sampleHistory = points => points
  .filter((unused, index) => index % Math.max(1, Math.ceil(points.length / 180)) === 0 || index === points.length - 1)
  .map(p => ({ at: iso(p.at), usedPercent: p.used, resetAt: iso(p.reset) }));

const emptyResult = history => ({ status: 'collecting', recentRatePpHour: null, averageRatePpHour: null, exhaustsAt: null,
  forecastRatePpHour: null, forecastObservedAt: null, forecastObservedHours: 0, forecastSpanHours: 0, forecastCoverage: null,
  resetBeforeExhaustion: null, projectedUsedAtReset: null, capacityApiUsd: null, remainingApiUsd: null,
  matchedApiUsd: null, matchedDeltaPp: 0, observedHours: 0, confidence: null, capacityBasis: null,
  capacityObservedAt: null, capacityObservedDeltaPp: 0, capacityMatchedQuotaCoverage: null,
  unexplainedDeltaPp: 0,
  quotaAdjustment: { tolerancePp: DIP_TOLERANCE_PP, adjustedSamples: 0 },
  capacitySourceLabel: null, capacityReason: null, reason: '새 측정값이 5분 이상 쌓이면 계산합니다.', history });

// Provider countdowns can round reset timestamps by a few seconds. Anchor to the
// current reset; chaining drifting timestamps would merge separate quota cycles.
// Only the latest uninterrupted run is evidence of current consumption, and
// filtering first would bridge intervening resets and reuse pre-gap activity.
function latestContiguousRun(points, reset) {
  const run = [];
  for (const point of points) {
    const previous = run.at(-1);
    if (!Number.isFinite(point.reset) || Math.abs(point.reset - reset) > 60000) { run.length = 0; continue; }
    if (previous && (point.segmentId !== previous.segmentId || point.at - previous.at <= 0 ||
        point.at - previous.at > MAX_GAP || point.used < previous.used)) run.length = 0;
    run.push(point);
  }
  return run;
}

// Long-term burn rate across cycles. Flat observations are real idle time;
// unobserved gaps and reset crossings contribute neither consumption nor time,
// and prior valid cycles remain usable.
function longTermForecast(points, measuredAt) {
  let hours = 0;
  let delta = 0;
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1], after = points[i];
    const gap = after.at - before.at, consumed = after.used - before.used;
    if (before.segmentId !== after.segmentId || gap > MAX_GAP || consumed < 0) continue;
    const elapsed = after.at - Math.max(before.at, measuredAt - WEEK);
    if (gap <= 0 || elapsed <= 0) continue;
    hours += elapsed / HOUR;
    delta += consumed * elapsed / gap;
  }
  const spanHours = points.length ? Math.max(0, measuredAt - Math.max(points[0].at, measuredAt - WEEK)) / HOUR : 0;
  return { hours, delta, spanHours, coverage: spanHours > 0 ? Math.min(1, hours / spanHours) : null };
}

// Current-cycle rates. Gaps and negative adjustments are not consumption, so only
// adjacent observations count.
function observedRates(run, recentStart) {
  let hours = 0, delta = 0, recentHours = 0, recentDelta = 0;
  for (let i = 1; i < run.length; i++) {
    const before = run[i - 1], after = run[i];
    const gap = after.at - before.at, consumed = after.used - before.used;
    if (gap <= 0 || gap > MAX_GAP || consumed < 0) continue;
    hours += gap / HOUR;
    delta += consumed;
    const start = Math.max(before.at, recentStart);
    if (after.at > start) {
      recentHours += (after.at - start) / HOUR;
      recentDelta += consumed * (after.at - start) / gap;
    }
  }
  return { hours, delta, recentHours, recentDelta };
}

// Price a quota percentage by comparing fixed-reset contiguous runs with the usage
// recorded in the same interval. Costs are never paired across resets or gaps, and
// a positive sub-2pp movement stays usable as a low-confidence estimate.
function calibrateCapacity(store, provider, account, points, reset, scope, usageThrough) {
  const found = { ...NO_CAPACITY };
  let start = points[0];
  const matchRun = end => {
    if (!start || !end || !Number.isFinite(start.reset) || end.at - start.at < MIN_INTERVAL) return;
    let change = end.used - start.used;
    if (change <= 1e-6) return; // Ignore floating-point jitter, not small real percentage changes.
    found.observedDelta += change;
    if (end.at > usageThrough) {
      found.incomplete = true;
      end = points.findLast(p => p.at >= start.at && p.at <= usageThrough);
      if (!end || end.at - start.at < MIN_INTERVAL) return;
      change = end.used - start.used;
      if (change <= 1e-6) return;
    }
    const cost = store.stats(provider.id, account.id, start.at, end.at, scope);
    const unattributed = store.stats(provider.id, null, start.at, end.at, scope);
    found.incomplete ||= cost.unknownPriceRequests > 0 || unattributed.requests > 0;
    found.historical ||= Math.abs(start.reset - reset) > 60000;
    // A run whose logged dollars are zero still consumed the limit. Dropping it
    // because of its own outcome is what let one cheap request move the estimate
    // severalfold, so keep its consumption in the denominator instead.
    if (!cost.pricedRequests || !Number.isFinite(cost.apiUsd) || cost.apiUsd <= 0) { found.unexplainedDelta += change; return; }
    found.matchedUsd += cost.apiUsd;
    found.matchedDelta += change;
    found.matchedRequests += cost.pricedRequests;
    found.localPrices += cost.localPriceRequests;
    found.latestMatchedAt = end.at;
  };
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1], point = points[i];
    if (point.segmentId !== start.segmentId || point.used < previous.used) {
      matchRun(previous); start = point;
    }
  }
  matchRun(points.at(-1));
  return found;
}

function applyCapacity(result, capacity, window, { supported, publishable, observations }) {
  const { matchedUsd, matchedDelta, matchedRequests, localPrices, incomplete, observedDelta,
    unexplainedDelta, latestMatchedAt, historical } = capacity;
  result.matchedDeltaPp = matchedDelta;
  result.unexplainedDeltaPp = unexplainedDelta;
  result.capacityObservedDeltaPp = observedDelta;
  result.capacityMatchedQuotaCoverage = observedDelta > 0 ? matchedDelta / observedDelta : null;
  result.capacityObservedAt = iso(latestMatchedAt);
  // The scope is known but its mapping is unconfirmed, so no dollar value is
  // published. Observed consumption still shows through unexplainedDeltaPp.
  if (!publishable.ok && publishable.reason) { result.capacityReason = publishable.reason; return; }
  if (!(matchedDelta > 0 && matchedRequests > 0 && matchedUsd > 0)) {
    result.capacityReason = !supported ? '이 한도의 대상 모델과 사용 기록을 연결할 수 없습니다.' :
      !observations ? '이 계정의 쿼타 관측 기록이 없습니다.' :
      observedDelta > 0 ? '쿼타가 증가한 동일 구간에 계정과 연결된 환산 가능 사용액이 없습니다.' :
      '연속 관측 구간에서 쿼타 증가가 아직 확인되지 않았습니다. 누적 사용액만으로 한도를 역산하지 않습니다.';
    return;
  }
  result.matchedApiUsd = matchedUsd;
  // Quota that moved with no priced usage belongs in the denominator: it consumed
  // the same limit. Unrecorded usage pulls the result down and integer-percent
  // rounding pushes it up, so this is a conservative estimate, not a bound.
  const denominator = matchedDelta + unexplainedDelta;
  result.capacityApiUsd = matchedUsd / denominator * 100;
  result.remainingApiUsd = result.capacityApiUsd * window.remainingPercent / 100;
  result.capacityBasis = unexplainedDelta > 0 ? 'lower-bound' : incomplete ? 'partial' : historical ? 'historical' : 'matched';
  result.confidence = matchedDelta >= 10 && matchedRequests >= 20 && !localPrices && !incomplete && !historical && unexplainedDelta === 0 ? 'medium' : 'low';
  result.capacitySourceLabel = `${historical ? '이전 리셋 구간 포함 · ' : ''}이 계정 ${Number(denominator.toFixed(3))}%p 관측` +
    (unexplainedDelta > 0 ? ` · 환산 못한 소모 ${Number(unexplainedDelta.toFixed(3))}%p` : '');
  result.capacityReason = `${iso(latestMatchedAt)}까지 같은 구간의 API 환산액과 쿼타 변화를 비교했습니다.` +
    (denominator < 2 ? ' 소량 변화라 반올림·갱신 지연의 영향이 큽니다.' : '') +
    (unexplainedDelta > 0 ? ` OpenCodex 기록에 없거나 단가를 확인하지 못한 사용으로 ${Number(unexplainedDelta.toFixed(3))}%p가 더 줄었습니다. 이 몫도 분모에 넣어 보수적으로 계산했습니다.` : '') +
    (incomplete ? ' 사용액 또는 계정 연결이 불완전한 일부 관측으로 추정했습니다. 실제 한도의 하한을 보장하지 않습니다.' : '') +
    (localPrices ? ' 로컬 단가 추정이 포함됩니다.' : '');
}

function applyForecast(result, { window, forecast, measuredAt, reset, freshCurrent }) {
  // Exhaustion is an observed state; it does not require a learned burn rate.
  if (freshCurrent && window.remainingPercent === 0) {
    result.status = 'ok';
    result.exhaustsAt = iso(measuredAt);
    result.forecastObservedAt = iso(measuredAt);
    result.resetBeforeExhaustion = false;
    result.projectedUsedAtReset = window.usedPercent;
    result.reason = '마지막 관측에서 한도를 모두 사용했습니다.';
  }
  if (!freshCurrent || forecast.hours * HOUR < MIN_INTERVAL) return;
  result.status = 'ok';
  result.reason = result.capacityApiUsd === null ? result.capacityReason : '관측된 OpenCodex 사용과 쿼타 변화의 비례 추정입니다. 다른 앱 사용이 있으면 달라집니다.';
  if (result.capacityBasis === 'lower-bound') result.reason = '환산하지 못한 쿼타 변화까지 분모에 넣어 보수적으로 계산했습니다. 기록되지 않은 사용과 정수 퍼센트 반올림 때문에 실제 한도와는 다를 수 있습니다.';
  else if (result.capacityBasis === 'partial') result.reason = '미연결·단가 미확인 사용 또는 사용액이 없는 관측 구간이 있어 일부 기록으로 추정했습니다.';
  const rate = forecast.delta / forecast.hours;
  result.forecastObservedAt = iso(measuredAt);
  if (window.remainingPercent > 0 && rate > 0 &&
      (forecast.hours * HOUR < MIN_FORECAST_INTERVAL || forecast.delta < MIN_FORECAST_DELTA)) {
    result.status = 'collecting';
    result.reason = '소진 예상은 관측 15분 이상·2%p 이상 변화가 쌓이면 계산합니다. 최근 7일의 관측된 유휴 시간도 평균에 포함합니다.';
    return;
  }
  result.forecastRatePpHour = rate;
  if (window.remainingPercent === 0) result.exhaustsAt = iso(measuredAt);
  else if (rate > 0) result.exhaustsAt = iso(measuredAt + window.remainingPercent / rate * HOUR);
  result.resetBeforeExhaustion = window.remainingPercent === 0 ? false : rate === 0 || (result.exhaustsAt !== null && reset < Date.parse(result.exhaustsAt));
  result.projectedUsedAtReset = window.usedPercent + Math.max(0, reset - measuredAt) / HOUR * rate;
}

export function windowAnalytics(store, provider, account, window, now) {
  // Calibrate every window over thirty days: a limit's dollar value is a property
  // of the plan, so more observed cycles beat a shorter, fresher sample. Keep a
  // boundary predecessor and freshness margin so cached reads do not silently drop
  // the start of the measurement-anchored average.
  const rawPoints = store.points(provider.id, account.id, window.id, now - MONTH - MAX_GAP).filter(p => p.at <= now);
  // Within-tolerance downward blips are reconciled to the running high for every
  // consumer below; raw samples still feed the transported history and the
  // freshness comparison against the provider's latest reading.
  const normalized = normalizeQuotaPoints(rawPoints);
  const points = normalized.points;
  // The chart spans the window's own period — five hours for a five-hour limit,
  // seven days for a weekly one. A month of five-hour cycles compressed into one
  // sparkline shows nothing. Windows of unknown length fall back to a week.
  const charted = rawPoints.filter(p => p.at >= now - (windowHours(window) ?? 168) * HOUR);
  const result = emptyResult(sampleHistory(charted));
  result.quotaAdjustment = { tolerancePp: DIP_TOLERANCE_PP, adjustedSamples: normalized.adjustedSamples };
  if (window.stale || ['reauth', 'paused'].includes(account.status)) return { ...result, status: 'stale', reason: account.status === 'reauth' ? '로그인을 갱신해야 이 계정의 한도를 계산할 수 있습니다.' : account.status === 'paused' ? '일시 중지된 계정입니다.' : '최근 쿼타 측정값을 기다리고 있습니다.' };
  if (!window.resetAt) return { ...result, status: 'unsupported', reason: '리셋 시각이 없어 같은 한도 구간인지 확인할 수 없습니다.' };
  const reset = Date.parse(window.resetAt);
  if (!Number.isFinite(reset) || reset <= now) return { ...result, status: 'stale', reason: '리셋 이후의 새 측정값을 기다리고 있습니다.' };
  const current = latestContiguousRun(points, reset);
  // A cache refresh can precede history capture. Never combine its new remaining
  // percentage with an older measurement's forecast timestamp.
  const latest = current.at(-1);
  const rawLatest = latest ? rawPoints.findLast(p => p.at === latest.at) : null;
  const freshCurrent = rawLatest && now - rawLatest.at <= STALE_MS && rawLatest.used === window.usedPercent;
  const measuredAt = latest?.at ?? points.at(-1)?.at ?? now;
  const forecast = longTermForecast(points, measuredAt);
  result.forecastObservedHours = forecast.hours;
  result.forecastSpanHours = forecast.spanHours;
  result.forecastCoverage = forecast.coverage;
  const rates = freshCurrent ? observedRates(current, Math.max(current[0]?.at ?? now, measuredAt - HOUR)) : NO_RATES;
  result.observedHours = rates.hours;
  if (rates.hours * HOUR >= MIN_INTERVAL) result.averageRatePpHour = rates.delta / rates.hours;
  if (rates.recentHours * HOUR >= MIN_INTERVAL) result.recentRatePpHour = rates.recentDelta / rates.recentHours;
  const scope = resolveScope(provider, window);
  const supported = scope !== null;
  const publishable = supported ? scopePublishes(scope) : { ok: false, reason: null };
  const usageReadAt = store.get?.('usageReadAt');
  const usageThrough = Number.isFinite(usageReadAt) ? Math.min(now, usageReadAt) : now;
  const capacity = supported ? calibrateCapacity(store, provider, account, points, reset, scope, usageThrough) : NO_CAPACITY;
  applyCapacity(result, capacity, window, { supported, publishable, observations: points.length });
  if (normalized.adjustedSamples > 0) {
    if (result.capacityApiUsd !== null) result.confidence = 'low';
    if (result.capacityReason) result.capacityReason += ' ' + DIP_TOLERANCE_PP + '%p 이하의 하향 보정 ' + normalized.adjustedSamples + '개를 같은 구간의 상한으로 간주해 계산했습니다.';
  }
  applyForecast(result, { window, forecast, measuredAt, reset, freshCurrent });
  return result;
}

export function enrichSnapshot(snapshot, store, identities, { subscriptionFor = () => ({label:null,monthlyUsd:null,basis:"unselected"}), pricingSources }, now = Date.now(), error = null) {
  const bounds = store.bounds();
  // A failed log read is missing observation time, not evidence of zero usage.
  // Anchor every usage numerator and denominator to the same successful read.
  const usageReadAt = store.get('usageReadAt');
  const usageNow = Number.isFinite(usageReadAt) ? Math.min(now, usageReadAt) : now;
  const usageStale = Boolean(error) || now - usageNow > STALE_MS;
  // How much of a period's span the retained usage log reaches back over. One
  // OpenCodex log holds every provider, so this is a property of the log we kept,
  // not evidence that a particular account was watched that long: a single old row
  // from another provider covers the span for an account added this morning. An
  // account's own silence is reported by its request count, never by this number.
  const logCoverage = ms => Number.isFinite(bounds.since)
    ? Math.max(0, Math.min(ms, usageNow - bounds.since)) / HOUR : 0;
  // How much of a period we actually watched. The observation run starts when reading
  // began or restarted, and its far end only moves when a read reached the end of the
  // log, so an unresolved record holds it back. Deliberate exclusions bound the near
  // end: a history reset and the retention boundary both drop rows we would otherwise
  // have counted. This says no break was detected over the span, which is not the same
  // as proving no call existed; README names what goes undetected.
  const observedSince = store.get?.('usageObservedSince');
  const observedThrough = store.get?.('usageObservedThrough');
  const observedFrom = Math.max(...[observedSince, store.get?.('historyResetAt'), store.get?.('usageExcludedBefore')]
    .filter(n => Number.isFinite(n)));
  const observedCoverage = ms => Number.isFinite(observedSince) && Number.isFinite(observedThrough)
    ? Math.max(0, Math.min(usageNow, observedThrough) - Math.max(usageNow - ms, observedFrom)) / HOUR : 0;
  // Attach the boundary after store.stats returns. That query normalizes its own
  // row keys to zero, and a timestamp is not a count.
  const periodStats = (provider, account) => Object.fromEntries(USAGE_PERIODS.map(([key, ms]) =>
    [key, { ...store.stats(provider, account, usageNow - ms, usageNow), startedAt: iso(usageNow - ms),
      endedAt: iso(usageNow), hours: ms / HOUR, logCoverageHours: logCoverage(ms),
      observedCoverageHours: observedCoverage(ms) }]));
  const summary = (provider, account) => {
    const since = store.pricedBounds(provider, usageNow-WEEK, usageNow, account).since;
    const hours = since ? Math.max(0, (usageNow - Math.max(since, usageNow - WEEK)) / HOUR) : 0;
    const periods = periodStats(provider, account);
    const weekly = periods.weekly;
    const usdPerHour = hours >= 1 && weekly.apiUsd !== null ? weekly.apiUsd / hours : null;
    // basisPeriod names the sample these projections rest on. It stays the 7-day
    // span whichever period a reader is looking at, so the two cannot be confused.
    return { periods, pace: { usdPerHour, projectedFiveHourUsd: usdPerHour === null ? null : usdPerHour * 5,
      projectedWeekUsd: usdPerHour === null ? null : usdPerHour * 168, observedHours: hours, observedAt: iso(usageNow), stale: usageStale,
      basisPeriod: 'weekly', pricedCoverage: weekly.requests ? weekly.pricedRequests / weekly.requests : 0 } };
  };
  const providers = snapshot.providers.map(p => {
    const excluded = snapshot[MODEL_EXCLUSIONS];
    // A provider total splits into three parts that are each queried on their own:
    // the accounts this snapshot lists, rows no account claims, and rows belonging to
    // an account id the snapshot does not list, which is where a removed account's
    // history lives. Querying the listed part rather than adding up the account rows
    // keeps the identity true even when a snapshot repeats an account id.
    const listedIds = [...new Set(p.accounts.map(a => a.id))];
    const listedPeriods = periodStats(p.id, { listed: listedIds });
    const unlistedPeriods = periodStats(p.id, { unlisted: listedIds });
    const unattributedPeriods = periodStats(p.id, null);
    const unattributedMonthly = unattributedPeriods.monthly;
    const accounts = p.accounts.map(a => {
      const data = summary(p.id, a.id);
      const plan = a.plan ?? identities.plans.get(`${p.id}\0${a.id}`) ?? null;
      const subscription = subscriptionFor(p.id, a.id);
      const monthly = data.periods.monthly;
      return { ...a, plan, analytics: { ...data, subscription,
        monthlyValueRatio: subscription.monthlyUsd > 0 && monthly.apiUsd !== null ? monthly.apiUsd / subscription.monthlyUsd : null,
        monthlyValueBasis: monthly.apiUsd === null ? null : monthly.unknownPriceRequests > 0 || unattributedMonthly.requests > 0 ? 'partial' : monthly.localPriceRequests > 0 ? 'estimated' : 'matched' },
        windows: a.windows.map(w => ({ ...w,
          ...(() => { const s = resolveScope(p, w); return s?.emitScope ? { label: s.label, usageScope: s.id } : {}; })(),
          analytics: windowAnalytics(store, p, a, w, now) })) };
    });
    for (const account of accounts) constrainNestedWindows(account.windows);
    const next = accounts.flatMap(a => a.windows.filter(w => w.analytics.exhaustsAt && w.analytics.resetBeforeExhaustion === false)
      .map(w => ({ at: w.analytics.exhaustsAt, label: a.label }))).sort((a, b) => a.at.localeCompare(b.at))[0];
    const subscriptionPrices = accounts.map(a => a.analytics.subscription.monthlyUsd);
    const subscriptionMonthlyUsd = accounts.length && subscriptionPrices.every(n => Number.isFinite(n) && n >= 0) ? subscriptionPrices.reduce((sum, n) => sum + n, 0) : null;
    const providerSummary = summary(p.id);
    const periods = Object.fromEntries(Object.entries(providerSummary.periods).map(([key, stats]) =>
      [key, { ...stats,
        listedAccountRequests: listedPeriods[key].requests, listedAccountTokens: listedPeriods[key].tokens,
        listedAccountApiUsd: listedPeriods[key].apiUsd,
        unattributedRequests: unattributedPeriods[key].requests, unattributedTokens: unattributedPeriods[key].tokens,
        unattributedApiUsd: unattributedPeriods[key].apiUsd,
        unlistedAccountRequests: unlistedPeriods[key].requests, unlistedAccountTokens: unlistedPeriods[key].tokens,
        unlistedAccountApiUsd: unlistedPeriods[key].apiUsd }]));
    const result = { ...p, accounts, analytics: { ...providerSummary, periods, subscriptionMonthlyUsd, unattributed: store.stats(p.id, null, usageNow - WEEK, usageNow),
      // Recorded names reach the response through the same shape gate as the price
      // list: the usage log belongs to another product and is not a naming authority.
      unpricedModels: store.unpricedModels(p.id, usageNow - MONTH, usageNow)
        .filter(row => modelId(row.model) !== null && !carriesSecret(row.model, excluded)),
      nextExhaustionAt: next?.at ?? null, nextExhaustionAccount: next?.label ?? null } };
    result.analytics.recommendation = recommendSubscriptions(result, store, usageNow);
    return result;
  });
  const prices = providers.map(p => p.analytics.subscriptionMonthlyUsd);
  return { ...snapshot, providers, analytics: {
    subscriptionMonthlyUsd: prices.length && prices.every(n => Number.isFinite(n)) ? prices.reduce((sum, n) => sum + n, 0) : null,
    status: error ? 'error' : store.get('lastCollectedAt') ? 'ok' : 'collecting', sampleIntervalSeconds: 10,
    lastCollectedAt: iso(store.get('lastCollectedAt')), historyStartedAt: iso(store.get('historyStartedAt')),
    usageSince: iso(bounds.since), usageThrough: iso(bounds.through), invalidUsageLines: store.get('invalidUsageLines') ?? 0,
    usageObservedAt: iso(usageReadAt), usageStale,
    usageObservedSince: iso(observedSince), usageObservedThrough: iso(observedThrough),
    sources: pricingSources, notes: [
      ...(error ? ['수집에 실패했습니다. 기존 기록을 표시합니다. 다음 수집 때 재시도합니다.'] : []),
      ...(usageStale ? ['사용액과 사용 속도는 마지막으로 사용 기록을 읽은 시점 기준입니다. 수집 중단 시간을 유휴 사용으로 계산하지 않습니다.'] : []),
      '사용액 기간은 마지막으로 사용 기록을 읽은 시각에서 거꾸로 센 최근 1시간·5시간·24시간·7일·30일입니다. 하루는 달력 날짜가 아니라 최근 24시간이고, 월간 효율도 실제 결제 주기가 아닌 최근 30일 기준입니다.',
      '소진 예상은 최근 7일(기록이 짧으면 쌓인 기간)의 쿼타 소모량을 관측 시간으로 나눈 장기 평균입니다. 관측된 유휴 시간과 이전 리셋 구간도 포함하며, 수집 공백과 리셋을 가로지르는 구간은 제외합니다. 기록이 짧으면 초기 추정입니다.',
      '호출 수는 재시도를 포함한 외부 요청 시도 수입니다. 대화·메시지 수와 다릅니다.',
      'API 환산액은 청구액이 아닙니다. 단가 미확인 사용은 제외하고, 로컬 단가는 별도 표시합니다.',
      '쿼타 리셋은 구독 결제일과 다릅니다. 여러 계정의 쿼타 퍼센트와 한도별 환산 가치는 서로 더하지 않습니다.',
      '사용 기록은 OpenCodex 경유 요청만 포함합니다. 외부 앱 사용·관측 지연·정수 퍼센트 반올림은 한도 가치와 소진 예상에 영향을 줍니다.',
    ] } };
}
