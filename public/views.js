import {finite, usd, number, count, percent, date, STATES, PERIODS, age, reset, until, windowLabel} from './format.js';
import {freshWindow, measurementReason, lookupDelay, usageAmount, usageNote, coverage} from './quota.js';
import {subscriptionEditor} from './subscriptions.js';
import {node, metric, quotaTrack, historyChart, methodology} from './dom.js';

export function periodGrid(analytics) {
  const grid = node('div', 'metrics usage-totals');
  for (const [key, label] of PERIODS) {
    const stats = analytics?.periods?.[key];
    const item = metric(label, usageAmount(stats), usageNote(stats));
    item.title = `${label} API 환산액`;
    grid.append(item);
  }
  return grid;
}
export function recommendationView(rec) {
  const line = node('div', 'recommend');
  const ready = rec?.status !== 'collecting' && finite(rec?.recommendedAccounts);
  line.append(node('span', '', '필요 계정'), node('strong', '', ready ? `약 ${count.format(rec.recommendedAccounts)}개` : '—'));
  if (rec?.reason) line.title = rec.reason;
  if (rec?.usageStale) line.append(node('small', '', '이전 추정'));
  return line;
}
export function subscriptionNote(sub, ratio, basis) {
  if (!finite(sub?.monthlyUsd)) return '구독료 미확인';
  return `${sub.label} 월 ${usd(sub.monthlyUsd)}` +
    (sub.basis === 'official-list' ? ' · 공식 정가' : '') +
    (finite(ratio) ? ` · 구독료 대비 환산액 약 ${number.format(ratio)}배${['partial', 'lower-bound'].includes(basis) ? ' (일부 사용)' : ''}` : '');
}
export function windowAnalyticsView(w) {
  const a = w.analytics;
  const grid = node('div', 'quota-values');
  // '보수 추정' means unpriced quota movement was divided into the estimate. The value
  // keeps '≈': integer-percent rounding can still push it above the real limit.
  const capacity = metric('100% 한도', finite(a?.capacityApiUsd) ? `≈ ${usd(a.capacityApiUsd)}` : '—',
    a?.capacityBasis === 'lower-bound' ? '보수 추정' : a?.capacityBasis === 'partial' ? '일부 관측' : null);
  capacity.title = a?.capacityReason || a?.reason || '계산할 기록 없음';
  grid.append(capacity, metric('잔여분', finite(a?.remainingApiUsd) ? `≈ ${usd(a.remainingApiUsd)}` : '—'));
  let eta = a?.status === 'collecting' ? '관측 중' : '—';
  if (a?.status === 'ok') {
    if (w.remainingPercent === 0) eta = '소진됨';
    else if (a.forecastRatePpHour === 0) eta = '소모 없음';
    else if (a.resetBeforeExhaustion) eta = '리셋이 먼저';
    else if (a.exhaustsAt) eta = Date.parse(a.exhaustsAt) <= Date.now() ? '예상 시각 지남' : until(a.exhaustsAt) || '—';
  }
  const forecast = metric('소진 예상', eta, a?.exhaustsAt && w.remainingPercent > 0 && a?.forecastObservedHours < 24 ? '초기 추정' : null);
  forecast.title = a?.exhaustsAt ? date.format(new Date(a.exhaustsAt)) : a?.reason || '계산할 기록 없음';
  grid.append(forecast);
  return grid;
}
export function windowView(account, w) {
  const fresh = freshWindow(account, w);
  const valid = finite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100;
  const item = node('div', `window${!fresh ? ' stale' : ''}${valid && w.remainingPercent < 20 ? ' low' : ''}`);
  const quota = node('div', 'window-quota');
  const title = node('div', 'window-title');
  const label = node('span', '', windowLabel(w)); label.title = w.label;
  title.append(label, node('strong', '', valid ? `${number.format(w.remainingPercent)}% 남음` : '—'));
  const reason = fresh ? null : measurementReason(account, w);
  // Account status and observation age stay in the heading/metadata. Badges
  // identify window failures under a recent account observation.
  const observedAt = Date.parse(account.updatedAt), now = Date.now();
  const recentObservation = finite(observedAt) && observedAt <= now + 60000 && now - observedAt <= 15 * 60000;
  const ownReason = reason && recentObservation && !['reauth', 'paused', 'unavailable'].includes(account.status) ? reason : null;
  if (ownReason) title.append(node('span', 'badge warning', ownReason));
  const track = quotaTrack(valid ? w.remainingPercent : null, `${w.label} 남은 한도${reason ? ` · ${reason}` : ''}`);
  const meta = node('div', 'window-meta');
  const resetAt = Date.parse(w.resetAt);
  const resetLabel = ownReason && finite(resetAt) && resetAt <= Date.now()
    ? `리셋 ${date.format(new Date(resetAt))}` : reset(w.resetAt);
  meta.append(node('span', '', fresh || ownReason ? resetLabel : reason));
  if (w.resetAt && finite(Date.parse(w.resetAt))) meta.title = date.format(new Date(w.resetAt));
  quota.append(title, track, meta);
  const analytics = fresh ? w : {...w, analytics:{status:'stale', reason}};
  item.append(quota, windowAnalyticsView(analytics));
  return item;
}
export function accountView(provider, a, ctx) {
  const article = node('article', 'account');
  const heading = node('div', 'account-heading');
  const name = node('span', 'account-name', a.label);
  name.title = a.label;
  heading.append(name);
  const sub = a.analytics?.subscription;
  if (sub?.monthlyUsd) heading.append(node('span','badge',sub.label));
  else if (a.plan === 'pro') heading.append(node('span','badge','Pro'));
  if (a.status === 'reauth') heading.append(node('span','badge warning','로그인 필요'));
  else if (a.status === 'paused') heading.append(node('span','badge','일시 중지'));
  const ratio = a.analytics?.monthlyValueRatio;
  const measurement = node('div','measurement');
  measurement.append(node('span','',age(a.updatedAt)));
  if (a.updatedAt && finite(Date.parse(a.updatedAt))) measurement.title = `마지막 측정: ${date.format(new Date(a.updatedAt))}`;
  const delay = lookupDelay(a);
  if (delay) {
    const note = node('span','refresh-note',delay);
    note.title = '사용량 조회에 실패했습니다. 마지막으로 성공한 측정값을 표시합니다.';
    if (finite(Date.parse(a.refresh.lastAttemptAt))) note.title += ` 마지막 조회 시도: ${date.format(new Date(a.refresh.lastAttemptAt))}`;
    measurement.append(note);
  }
  heading.append(measurement);
  article.append(heading);
  if (ctx?.subscriptions) article.append(subscriptionEditor(provider, a, ctx));
  const primary = a.windows;
  if (primary.length) {
    const windows = node('div','windows');
    primary.forEach(w => windows.append(windowView(a,w)));
    article.append(windows);
  } else article.append(node('p','unavailable','쿼타 —'));
  const details = node('details','method account-details');
  details.dataset.expand = `account:${provider.id}:${a.id}`;
  details.append(node('summary','','사용 기록과 계산 근거'));
  const linkedUsage = !a.ollama || a.analytics?.periods?.monthly?.requests > 0;
  if (linkedUsage) { details.append(node('h4', '', 'API 환산액')); details.append(periodGrid(a.analytics)); }
  else details.append(node('p','sub-note','호출 기록은 프로바이더 합계에 표시됩니다.'));
  details.append(node('p','sub-note',subscriptionNote(sub,ratio,a.analytics?.monthlyValueBasis)));
  const usage = a.analytics?.periods?.monthly;
  if (usage && linkedUsage) {
    const tokens = node('div','metrics');
    tokens.append(metric('입력 토큰',count.format(usage.inputTokens)),metric('출력 토큰',count.format(usage.outputTokens)),metric('캐시 읽기',count.format(usage.cachedTokens),'입력 토큰에 포함'));
    if (usage.cacheEstimatedRequests) tokens.append(metric('추정 캐시 읽기',count.format(usage.estimatedCachedTokens),'미보고 입력에 평균 비율 적용'));
    details.append(tokens);
    details.append(node('p','sub-note',`30일 ${count.format(usage.requests)}회 호출 · 가격 확인 ${percent.format(coverage(usage)*100)}%`));
  }
  for (const w of a.windows) {
    const section = node('div','detail-window');
    section.append(node('h4','',w.label));
    if (finite(w.usedPercent)) section.append(node('p', 'sub-note', `${number.format(w.usedPercent)}% 사용`));
    section.append(historyChart(w.analytics?.history,w.label));
    if (w.analytics?.capacityReason || w.analytics?.reason) section.append(node('p','sub-note',w.analytics.capacityReason || w.analytics.reason));
    if (finite(w.analytics?.capacityMatchedQuotaCoverage) && w.analytics.capacityMatchedQuotaCoverage < 1) section.append(node('p', 'sub-note', `사용액이 연결된 쿼타 변화 ${percent.format(w.analytics.capacityMatchedQuotaCoverage * 100)}%`));
    if (finite(w.analytics?.unexplainedDeltaPp) && w.analytics.unexplainedDeltaPp > 0) section.append(node('p', 'sub-note', `환산 못한 쿼타 변화 ${number.format(w.analytics.unexplainedDeltaPp)}%p 포함`));
    if (finite(w.analytics?.forecastRatePpHour)) section.append(node('p','sub-note', `평균 ${percent.format(w.analytics.forecastRatePpHour)}%p/시간 · ${number.format(w.analytics.forecastObservedHours)}시간 관측`));
    details.append(section);
  }
  if (a.ollama) {
    const calibration = node('div','detail-window');
    calibration.append(node('h4','','모델별 쿼타 관측'));
    let rows = 0;
    for (const w of a.ollama.windows) for (const m of w.models) {
      rows++;
      calibration.append(node('p','sub-note',`${w.label} · ${m.model} · 1%p 순증가당 입력 ${count.format(m.inputTokensPerPp)} / 출력 ${count.format(m.outputTokensPerPp)} 토큰 · 환산 ${usd(m.apiUsdPerPp)} · ${m.requests}회 관측`));
    }
    if (!rows) calibration.append(node('p','unavailable','단일 모델 사용 구간 수집 중'));
    calibration.append(node('p','sub-note','관측 구간의 입출력 비율 기준입니다. GPU 사용 시간과 호출별 정확한 차감량은 제공되지 않습니다.'));
    details.append(calibration);
  }
  if (sub?.reason) details.append(node('p','unavailable',sub.reason));
  article.append(details);
  return article;
}
export function providerAnalytics(p, ctx) {
  const wrap = node('div', 'provider-analytics');
  const title = node('div', 'section-caption');
  title.append(node('h4', '', 'API 환산액'), node('span', '', '전체 계정 합계'));
  wrap.append(title, periodGrid(p.analytics));
  if (finite(p.analytics?.subscriptionMonthlyUsd)) wrap.append(node('p', 'sub-note', `현재 월 구독료 ${usd(p.analytics.subscriptionMonthlyUsd)} · 전체 등록 계정`));
  const cache = p.analytics?.cacheAssumption;
  if (cache) {
    const stats = p.analytics.periods?.[ctx.selectedPeriod];
    const note = finite(cache.appliedRate)
      ? `캐시 ${percent.format(cache.appliedRate * 100)}% 가정 · Ollama와 같은 최근 30일 실측 평균 · 입력·출력 토큰도 추정값` + (cache.stale ? ' · 이전 평균 사용' : '')
      : '캐시 평균을 계산할 실측 자료가 없어 캐시 할인을 적용하지 않았습니다.';
    wrap.append(node('p','sub-note',note));
    if (stats?.cacheEstimatedRequests) wrap.append(node('p','sub-note',`${PERIODS.find(([key])=>key===ctx.selectedPeriod)[1]} 캐시 미적용 ${usd(stats.noCacheApiUsd)} → 추정 캐시 적용 ${usd(stats.apiUsd)}`));
  }
  if (p.analytics?.unpricedModels?.length) wrap.append(node('p','sub-note',`최근 30일 미환산: ${p.analytics.unpricedModels.map(m=>`${m.model || '모델 미기록'} ${count.format(m.requests)}회`).join(', ')} · 토큰·단가 확인 필요`));
  const details = node('details', 'method provider-details');
  details.dataset.expand = `provider:${p.id}`;
  details.append(node('summary', '', '사용 예상과 필요 계정'));
  const pace = p.analytics?.pace, rec = p.analytics?.recommendation;
  if (pace?.stale) details.append(node('p', 'sub-note', '이전 사용 기록 기준'));
  if (finite(rec?.currentAccounts)) details.append(node('p', 'sub-note', `현재 ${count.format(rec.currentAccounts)}개 계정`));
  const projections = node('div', 'metrics');
  projections.append(metric('5시간 사용 예상', usd(pace?.projectedFiveHourUsd)), metric('7일 사용 예상', usd(pace?.projectedWeekUsd)), metric('필요 계정', finite(rec?.recommendedAccounts) ? `약 ${count.format(rec.recommendedAccounts)}개` : '—'));
  details.append(projections);
  const capacities = node('div', 'metrics');
  for (const [id, label] of [['five-hour', '5시간 한도'], ['weekly', '주간 한도']]) {
    const measured = p.accounts.map(a => {
      const w = a.windows.find(w => w.id === id || (id === 'five-hour' && w.id === 'short' && w.label === '5시간'));
      return w && freshWindow(a, w) ? w : null;
    }).filter(w => w?.analytics?.status !== 'stale' && finite(w?.analytics?.capacityApiUsd) && w.analytics.capacityApiUsd > 0);
    const average = measured.length ? measured.reduce((sum, w) => sum + w.analytics.capacityApiUsd, 0) / measured.length : null;
    // The cohort can mix accounts whose value was divided by unpriced movement with
    // accounts whose value was fully matched. Say so rather than averaging silently.
    const conservative = measured.filter(w => w.analytics.capacityBasis === 'lower-bound').length;
    capacities.append(metric(label, finite(average) ? `≈ ${usd(average)}` : '—',
      measured.length ? `${measured.length}개 계정 평균${conservative ? ` · ${conservative}개는 보수 추정` : ''}` : '관측 부족'));
  }
  capacities.append(metric('예상 구독료', usd(rec?.estimatedMonthlyUsd), '계정별 월 구독료 기준'));
  details.append(capacities);
  if (rec?.reason) details.append(node('p', 'sub-note', rec.reason));
  if (p.analytics?.unattributed?.requests) details.append(node('p','sub-note',`최근 7일 계정 미연결 ${usd(p.analytics.unattributed.apiUsd)} (전체 합계에 포함)`));
  for (const [key, label] of PERIODS) {
    const stats = p.analytics?.periods?.[key];
    if (stats) details.append(node('p', 'sub-note', `${label} ${count.format(stats.requests)}회 호출 · 단가 확인 ${percent.format(coverage(stats) * 100)}%` + (stats.localPriceRequests ? ` · 토큰·캐시·단가 추정 ${count.format(stats.localPriceRequests)}회` : '')));
  }
  wrap.append(details);
  return wrap;
}
export function topEfficiency(ctx) {
  const notes = [
    '남은 한도는 같은 한도끼리 계정별 잔여율을 평균합니다. 플랜별 용량 차이는 반영하지 않으며, 조회 불가·만료된 측정은 제외합니다.',
    'API 환산액은 기록된 토큰을 API 단가로 계산한 추정액입니다. 청구액이나 절약액이 아닙니다. 단가 미확인 사용은 제외하며 일부로 표시합니다.',
    '100% 한도 = 같은 관측 구간의 API 환산액 ÷ 소모량(%p) × 100. 잔여분은 이 추정치에 잔여율을 곱합니다. 한도별 금액은 중복되므로 더하지 않습니다.',
    '소진 예상은 최근 7일의 관측된 소모 속도로 계산합니다. 유휴 시간은 포함하고, 수집 공백과 리셋 구간은 제외합니다.',
    '필요 계정은 관측된 계정 평균 용량과 사용 추세에 여유 20%를 둔 추정입니다. 모델 구성과 계정 플랜이 바뀌면 달라집니다.',
    '사용액은 OpenCodex 기록 기준입니다. 외부 앱 사용과 갱신 지연은 한도 환산에 영향을 줍니다. 구독료 비교는 최근 30일 사용액과 계정별로 선택한 요금제의 공식 월 정가를 사용합니다.',
  ];
  const catalog = ctx.snapshot.analytics?.pricingCatalog;
  if (catalog) notes.push(`공식 단가가 없는 모델은 로컬 카탈로그의 동일 제공자·모델 단가로 추정합니다. 카탈로그 ${catalog.status === 'ok' ? '정상' : catalog.status === 'stale' ? '이전 자료 사용' : '조회 불가'}.`);
  document.getElementById('efficiency').replaceChildren(methodology({sources:ctx.snapshot.analytics?.sources, notes}, {key:'top-method',title:'계산 기준과 단가 출처'}));
  if (finite(ctx.snapshot.analytics?.subscriptionMonthlyUsd)) document.getElementById('efficiency').prepend(node('p', 'sub-note', `등록 계정 월 구독료 합계 ${usd(ctx.snapshot.analytics.subscriptionMonthlyUsd)}`));
}
export function quotaOverview(p) {
  const groups = new Map();
  for (const a of p.accounts) for (const w of a.windows) {
    const key = `${w.id.startsWith('custom-') ? 'custom' : w.id}:${w.usageScope || ''}:${w.label}`;
    if (!groups.has(key)) groups.set(key, {label:windowLabel(w), fullLabel:w.label, remaining:0, accounts:0});
    if (!freshWindow(a, w)) continue;
    const group = groups.get(key); group.remaining += w.remainingPercent; group.accounts++;
  }
  const values = node('div', 'quota-bars');
  values.append(node('span', 'mobile-quota-caption', '남은 한도 · 계정 평균'));
  for (const g of groups.values()) {
    const remaining = g.accounts ? g.remaining / g.accounts : null;
    const bar = node('div', `quota-bar${remaining === null ? ' stale' : remaining < 20 ? ' low' : ''}`);
    const caption = node('div', 'quota-caption');
    caption.append(node('span', '', g.label), node('strong', '', remaining === null ? '—' : `${percent.format(remaining)}% 남음`));
    bar.title = remaining === null ? `${g.fullLabel}: 최근 측정 없음` : `${g.fullLabel}: 측정된 ${g.accounts}개 계정의 평균 잔여율`;
    bar.append(caption, quotaTrack(remaining, `${p.name} ${g.fullLabel}, ${g.accounts}개 계정 평균 잔여율`));
    if (remaining === null) bar.append(node('p', 'quota-note', '최근 측정 없음'));
    values.append(bar);
  }
  if (!groups.size) values.append(node('p', 'unavailable', '한도 조회 불가'));
  return values;
}
export function overviewView(providers, ctx) {
  const list = node('section', 'summary-list');
  list.setAttribute('aria-label', '제공자별 사용 현황');
  const header = node('div', 'summary-columns');
  header.append(node('span', '', '제공자'), node('span', '', '남은 한도 · 계정 평균'), node('span', '', `${PERIODS.find(([key]) => key === ctx.selectedPeriod)[1]} API 환산액`));
  list.append(header);
  for (const p of providers) {
    const row = node('article', 'summary-provider');
    const identity = node('div', 'summary-identity');
    const button = node('button', 'provider-link', p.name);
    button.dataset.focus = `provider:${p.id}`;
    button.addEventListener('click', () => ctx.select(p.id));
    const title = node('h3'); title.append(button);
    identity.append(title, node('span', '', `${p.accounts.length}개 계정`));
    const concerns = [];
    if (!p.enabled) concerns.push('연결 비활성');
    for (const [key, label] of Object.entries(STATES)) {
      const total = p.accounts.filter(a => a.status === key).length;
      if (total) concerns.push(`${label} ${total}`);
    }
    const delayed = p.accounts.filter(a => a.status === 'ok' && a.refresh?.status === 'delayed').length;
    if (delayed) concerns.push(`갱신 지연 ${delayed}`);
    if (concerns.length) identity.append(node('small', 'attention', concerns.join(' · ')));
    const stats = p.analytics?.periods?.[ctx.selectedPeriod];
    const usage = node('div', 'summary-usage');
    usage.append(metric(`${PERIODS.find(([key]) => key === ctx.selectedPeriod)[1]} 환산액`, usageAmount(stats), usageNote(stats)), recommendationView(p.analytics?.recommendation));
    row.append(identity, quotaOverview(p), usage);
    list.append(row);
  }
  if (!providers.length) list.append(node('div', 'empty', '연결된 제공자가 없습니다. OpenCodex에서 계정을 연결해 주세요.'));
  return list;
}
export function renderOrderEditor(providers, ctx) {
  const host = document.getElementById('provider-order-list');
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.orderMove : null;
  host.replaceChildren();
  providers.forEach((p, index) => {
    const row = node('div', 'order-row');
    row.append(node('span', '', p.name));
    for (const [direction, label] of [[-1, '위로'], [1, '아래로']]) {
      const button = node('button', 'order-move', label);
      button.dataset.orderMove = `${p.id}:${direction}`;
      button.setAttribute('aria-label', `${p.name} ${label}`);
      button.disabled = index + direction < 0 || index + direction >= providers.length;
      button.addEventListener('click', () => {
        const ids = providers.map(item => item.id);
        [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
        ctx.providerOrder = ids;
        try { localStorage.setItem(ctx.ORDER_KEY, JSON.stringify(ids)); ctx.orderStorageFailed = false; }
        catch { ctx.orderStorageFailed = true; }
        ctx.render();
        const buttons = [...host.querySelectorAll('button')];
        (buttons.find(b => b.dataset.orderMove === `${p.id}:${direction}` && !b.disabled) ||
          buttons.find(b => b.dataset.orderMove === `${p.id}:${-direction}` && !b.disabled))?.focus({preventScroll:true});
      });
      row.append(button);
    }
    host.append(row);
  });
  document.getElementById('provider-order-note').textContent = ctx.orderStorageFailed ? '저장할 수 없어 현재 탭에서만 유지됩니다.' : '이 브라우저에 자동 저장됩니다.';
  if (focused) [...host.querySelectorAll('button')].find(b => b.dataset.orderMove === focused && !b.disabled)?.focus({preventScroll:true});
}
