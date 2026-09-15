import {finite, usd, count} from './format.js';

export function freshWindow(account, window) {
  const observed = Date.parse(account.updatedAt), now = Date.now();
  return !['reauth', 'paused', 'unavailable'].includes(account.status) && !window.stale &&
    finite(observed) && now - observed <= 15 * 60000 && observed - now <= 60000 &&
    finite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
    (!window.resetAt || (finite(Date.parse(window.resetAt)) && Date.parse(window.resetAt) > now));
}
export function measurementReason(account, window) {
  if (account.status === 'reauth') return '로그인 확인 필요';
  if (account.status === 'paused') return '일시 중지';
  const now = Date.now(), observed = Date.parse(account.updatedAt), resetAt = Date.parse(window.resetAt);
  if (!finite(observed) || observed > now + 60000) return '측정 시각 확인 필요';
  if (finite(resetAt) && resetAt <= now) return '리셋 후 갱신 대기';
  if (now - observed > 15 * 60000) return '15분 이상 갱신 없음';
  return '측정값 확인 필요';
}
export function lookupDelay(account) {
  if (account.refresh?.status !== 'delayed' || ['reauth','paused'].includes(account.status)) return null;
  const wait = Date.parse(account.refresh.nextAttemptAt) - Date.now();
  const retry = !finite(wait) || wait <= 0 ? '재시도 대기' : wait < 60000 ? `${Math.ceil(wait / 1000)}초 후 재시도` : `${Math.ceil(wait / 60000)}분 후 재시도`;
  return `갱신 지연 · ${retry}`;
}
export function usageAmount(stats) {
  if (!stats || !finite(stats.apiUsd)) return '—';
  return usd(stats.apiUsd);
}
export function usageNote(stats) {
  if (!stats) return '기록 없음';
  if (!stats.requests) return '호출 없음';
  if (!finite(stats.apiUsd)) return '단가 미확인';
  return (stats.unknownPriceRequests > 0 ? '일부' : `${count.format(stats.requests)}회 호출`) + (stats.cacheEstimatedRequests > 0 ? ' · 캐시 추정' : '');
}
export function coverage(stats, pace) {
  if (!stats) return 0;
  if (pace && finite(pace.pricedCoverage)) return pace.pricedCoverage;
  if (!stats.requests) return 0;
  return stats.pricedRequests / stats.requests;
}
