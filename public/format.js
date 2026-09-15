const number = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:1});
const count = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:0});
const money = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:2});
const smallMoney = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:6});
const clock = new Intl.DateTimeFormat('ko-KR', {hour:'2-digit', minute:'2-digit'});
const date = new Intl.DateTimeFormat('ko-KR', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
const percent = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:1});
const STATES = {stale:'갱신 필요', reauth:'로그인 확인 필요', paused:'일시 중지', unavailable:'쿼타 조회 불가'};
const PERIODS = [['fiveHour','최근 5시간'], ['weekly','최근 7일'], ['monthly','최근 30일']];

export {number, count, money, smallMoney, clock, date, percent, STATES, PERIODS};

export function age(value) {
  if (!value || !finite(Date.parse(value))) return '측정 시각 없음';
  if (Date.parse(value) > Date.now() + 60000) return '측정 시각 확인 필요';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds < 60 ? `${seconds}초 전 측정` : minutes < 60 ? `${minutes}분 전 측정` : `${Math.floor(minutes / 60)}시간 전 측정`;
}
export function reset(value) {
  if (!value || !finite(Date.parse(value))) return '리셋 미제공';
  const ms = Date.parse(value) - Date.now();
  if (ms <= 0) return '리셋 후 새 측정 대기';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : h > 0 ? `${h}시간 ${Math.floor(ms / 60000) % 60}분 후 리셋` : `${Math.max(1, Math.floor(ms / 60000))}분 후 리셋`;
}
export function until(value) {
  if (!value) return null;
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return '이미 소진';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후` : h > 0 ? `${h}시간 ${Math.floor(ms / 60000) % 60}분 후` : `${Math.max(1, Math.floor(ms / 60000))}분 후`;
}
export function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
export function usd(value) {
  if (!finite(value)) return '—';
  if (value > 0 && value < .000001) return '< $0.000001';
  return value > 0 && value < .01 ? smallMoney.format(value) : money.format(value);
}
export function windowLabel(w) {
  const labels = {'First-party models':'자체 모델', 'API usage':'API 사용'};
  return labels[w.label] || w.label;
}
