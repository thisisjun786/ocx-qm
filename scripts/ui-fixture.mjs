// Deterministic snapshot for the dashboard smoke check. It mirrors the shape
// src/analytics.mjs produces and covers the states the UI must distinguish:
// fresh, stale, reauth, paused, disabled provider, partial capacity,
// cursor cache assumption, ollama calibration and an unpriced model.
const at = offset => new Date(Date.now() + offset).toISOString();

const stats = (requests, apiUsd, extra = {}) => ({ requests, tokens: 120000, inputTokens: 90000,
  outputTokens: 25000, cachedTokens: 40000, pricedRequests: requests, apiUsd, unknownPriceRequests: 0,
  localPriceRequests: 0, cacheEstimatedRequests: 0, estimatedCachedTokens: 0, noCacheApiUsd: apiUsd, ...extra });
const periods = () => ({ fiveHour: stats(4, 1.2), weekly: stats(40, 18.5), monthly: stats(160, 74) });
const pace = () => ({ usdPerHour: 0.5, projectedFiveHourUsd: 2.5, projectedWeekUsd: 84,
  observedHours: 40, observedAt: at(-30000), stale: false, pricedCoverage: 1 });

const windowAnalytics = (overrides = {}) => ({ status: 'ok', recentRatePpHour: 0.8, averageRatePpHour: 0.6,
  exhaustsAt: at(9 * 3600000), forecastRatePpHour: 0.6, forecastObservedAt: at(-30000),
  forecastObservedHours: 30, forecastSpanHours: 40, forecastCoverage: 0.75, resetBeforeExhaustion: false,
  projectedUsedAtReset: 70, capacityApiUsd: 120, remainingApiUsd: 48, matchedApiUsd: 30, matchedDeltaPp: 25,
  observedHours: 30, confidence: 'medium', capacityBasis: 'matched', capacityObservedAt: at(-30000),
  capacityObservedDeltaPp: 25, capacityMatchedQuotaCoverage: 0.9, capacitySourceLabel: '이 계정 25%p 관측',
  capacityReason: '같은 구간의 API 환산액과 쿼타 변화를 비교했습니다.',
  reason: '관측된 사용과 쿼타 변화의 비례 추정입니다.',
  history: Array.from({ length: 12 }, (unused, index) => ({ at: at(-(12 - index) * 600000),
    usedPercent: index * 5, resetAt: at(6 * 3600000) })),
  ...overrides });

const quotaWindow = (id, label, usedPercent, overrides = {}) => ({ id, label, usedPercent,
  remainingPercent: 100 - usedPercent, resetAt: at(6 * 3600000), stale: false,
  ...overrides, analytics: windowAnalytics(overrides.analytics) });

const account = (id, label, overrides = {}) => ({ id, label, plan: 'pro', active: true, status: 'ok',
  updatedAt: at(-30000), quotaMode: 'observed', windows: [quotaWindow('weekly', '주간', 40)],
  refresh: { status: 'ok', lastAttemptAt: at(-30000), nextAttemptAt: null },
  ...overrides,
  analytics: { periods: periods(), pace: pace(),
    subscription: { label: 'Pro', monthlyUsd: 20, basis: 'official-list' },
    monthlyValueRatio: 3.7, monthlyValueBasis: 'matched', ...overrides.analytics } });

const recommendation = () => ({ status: 'provisional', observedDays: 4, weeklyDemandApiUsd: 120,
  weeklyCapacityPerAccountUsd: 100, minimumAccounts: 2, recommendedAccounts: 2, currentAccounts: 2,
  additionalAccounts: 0, estimatedMonthlyUsd: 40, headroomPercent: 20,
  reason: '여유를 반영한 필요 구독 2개 · 설정된 사용 가능 구독 2개.', planLabel: '관측 계정 평균',
  capacitySampleAccounts: 2, fiveHourSampleAccounts: 1, observedAt: at(-30000), usageStale: false });

const providerAnalytics = (extra = {}) => ({ periods: periods(), pace: pace(), subscriptionMonthlyUsd: 40,
  unattributed: stats(1, 0.2), unpricedModels: [{ model: 'mystery-model', requests: 3 }],
  nextExhaustionAt: at(9 * 3600000), nextExhaustionAccount: '계정 1', recommendation: recommendation(), ...extra });

