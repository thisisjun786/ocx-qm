import {node} from './dom.js';
import {finite, usd} from './format.js';

const keyOf = (provider, account) => JSON.stringify([provider, account]);
const statusLabel = basis => ({unselected:'요금제 미선택', unbound:'로그인 갱신 후 다시 선택',
  unverified:'공식 정가 미확인', stale:'정가 재확인 필요', retired:'목록에서 제외된 요금제'})[basis];

export function subscriptionState() {
  return {catalog:null, error:false, generation:0, loadSequence:0, drafts:new Map(), pending:new Set(), messages:new Map()};
}
export async function loadSubscriptions(state) {
  const generation = state.generation;
  const sequence = ++state.loadSequence;
  try {
    const response = await fetch('/api/v1/subscriptions', {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('unavailable');
    const body = await response.json();
    if (!Array.isArray(body.plans) || !Array.isArray(body.selections)) throw new Error('schema');
    if (generation !== state.generation || sequence !== state.loadSequence) return;
    state.catalog = body;
    state.error = false;
  } catch { if (generation === state.generation && sequence === state.loadSequence) state.error = true; }
}
function quote(plan) {
  return finite(plan?.monthlyUsd) ? `월 ${usd(plan.monthlyUsd)} · 공식 정가` :
    statusLabel(plan?.basis) ?? (plan?.status === 'unverified' ? '공식 정가 미확인' : '정가 확인 필요');
}
function sourceLine(plan) {
  const line = node('p', 'subscription-source');
  if (!plan) return line;
  if (plan.sourceUrl) {
    try {
      const url = new URL(plan.sourceUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const link = node('a', '', '공식 출처');
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        line.append(link);
      }
    } catch { /* A malformed source must not become an active link. */ }
  }
  const checked = Date.parse(plan.checkedAt);
  if (finite(checked)) line.append(document.createTextNode(` · ${new Intl.DateTimeFormat('ko-KR').format(checked)} 확인`));
  if (plan.note) line.append(document.createTextNode(` · ${plan.note}`));
  if (!finite(plan.monthlyUsd) && finite(plan.lastQuotedUsd)) line.append(document.createTextNode(` · 마지막 확인 정가 ${usd(plan.lastQuotedUsd)} (계산 제외)`));
  return line;
}

export function reconcileSubscriptionDrafts(state, previous, next) {
  const prior = new Map((previous?.providers ?? []).flatMap(p => p.accounts.map(a => [keyOf(p.id,a.id), a.analytics?.subscription])));
  const current = new Map(next.providers.flatMap(p => p.accounts.map(a => [keyOf(p.id,a.id), a.analytics?.subscription])));
  for (const key of new Set([...state.drafts.keys(), ...state.messages.keys()])) {
    if (!current.has(key) || (current.get(key)?.selectionContext !== prior.get(key)?.selectionContext) || (current.get(key)?.basis === 'unbound' && prior.get(key)?.basis !== 'unbound')) {
      state.drafts.delete(key); state.messages.delete(key);
    }
  }
}

export function subscriptionEditor(provider, account, ctx) {
  const state = ctx.subscriptions, key = keyOf(provider.id, account.id);
  const form = node('form', 'subscription-settings');
  form.dataset.subscription = key;
  const label = node('label', 'subscription-label', '구독 요금제');
  const select = node('select', 'subscription-select');
  select.name = 'planId'; select.dataset.focus = `subscription:${key}`;
  select.setAttribute('aria-label', `${provider.name} ${account.label} 구독 요금제`);
  label.append(select);
  const current = account.analytics?.subscription;
  const selected = state.catalog ? state.catalog.selections.find(s => s.provider === provider.id && s.account === account.id)?.planId ?? '' : current?.planId ?? '';
  const value = state.drafts.has(key) ? state.drafts.get(key) : selected;
  const plans = (state.catalog?.plans ?? []).filter(p => p.provider === provider.id && !p.retired);
  const empty = node('option', '', '미선택 · 구독료 계산 제외'); empty.value = ''; select.append(empty);
  for (const plan of plans) {
    const option = node('option', '', `${plan.label} · ${quote(plan)}`);
    option.value = plan.id; select.append(option);
  }
  if (value && !plans.some(p => p.id === value)) {
    const previous = node('option', '', `${current?.label ?? '이전 요금제'} · 목록에서 제외됨`);
    previous.value = value; previous.disabled = true; select.append(previous);
  }
  select.value = value;
  const pending = state.pending.has(key);
  select.disabled = pending || !state.catalog || state.error;
  const save = node('button', 'subscription-save', pending ? '저장 중…' : '저장');
  save.type = 'submit'; save.dataset.focus = `subscription-save:${key}`;
  save.setAttribute('aria-label', `${provider.name} ${account.label} 구독 요금제 저장`);
  const canSave = () => !pending && !state.error && !!state.catalog && state.drafts.has(key) && state.drafts.get(key) !== selected;
  save.disabled = !canSave();
  const info = node('div', 'subscription-info');
  const renderInfo = () => {
    const chosen = plans.find(p => p.id === select.value) ?? (select.value ? current : null);
    info.replaceChildren(node('p', 'sub-note', chosen ? `${chosen.label} · ${quote(chosen)}` :
      statusLabel(current?.basis) ?? '계정에서 사용하는 요금제를 선택해 주세요.'), sourceLine(chosen));
  };
  renderInfo();
  const message = node('p', 'subscription-status', state.messages.get(key)?.text ?? '');
  message.setAttribute('role', state.messages.get(key)?.error ? 'alert' : 'status');
  select.addEventListener('change', () => {
    state.drafts.set(key, select.value);
    state.messages.delete(key); message.textContent = '아직 저장하지 않았습니다.';
    save.disabled = !canSave(); renderInfo();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canSave() || state.pending.has(key)) return;
    const planId = state.drafts.get(key) || null;
    const restoreFocus = form.contains(document.activeElement);
    const stillCurrent = () => ctx.snapshot?.providers.find(p=>p.id===provider.id)?.accounts.find(a=>a.id===account.id)?.analytics?.subscription?.selectionContext === current?.selectionContext;
    state.pending.add(key); state.messages.set(key, {text:'저장 중…'}); ctx.render();
    try {
      const response = await fetch('/api/v1/subscriptions/selection', {
        method:'PUT', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(10000),
        body:JSON.stringify({provider:provider.id, account:account.id, planId, selectionContext:current?.selectionContext}),
      });
      if (!stillCurrent()) return;
      if (!response.ok) {
        const text = response.status === 409 ? '계정 연결이 바뀌었습니다. 새로고침 후 요금제를 다시 선택해 주세요.' : response.status === 422 ? '계정 연결 또는 요금제를 다시 확인하고 저장해 주세요.' :
          response.status === 404 ? '계정 목록이 바뀌었습니다. 새로고침 후 다시 선택해 주세요.' :
          response.status === 403 ? '이 주소에서는 저장할 수 없습니다. 서버 접속 주소를 확인해 주세요.' :
          '저장하지 못했습니다. 연결을 확인하고 다시 저장해 주세요.';
        state.messages.set(key, {text, error:true});
      } else {
        const subscription = await response.json();
        if (!stillCurrent()) return;
        state.generation++;
        state.drafts.delete(key);
        state.catalog.selections = state.catalog.selections.filter(s => !(s.provider === provider.id && s.account === account.id));
        if (planId) state.catalog.selections.push({provider:provider.id, account:account.id, planId});
        state.messages.set(key, {text:'저장했습니다.'});
        ctx.subscriptionSaved(provider.id, account.id, subscription);
      }
    } catch { if (stillCurrent()) state.messages.set(key, {text:'저장 결과를 확인하지 못했습니다. 다시 저장하면 같은 선택을 안전하게 적용합니다.', error:true}); }
    finally {
      state.pending.delete(key); ctx.render();
      if (restoreFocus && stillCurrent() && [document.body, document.documentElement].includes(document.activeElement)) {
        [...document.querySelectorAll('.subscription-settings')].find(el => el.dataset.subscription === key)?.querySelector('select')?.focus({preventScroll:true});
      }
    }
  });
  const controls = node('div', 'subscription-controls'); controls.append(label, save);
  form.append(controls, info, message);
  if (state.error || !state.catalog) {
    const retry = node('button', 'subscription-retry', '요금제 목록 다시 불러오기'); retry.type = 'button';
    retry.addEventListener('click', async () => { retry.disabled = true; await loadSubscriptions(state); ctx.render(); });
    form.append(node('p', 'sub-note', '요금제 목록을 불러오지 못했습니다. 기존 구독 설정은 유지됩니다.'), retry);
  } else if (!plans.length) form.append(node('p', 'sub-note', '이 제공자의 공식 월 요금제는 아직 등록되지 않았습니다.'));
  return form;
}
