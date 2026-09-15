const DAY = 86400000;
const mean = values => values.reduce((sum,n)=>sum+n,0)/values.length;
const hasCapacity = w => !w?.stale && w?.analytics?.status !== 'stale' && Number.isFinite(w?.analytics?.capacityApiUsd) && w.analytics.capacityApiUsd > 0;
const shortWindow = a => a.windows.find(w => w.id === 'five-hour' || (w.id === 'short' && w.label === '5시간'));

// Estimate a provider's workload against the arithmetic mean of measured accounts.
// Plan names and subscription prices do not determine quota capacity.
export function recommendSubscriptions(provider, store, now) {
  const since = store.pricedBounds(provider.id,now-30*DAY,now).since;
  const observedDays = since ? Math.max(0, Math.min(30, (now-since)/DAY)) : 0;
  const monthly = provider.analytics.periods.monthly;
  // Selection is not usability, and missing quota is not a lost subscription.
  // Bare API keys need a plan or quota evidence before counting as subscriptions.
  const configured = provider.accounts.filter(a => !['reauth','paused'].includes(a.status) &&
    (!a.id?.startsWith('key:') || a.plan || a.windows.length || a.analytics?.subscription?.monthlyUsd > 0));
  const available = configured.filter(a => a.windows.length && (a.status === 'ok' ||
    (a.status === 'stale' && a.windows.some(w => w.stale === false))));
  const result = { status:'collecting', observedDays, weeklyDemandApiUsd:null, weeklyCapacityPerAccountUsd:null,
    minimumAccounts:null,recommendedAccounts:null,currentAccounts:configured.length,additionalAccounts:null,
    estimatedMonthlyUsd:null,headroomPercent:20,reason:'계정당 한도 가치와 사용 기록을 수집 중입니다.',planLabel:null,peakFiveHourAccounts:null,
    capacitySampleAccounts:0,fiveHourSampleAccounts:0,baselineWeeklyDemandApiUsd:null,recentWeeklyDemandApiUsd:null,recentObservedDays:0,demandBasis:null,
    observedAt:provider.analytics.pace?.observedAt ?? null,usageStale:provider.analytics.pace?.stale === true };
  if (observedDays < 1) return {...result,reason:'최소 하루의 사용 기록이 필요합니다. 최근 30일이 쌓일수록 안정적입니다.'};
  const partialUsage = monthly.unknownPriceRequests > 0;
  if (!Number.isFinite(monthly.apiUsd)) return {...result,reason:'환산 가능한 사용 기록을 기다리고 있습니다.'};
  result.baselineWeeklyDemandApiUsd = monthly.apiUsd / observedDays * 7;
  const recentSince = store.pricedBounds(provider.id,now-7*DAY,now).since;
  result.recentObservedDays = recentSince ? Math.max(0,Math.min(7,(now-recentSince)/DAY)) : 0;
  const recentUsd = provider.analytics.periods.weekly.apiUsd;
  if (result.recentObservedDays>=1 && Number.isFinite(recentUsd)) result.recentWeeklyDemandApiUsd = recentUsd/result.recentObservedDays*7;
  result.weeklyDemandApiUsd = Math.max(result.baselineWeeklyDemandApiUsd,result.recentWeeklyDemandApiUsd ?? 0);
  result.demandBasis = result.recentWeeklyDemandApiUsd !== null && result.recentWeeklyDemandApiUsd>=result.baselineWeeklyDemandApiUsd ? 'recent-week' : 'monthly-baseline';
  const candidates = available.filter(a => a.windows.some(w=>w.id==='weekly' && hasCapacity(w)));
  const weeklyWindows = candidates.map(a=>a.windows.find(w=>w.id==='weekly' && hasCapacity(w)));
  if (!weeklyWindows.length) return {...result,reason:'주간 한도가 측정된 계정을 기다리고 있습니다.'};
  result.capacitySampleAccounts = candidates.length;
  result.weeklyCapacityPerAccountUsd = mean(weeklyWindows.map(w=>w.analytics.capacityApiUsd));
  const weeklyNeed = result.weeklyDemandApiUsd / result.weeklyCapacityPerAccountUsd;
  const short = available.map(shortWindow).filter(hasCapacity);
  const shortOffered = available.filter(a=>shortWindow(a)).length;
  result.fiveHourSampleAccounts = short.length;
  let peakNeed = 0;
  if (short.length) {
    // The query's lower boundary is exclusive: using the first request time
    // would omit that request, which may itself be the largest observed burst.
    const peakUsd = store.peakFiveHour(provider.id, now-30*DAY, now);
    peakNeed = peakUsd / mean(short.map(w=>w.analytics.capacityApiUsd));
    result.peakFiveHourAccounts = Math.ceil(peakNeed);
  }
  const need = Math.max(weeklyNeed, peakNeed);
  result.minimumAccounts = Math.max(1,Math.ceil(need));
  result.recommendedAccounts = Math.max(1,Math.ceil(need/.8));
  result.additionalAccounts = Math.max(0,result.recommendedAccounts-result.currentAccounts);
  const prices = candidates.map(a=>a.analytics?.subscription?.monthlyUsd).filter(n=>Number.isFinite(n)&&n>0);
  // A missing price affects only the budget estimate, never the recommended count.
  if (prices.length === candidates.length) result.estimatedMonthlyUsd = result.recommendedAccounts * mean(prices);
  result.planLabel = '관측 계정 평균';
  const specialized = available.some(a=>a.windows.some(w=>w.id.startsWith('custom-')&&w.usedPercent>0));
  const measured = [...weeklyWindows,...short];
  const partialCapacity = measured.some(w=>['partial','lower-bound'].includes(w.analytics.capacityBasis));
  const conservativeCapacity = measured.some(w=>w.analytics.capacityBasis === 'lower-bound');
  const incompleteSample = candidates.length<configured.length || short.length<shortOffered;
  const mixedPlans = new Set(candidates.map(a=>a.plan ?? null)).size > 1;
  const strong = observedDays>=30 && measured.every(w=>w.analytics.confidence==='medium') && !monthly.localPriceRequests && !specialized && !partialUsage && !partialCapacity && !incompleteSample && !mixedPlans && !result.usageStale;
  result.status = strong?'ready':'provisional';
  result.reason = `여유를 반영한 필요 구독 ${result.recommendedAccounts}개 · 설정된 사용 가능 구독 ${result.currentAccounts}개 · 추가 필요 ${result.additionalAccounts}개. 최근 7일 추세와 30일 기준 평균 중 큰 작업량을 사용했습니다. 측정된 ${candidates.length}개 계정의 평균 주간 한도 기준, 가동 여유 20%를 반영했습니다.` +
    (short.length ? ` 5시간 한도는 ${short.length}개 계정의 평균입니다.` : ' 5시간 한도는 아직 측정되지 않아 주간 기준만 반영했습니다.') +
    (partialUsage||partialCapacity ? ' 미확인 사용은 제외했습니다.' : '') +
    (conservativeCapacity ? ' 한도를 보수적으로 잡아 기록된 사용량 기준 필요 계정 수가 늘었습니다. 기록되지 않은 사용이 있으면 실제 필요량은 이보다 클 수도 있습니다.' : '') +
    (incompleteSample ? ' 현재 계정 수는 설정된 사용 가능 계정 수이며, 한도는 측정 가능한 계정만 반영했습니다.' : '') +
    (mixedPlans ? ' 서로 다른 플랜의 평균이므로 같은 계정 구성을 유지한다는 가정입니다.' : '') +
    (result.usageStale ? ' 사용량은 마지막 수집 시점 기준입니다.' : '') +
    (specialized ? ' 모델별 추가 한도는 별도 확인이 필요합니다.' : '');
  return result;
}