export function buildFixture() {
  const providers = [
    { id: 'openai', name: 'OpenAI', enabled: true, defaultModel: 'gpt-5', accounts: [
      account('a1', '계정 1', { windows: [quotaWindow('weekly', '주간', 40),
          quotaWindow('five-hour', '5시간', 30, { resetAt: at(-60000) })],
        refresh: { status: 'delayed', lastAttemptAt: at(-120000), nextAttemptAt: at(45000) } }),
      account('a2', '계정 2', { status: 'reauth',
        windows: [quotaWindow('weekly', '주간', 90, { stale: true,
          analytics: { status: 'stale', capacityApiUsd: null, remainingApiUsd: null, exhaustsAt: null,
            confidence: null, capacityBasis: null, reason: '로그인을 갱신해야 한도를 계산할 수 있습니다.', history: [] } })],
        refresh: { status: 'delayed', lastAttemptAt: at(-120000), nextAttemptAt: at(60000) } }),
      account('a3', '장기 보관용 조직 공용 워크스페이스 일시 중지 계정 (하반기 아카이브)', { status: 'paused',
        windows: [quotaWindow('weekly', '주간', 10, { stale: true, analytics: { status: 'stale', history: [] } }),
          quotaWindow('monthly', '월간', 40, { stale: true, analytics: { status: 'stale', history: [] } })] }),
    ] },
    { id: 'anthropic', name: 'Anthropic', enabled: true, defaultModel: null, accounts: [
      account('b1', 'Anthropic 계정', { windows: [
        quotaWindow('five-hour', '5시간', 12),
        quotaWindow('weekly', '전체 주간', 88, { usageScope: 'all',
          analytics: { capacityBasis: 'lower-bound', confidence: 'low', unexplainedDeltaPp: 24,
            capacityReason: '환산하지 못한 쿼타 변화까지 분모에 넣어 보수적으로 계산했습니다.' } }),
        quotaWindow('custom-0', 'Fable 주간', 95, { usageScope: 'fable',
          analytics: { capacityBasis: 'lower-bound', confidence: 'low', capacityMatchedQuotaCoverage: 0.4,
            unexplainedDeltaPp: 24,
            capacityReason: '환산하지 못한 쿼타 변화까지 분모에 넣어 보수적으로 계산했습니다.' } }),
      ] }),
    ] },
    { id: 'cursor', name: 'Cursor', enabled: true, defaultModel: null,
      accounts: [account('c1', 'Cursor 계정', { windows: [quotaWindow('monthly', '월간', 5)] })],
      analytics: providerAnalytics({ cacheAssumption: { appliedRate: 0.62, stale: false, updatedAt: Date.now(),
        from: Date.now() - 30 * 86400000, through: Date.now(), invalidLines: 0 },
        periods: { fiveHour: stats(4, 1.2, { cacheEstimatedRequests: 4, noCacheApiUsd: 2.1 }),
          weekly: stats(40, 18.5, { cacheEstimatedRequests: 40, noCacheApiUsd: 30 }),
          monthly: stats(160, 74, { cacheEstimatedRequests: 160, noCacheApiUsd: 120 }) } }) },
    { id: 'ollama-cloud', name: 'Ollama Cloud', enabled: false, defaultModel: null, accounts: [
      account('key:d1', 'Ollama 키', { plan: null,
        windows: [quotaWindow('weekly', '주간', 2, { resetAt: null,
          analytics: { status: 'unsupported', capacityApiUsd: null, remainingApiUsd: null, exhaustsAt: null,
            confidence: null, capacityBasis: null, reason: '리셋 시각이 없어 같은 한도 구간인지 확인할 수 없습니다.' } })],
        ollama: { status: 'collecting', windows: [{ id: 'weekly', label: '주간', models: [
          { model: 'qwen3-coder', intervals: 3, requests: 9, deltaPp: 1.5, inputTokens: 90000,
            outputTokens: 12000, apiUsd: 0.4, priced: true, inputTokensPerPp: 60000,
            outputTokensPerPp: 8000, apiUsdPerPp: 0.27 }] }] },
        analytics: { periods: { fiveHour: stats(0, null), weekly: stats(0, null), monthly: stats(0, null) } } }),
    ] },
  ].map(provider => ({ ...provider, analytics: provider.analytics ?? providerAnalytics() }));

  return { schemaVersion: 1, observedAt: at(0), source: 'ui-check-fixture', refreshIntervalSeconds: 10,
    warnings: ['일부 프로바이더의 자동 조회에 실패했습니다. 마지막 측정값을 표시합니다.'],
    providers,
    analytics: { subscriptionMonthlyUsd: 160, status: 'ok', sampleIntervalSeconds: 10,
      lastCollectedAt: at(-5000), historyStartedAt: at(-4 * 86400000), usageSince: at(-4 * 86400000),
      usageThrough: at(-5000), invalidUsageLines: 0, usageObservedAt: at(-5000), usageStale: false,
      pricingCatalog: { status: 'ok', modelCount: 6490, updatedAt: at(-1800000), basis: 'local-catalog' },
      sources: [{ label: 'OpenAI 가격', url: 'https://openai.com/api/pricing/', checkedAt: at(-86400000) }],
      notes: ['API 환산액은 청구액이 아닙니다.'] } };
}
