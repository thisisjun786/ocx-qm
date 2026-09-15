import {subscriptionState, loadSubscriptions, reconcileSubscriptionDrafts} from './subscriptions.js';
import {finite, clock, PERIODS} from './format.js';
import {freshWindow} from './quota.js';
import {node} from './dom.js';
import {accountView, providerAnalytics, overviewView, topEfficiency, renderOrderEditor} from './views.js';

const $ = id => document.getElementById(id);
const REFRESH_MS = 10000;
// 표시명이 Quota Manager for OCX로 바뀌어도 이 브라우저에 이미 저장된 순서를 그대로 읽도록
// 호환성 식별자로 유지한다.
const ORDER_KEY = 'quota-monitor.provider-order.v1';

const ctx = {
  snapshot: null,
  subscriptions: subscriptionState(),
  subscriptionSaved: (provider, account, subscription) => {
    mutationVersion++;
    const row = ctx.snapshot?.providers.find(p => p.id === provider)?.accounts.find(a => a.id === account);
    if (row?.analytics) row.analytics.subscription = subscription;
    refresh();
  },
  selected: 'overview',
  selectedPeriod: 'weekly',
  drawerOpen: false,
  providerOrder: [],
  orderStorageFailed: false,
  ORDER_KEY,
  render: () => render(),
  select: id => select(id),
};
let busy = false;
let refreshQueued = false;
let mutationVersion = 0;
let renderedMinute = 0;
let nextRefreshAt = Date.now()+REFRESH_MS;
try {
  const saved = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
  if (Array.isArray(saved)) ctx.providerOrder = [...new Set(saved.filter(id => typeof id === 'string'))];
} catch { ctx.orderStorageFailed = true; }

function refreshStatus() {
  $('auto-refresh').textContent = busy ? '갱신 중…' : !navigator.onLine ? '연결 대기' : document.hidden ? '자동 갱신 대기' : `자동 갱신 · ${Math.max(0,Math.ceil((nextRefreshAt-Date.now())/1000))}초`;
}
const DRAWER_QUERY = window.matchMedia('(max-width: 760px)');
// 배경 격리: .skip은 .app 바깥이고 토글은 상단 바 안에 있으므로 셋 다 막아야
// Tab과 Shift+Tab이 scrim 뒤로 새지 않는다.
const background = () => [document.querySelector('.skip'), $('mobile-topbar'), $('main')];
function setDrawer(open, {restoreFocus = true} = {}) {
  const next = open && DRAWER_QUERY.matches;
  const changed = next !== ctx.drawerOpen;
  ctx.drawerOpen = next;
  const sidebar = $('sidebar');
  sidebar.classList.toggle('open', next);
  // toggleAttribute는 aria-modal=""를 만든다. 리터럴 "true"가 필요하다.
  if (next) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
  else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
  sidebar.toggleAttribute('inert', DRAWER_QUERY.matches && !next);
  $('drawer-scrim').hidden = !next;
  $('menu-toggle').setAttribute('aria-expanded', String(next));
  $('menu-toggle').setAttribute('aria-label', next ? '탐색 닫기' : '탐색 열기');
  for (const el of background()) el?.toggleAttribute('inert', next);
  document.body.classList.toggle('drawer-open', next);
  if (!changed) return;
  if (next) $('drawer-close').focus({preventScroll:true});
  else if (restoreFocus && DRAWER_QUERY.matches) $('menu-toggle').focus({preventScroll:true});
}
function select(id) {
  ctx.selected = id;
  render();
  if (DRAWER_QUERY.matches) {
    setDrawer(false, {restoreFocus:false});
    $('title').focus({preventScroll:true});
  } else $('providers').querySelector('.nav-item.active')?.focus({preventScroll:true});
  window.scrollTo({top:0, behavior:'instant'});
}
function expandedKeys() {
  return new Set([...document.querySelectorAll('details[open][data-expand]')].map(el => el.dataset.expand));
}
function restoreExpanded(keys) {
  for (const el of document.querySelectorAll('details[data-expand]')) {
    if (keys.has(el.dataset.expand)) el.open = true;
  }
}
function orderedProviders() {
  const ranks = new Map(ctx.providerOrder.map((id, index) => [id, index]));
  return ctx.snapshot.providers.map(p => p.id !== 'openai' ? p : {
    ...p,
    accounts: p.accounts.map(a => {
      const windows = a.windows.filter(w => !/\bspark\b/i.test(w.label));
      const status = ['ok', 'stale'].includes(a.status)
        ? !windows.length ? 'unavailable' : windows.some(w => !freshWindow(a, w)) ? 'stale' : 'ok'
        : a.status;
      return {...a, windows, status};
    }),
  }).sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
function render() {
  if (!ctx.snapshot) return;
  const keys = expandedKeys();
  const focused = document.activeElement;
  const focusedDetails = focused?.matches('summary') ? focused.parentElement.dataset.expand : null;
  const focusedProvider = focused?.closest('#providers button')?.dataset.provider;
  const focusedKey = focused?.dataset.focus;
  const all = orderedProviders();
  renderOrderEditor(all, ctx);
  const accounts = all.flatMap(p => p.accounts);
  const nav = $('providers');
  const navScroll = nav.scrollLeft;
  nav.replaceChildren();
  for (const p of [{id:'overview', name:'요약'}, {id:'all', name:'전체 계정', accounts}, ...all]) {
    const b = node('button', ctx.selected === p.id ? 'nav-item active' : 'nav-item', p.name);
    b.dataset.provider = p.id;
    if (ctx.selected === p.id) b.setAttribute('aria-current', 'page');
    if (p.accounts) b.append(node('span', '', p.accounts.length));
    b.addEventListener('click', () => select(p.id));
    nav.append(b);
  }
  nav.scrollLeft = navScroll;
  const overview = ctx.selected === 'overview';
  $('title').textContent = overview ? '요약' : ctx.selected === 'all' ? '전체 계정' : all.find(p => p.id === ctx.selected)?.name ?? '전체 계정';
  $('search').closest('label').hidden = overview;
  document.querySelector('.toolbar h2').textContent = overview ? '사용 현황' : '계정별 사용 현황';
  $('period-picker').hidden = !overview;
  for (const b of $('period-picker').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.period === ctx.selectedPeriod));
  topEfficiency(ctx);
  const query = $('search').value.trim().toLowerCase();
  const content = $('content');
  content.replaceChildren();
  if (overview) content.append(overviewView(all, ctx));
  let countGroups = 0;
  for (const p of all) {
    if (overview) break;
    if (ctx.selected !== 'all' && p.id !== ctx.selected) continue;
    const filtered = p.accounts.filter(a => `${a.label} ${a.plan ?? ''} ${p.name}`.toLowerCase().includes(query));
    if (query && !filtered.length) continue;
    const group = node('section', 'provider-group');
    const heading = node('div', 'group-heading');
    heading.append(node('h3', '', p.name), node('span', '', query ? `${filtered.length} / ${p.accounts.length}개 계정` : `${p.accounts.length}개 계정`));
    if (!p.enabled) heading.append(node('span', 'disabled', '연결 비활성'));
    group.append(heading);
    group.append(providerAnalytics(p, ctx));
    const list = node('div', 'accounts');
    filtered.forEach(a => list.append(accountView(p, a, ctx)));
    if (!filtered.length) list.append(node('p', 'account unavailable', '연결된 계정이 없습니다. OpenCodex에서 계정을 연결해 주세요.'));
    group.append(list);
    content.append(group);
    countGroups++;
  }
  if (!overview && !countGroups) {
    const empty = node('div', 'empty', '일치하는 계정이 없습니다');
    const clear = node('button', '', '검색 초기화');
    clear.addEventListener('click', () => { $('search').value = ''; select('all'); });
    empty.append(clear);
    content.append(empty);
  }
  const collected = ctx.snapshot.analytics?.lastCollectedAt;
  $('updated').textContent = collected && finite(Date.parse(collected)) ? `${clock.format(new Date(collected))} 수집` : '수집 시각 미확인';
  renderedMinute = Math.floor(Date.now() / 60000);
  restoreExpanded(keys);
  if (focusedDetails) [...document.querySelectorAll('details[data-expand]')].find(el=>el.dataset.expand===focusedDetails)?.querySelector('summary')?.focus({preventScroll:true});
  if (focusedProvider) [...nav.querySelectorAll('button')].find(el=>el.dataset.provider===focusedProvider)?.focus({preventScroll:true});
  if (focusedKey) [...document.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focusedKey)?.focus({preventScroll:true});
}
async function refresh() {
  if (busy) { refreshQueued = true; return; }
  busy = true;
  const version = mutationVersion;
  refreshStatus();
  $('refresh').disabled = true;
  $('refresh').setAttribute('aria-label', '새로고침 중');
  try {
    const [r] = await Promise.all([
      fetch('/api/v1/snapshot', {cache:'no-store', signal:AbortSignal.timeout(10000)}),
      loadSubscriptions(ctx.subscriptions),
    ]);
    if (!r.ok) throw new Error('unavailable');
    const data = await r.json();
    if (data.schemaVersion !== 1 || !Array.isArray(data.providers)) throw new Error('schema');
    if (version !== mutationVersion) { refreshQueued = true; return; }
    reconcileSubscriptionDrafts(ctx.subscriptions, ctx.snapshot, data);
    ctx.snapshot = data;
    render();
    const warnings = [...(data.warnings ?? [])];
    if (data.analytics?.status === 'error' || data.analytics?.usageStale) warnings.push('사용 기록 갱신 지연 · 이전 사용액 표시');
    $('notice').hidden = !warnings.length;
    $('notice').textContent = warnings.join(' ');
  } catch {
    $('notice').hidden = false;
    $('notice').textContent = ctx.snapshot ? '연결이 끊겨 이전 값을 표시합니다. 새로고침으로 다시 확인하세요.' : '불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
    if (ctx.snapshot) render();
    if (!ctx.snapshot) $('content').replaceChildren(node('div', 'empty', 'OpenCodex 연결을 확인해 주세요'));
  } finally {
    busy = false;
    nextRefreshAt = Date.now()+REFRESH_MS;
    refreshStatus();
    $('refresh').disabled = false;
    $('refresh').setAttribute('aria-label', '새로고침');
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}
$('refresh').addEventListener('click', refresh);
$('menu-toggle').addEventListener('click', () => setDrawer(!ctx.drawerOpen));
$('menu-toggle').addEventListener('blur', () => {
  // CSS can hide the toggle and blur it before the media-query change callback.
  if (!DRAWER_QUERY.matches) {
    setDrawer(false, {restoreFocus:false});
    $('providers').querySelector('.nav-item.active')?.focus({preventScroll:true});
  }
});
$('sidebar').addEventListener('blur', event => {
  // Reduced motion can hide desktop navigation before the media-query callback.
  if (DRAWER_QUERY.matches && !ctx.drawerOpen && !event.relatedTarget) $('menu-toggle').focus({preventScroll:true});
}, true);
$('drawer-close').addEventListener('click', () => setDrawer(false));
$('drawer-scrim').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && ctx.drawerOpen) setDrawer(false); });
DRAWER_QUERY.addEventListener('change', () => {
  const inDrawer = $('sidebar').contains(document.activeElement);
  const onToggle = document.activeElement === $('menu-toggle');
  const wasOpen = ctx.drawerOpen;
  setDrawer(false, {restoreFocus:false});
  if (!DRAWER_QUERY.matches) {
    // 넓어지면 닫기 버튼과 메뉴 토글이 숨겨진다. 초점을 데스크톱 탐색으로 넘긴다.
    if (wasOpen || inDrawer || onToggle) $('providers').querySelector('.nav-item.active')?.focus({preventScroll:true});
  } else if (inDrawer) {
    // 좁아지면 사이드바가 닫힌 드로어가 된다. 초점이 그 안에 갇히지 않게 토글로 옮긴다.
    $('menu-toggle').focus({preventScroll:true});
  }
});
$('search').addEventListener('input', render);
for (const button of $('period-picker').querySelectorAll('button')) button.addEventListener('click', () => { ctx.selectedPeriod = button.dataset.period; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else refreshStatus(); });
window.addEventListener('focus', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
window.addEventListener('offline', () => { refreshStatus(); if (ctx.snapshot) { render(); $('notice').hidden = false; $('notice').textContent = '오프라인 · 이전 값을 표시합니다.'; } });
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
setInterval(() => {
  if (!busy && !document.hidden && navigator.onLine && Date.now()>=nextRefreshAt) refresh();
  if (ctx.snapshot && !document.hidden && renderedMinute !== Math.floor(Date.now() / 60000)) render();
  refreshStatus();
}, 1000);
setDrawer(false, {restoreFocus:false});
refresh();
