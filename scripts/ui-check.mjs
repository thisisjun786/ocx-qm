// Dashboard smoke check: serves a deterministic snapshot to a local headless
// Chromium, drives the real UI, and asserts rendered output plus a clean console.
// Needs a Chromium binary, so it stays out of `npm test`. Run: npm run check:ui
import { createApp } from '../src/server.mjs';
import { buildFixture } from './ui-fixture.mjs';
import { checkSubscriptions } from './ui-subscriptions-check.mjs';
import { openSubscriptions } from '../src/subscriptions.mjs';
import { ACCOUNT_BINDINGS } from '../src/snapshot.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.QUOTA_UI_CHECK_CHROME ??
  'chromium';

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  const pending = new Map();
  const listeners = [];
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++sequence;
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, message =>
      message.error ? reject(new Error(method + ': ' + message.error.message)) : resolve(message.result)));
  };
  return { send, on: listener => listeners.push(listener), close: () => socket.close() };
}

async function devtoolsEndpoint(child) {
  let buffered = '';
  for await (const chunk of child.stderr) {
    buffered += String(chunk);
    const match = /ws:\/\/[^\s]+/.exec(buffered);
    if (match) return match[0];
  }
  throw new Error('Chromium did not report a DevTools endpoint');
}

const failures = [];
const checks = [];
function expect(condition, description, detail) {
  checks.push(description);
  if (!condition) failures.push(detail === undefined ? description : description + ' — ' + JSON.stringify(detail));
}

const snapshot = buildFixture();
const settingsDir = await mkdtemp(join(tmpdir(), 'quota-ui-settings-'));
const subscriptions = await openSubscriptions({dataDir:settingsDir});
snapshot[ACCOUNT_BINDINGS] = new Map(snapshot.providers.flatMap(p => p.accounts.map(a => [p.id+'\0'+a.id, 'synthetic:'+p.id+':'+a.id])));
const server = createApp({subscriptions, snapshot: async () => {
  for (const p of snapshot.providers) {
  for (const a of p.accounts) {
    a.analytics.subscription = subscriptions.forAccount(p.id, a.id, snapshot[ACCOUNT_BINDINGS].get(p.id+'\0'+a.id));
  }
  p.analytics.subscriptionMonthlyUsd = p.accounts.every(a=>a.analytics.subscription.monthlyUsd!==null) ? p.accounts.reduce((sum,a)=>sum+a.analytics.subscription.monthlyUsd,0) : null;
  }
  return snapshot;
}});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'quota-ui-check-'));
const child = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, '--window-size=1280,1800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browser;

try {
  browser = await connect(await devtoolsEndpoint(child));
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => browser.send(method, params, sessionId);
  const problems = [];
  browser.on(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push('exception: ' + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      problems.push('console.' + message.params.type + ': ' + message.params.args.map(a => a.description ?? a.value).join(' '));
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      problems.push('log: ' + message.params.entry.text + ' ' + (message.params.entry.url ?? ''));
    }
  });
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: origin + '/' });

  const evaluate = async expression => {
    const { result, exceptionDetails } = await call('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(expression + ' -> ' + (exceptionDetails.exception?.description ?? exceptionDetails.text));
    return result.value;
  };
  const settle = async (expression, attempts = 60) => {
    for (let i = 0; i < attempts; i++) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  };
  const text = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent ?? null');
  const countOf = selector => evaluate('document.querySelectorAll(' + JSON.stringify(selector) + ').length');
  const clickText = async (selector, label) => {
    const clicked = await evaluate('(() => { const el = [...document.querySelectorAll(' + JSON.stringify(selector) +
      ')].find(node => node.textContent.trim().startsWith(' + JSON.stringify(label) + ')); if (!el) return false; el.click(); return true; })()');
    if (!clicked) failures.push('could not click ' + selector + ' labelled ' + label);
    return clicked;
  };

  const ready = await settle('document.querySelectorAll(".summary-provider").length || 0');
  expect(ready === snapshot.providers.length, 'overview lists every provider', { rendered: ready, expected: snapshot.providers.length });
  expect((await text('#title')) === '요약', 'title starts on the summary view', await text('#title'));
  expect((await countOf('.quota-bar')) > 0, 'quota bars render');
  expect((await countOf('.quota-bar.low')) > 0, 'a low remaining quota is marked');
  expect((await countOf('.track[role=progressbar]')) > 0, 'quota tracks expose progressbar semantics');
  expect(/일부 프로바이더/.test((await text('#notice')) ?? ''), 'server warnings reach the notice bar', await text('#notice'));
  expect(/수집$/.test(((await text('#updated')) ?? '').trim()), 'collection time is shown', await text('#updated'));
  expect(/\$/.test((await text('.summary-usage')) ?? ''), 'summary shows an API-equivalent amount', await text('.summary-usage'));
  expect(/필요 계정/.test((await text('.recommend')) ?? ''), 'recommendation reaches the summary row');
  expect((await countOf('#provider-order-list .order-row')) === snapshot.providers.length, 'order editor lists providers');

  await clickText('#period-picker button', '30일');
  const columns = await settle('document.querySelector(".summary-columns")?.textContent');
  expect(/최근 30일/.test(columns ?? ''), 'period picker switches the summary column', columns);

  await clickText('#providers button', 'OpenAI');
  const accounts = await settle('document.querySelectorAll(".account").length || 0');
  expect(accounts === 3, 'provider view renders every account', accounts);
  expect((await text('#title')) === 'OpenAI', 'title follows the selected provider', await text('#title'));
  expect(/로그인 필요/.test((await evaluate('document.querySelector(".accounts").textContent')) ?? ''), 'a reauth account is flagged');
  const delayNotes = await countOf('.refresh-note');
  expect(delayNotes === 1, 'a delayed lookup is flagged once, and not on the reauth account that already explains itself', delayNotes);
  expect((await countOf('.window')) > 0, 'quota windows render inside the account card');

  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  expect((await countOf('.spark-svg path')) > 0, 'history sparklines draw');
  expect(/API 환산액/.test((await evaluate('document.querySelector(".account-details").textContent')) ?? ''), 'account details show usage totals');

  await evaluate('document.getElementById("search").value = "계정 2"; document.getElementById("search").dispatchEvent(new Event("input"))');
  const filtered = await settle('document.querySelectorAll(".account").length || 0');
  expect(filtered === 1, 'search narrows the account list', filtered);
  await evaluate('document.getElementById("search").value = ""; document.getElementById("search").dispatchEvent(new Event("input"))');

  await clickText('#providers button', 'Anthropic');
  const conservative = await settle('document.querySelector(".provider-group")?.textContent');
  expect(/보수 추정/.test(conservative ?? ''), 'a conservatively estimated quota value is badged');
  await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true)');
  const detail = await evaluate('document.querySelector(".account-details").textContent');
  expect(/환산 못한 쿼타 변화 24%p 포함/.test(detail ?? ''), 'unpriced quota movement is disclosed with its size', detail?.slice(0, 200));
  await evaluate('document.querySelectorAll("details.provider-details").forEach(el => el.open = true)');
  const cohort = await evaluate('document.querySelector(".provider-details")?.textContent');
  expect(/개는 보수 추정/.test(cohort ?? ''), 'a provider average says how much of its cohort is conservatively estimated', cohort?.slice(0, 200));

  await clickText('#providers button', 'Ollama Cloud');
  const ollama = await settle('document.querySelector(".provider-group")?.textContent');
  expect(/연결 비활성/.test(ollama ?? ''), 'a disabled provider is labelled');
  expect(/1%p 순증가당/.test(ollama ?? ''), 'ollama per-model calibration renders');

  await clickText('#providers button', 'Cursor');
  const cursor = await settle('document.querySelector(".provider-analytics")?.textContent');
  expect(/캐시 62% 가정/.test(cursor ?? ''), 'cursor cache assumption is disclosed', cursor?.slice(0, 200));
  expect(/미환산/.test(cursor ?? ''), 'unpriced models are disclosed');

  await clickText('#providers button', '요약');
  expect(await settle('document.querySelectorAll(".summary-provider").length || 0'), 'returns to the summary view');

  const accessibility = await evaluate('[...document.querySelectorAll("button")].filter(b => !b.textContent.trim() && !b.getAttribute("aria-label")).length');
  expect(accessibility === 0, 'every button has an accessible name', accessibility);

  // --- app shell: desktop chrome, mobile drawer, breakpoint focus, state across re-render ---
  const pressTab = async (shift = false) => {
    const key = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: shift ? 8 : 0 };
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  };
  const focusId = () => evaluate('document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null');
  const escapee = () => evaluate('(() => { const el = document.activeElement;' +
    ' if (!el || el === document.body || el === document.documentElement) return null;' +
    ' return document.getElementById("sidebar").contains(el) ? null : (el.id || el.className || el.tagName); })()');
  const openDrawer = async () => {
    await evaluate('document.getElementById("menu-toggle").click()');
    return settle('document.getElementById("sidebar").classList.contains("open")');
  };

  expect(await evaluate('getComputedStyle(document.getElementById("mobile-topbar")).display === "none"'),
    'desktop hides the mobile top bar');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('getComputedStyle(document.getElementById("menu-toggle")).display !== "none"'),
    'mobile shows the menu toggle');
  expect(await settle('document.getElementById("sidebar").getBoundingClientRect().right <= 0'),
    'the closed drawer settles off-canvas');

  const topbarPadding = await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingTop)');
  const topbarBottom = await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingBottom)');
  const sidebarPadding = await evaluate('parseFloat(getComputedStyle(document.getElementById("sidebar")).paddingTop)');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47 } });
  expect(await settle('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingTop) >= ' + (topbarPadding + 47)),
    'the mobile top bar adds the emulated top safe-area inset');
  expect(await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingBottom)') === topbarBottom,
    'the top safe-area inset does not add blank space below the mobile top bar');
  expect(await settle('parseFloat(getComputedStyle(document.getElementById("sidebar")).paddingTop) >= ' + (sidebarPadding + 47)),
    'the mobile drawer adds the emulated top safe-area inset');
  expect(await evaluate('document.getElementById("menu-toggle").getBoundingClientRect().top >= 47'),
    'the menu toggle stays below the emulated top cutout');
  expect(await openDrawer(), 'the drawer opens');
  expect(await evaluate('document.getElementById("drawer-close").getBoundingClientRect().top >= 47'),
    'the drawer close button stays below the emulated top cutout');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0 } });
  await call('Emulation.setDeviceMetricsOverride', { width: 734, height: 390, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47 } });
  expect(await evaluate('document.getElementById("menu-toggle").getBoundingClientRect().left >= 47'),
    'the landscape menu toggle stays outside the left cutout');
  expect(await evaluate('parseFloat(getComputedStyle(document.getElementById("mobile-topbar")).paddingRight) >= 47'),
    'the landscape top bar reserves the right safe area');
  expect(await settle('document.getElementById("sidebar").getBoundingClientRect().left === 0'),
    'the landscape drawer finishes opening before its safe-area position is checked');
  expect(await evaluate('document.querySelector("#sidebar .brand").getBoundingClientRect().left >= 47'),
    'the landscape drawer content stays outside the left cutout');
  await call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0 } });
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  expect(await evaluate('document.getElementById("menu-toggle").getAttribute("aria-expanded") === "true"'),
    'the toggle reports its expanded state');
  expect(await evaluate('document.getElementById("sidebar").getAttribute("aria-modal") === "true"'),
    'the open drawer carries a literal aria-modal=true');
  expect(await evaluate('document.activeElement.id === "drawer-close"'),
    'opening the drawer focuses a visible control');
  expect(await evaluate('["main","mobile-topbar"].every(id => document.getElementById(id).hasAttribute("inert"))' +
    ' && document.querySelector(".skip").hasAttribute("inert")'),
    'the page, the top bar and the skip link are inert while the drawer is open');

  expect(await evaluate('(() => {' +
    ' const sel = \'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])\';' +
    ' const drawer = document.getElementById("sidebar");' +
    ' return [...document.querySelectorAll(sel)].filter(el => !el.closest("[inert]") && el.getClientRects().length > 0)' +
    '   .every(el => drawer.contains(el)); })()'),
    'every reachable control is inside the open drawer');

  const beforeTab = await focusId();
  await pressTab();
  expect(beforeTab !== (await focusId()), 'Tab actually moves focus, so the traversal checks are not vacuous', beforeTab);
  let escaped = await escapee();
  for (let i = 0; i < 11 && !escaped; i++) { await pressTab(); escaped = await escapee(); }
  expect(escaped === null, 'Tab never reaches a control behind the drawer', escaped);
  for (let i = 0; i < 8 && !escaped; i++) { await pressTab(true); escaped = await escapee(); }
  expect(escaped === null, 'Shift+Tab never reaches a control behind the drawer', escaped);

  await evaluate('document.querySelector("#providers .nav-item.active").dataset.qmMark = "drawer";' +
    ' document.getElementById("drawer-close").focus(); window.dispatchEvent(new Event("online")); true');
  expect(await settle('!document.querySelector("#providers .nav-item.active").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'a refresh completes while the drawer is open');
  expect(await evaluate('document.getElementById("sidebar").classList.contains("open") && document.getElementById("main").inert'),
    'the open drawer and background isolation survive refresh');
  expect(await evaluate('document.activeElement.id === "drawer-close"'),
    'drawer keyboard focus survives refresh');

  await evaluate('document.getElementById("sidebar").style.setProperty("--motion-normal", "5s"); document.getElementById("drawer-close").click()');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'the close button closes the drawer');
  expect(await evaluate('document.activeElement.id === "menu-toggle"'), 'closing returns focus to the toggle');
  expect(await evaluate('getComputedStyle(document.getElementById("sidebar")).visibility === "visible"'),
    'the close animation is still visible during the immediate Tab check');
  await pressTab();
  expect(await evaluate('!document.getElementById("sidebar").contains(document.activeElement)'),
    'Tab cannot re-enter a drawer while its close animation is running');
  await evaluate('document.getElementById("sidebar").style.removeProperty("--motion-normal"); document.getElementById("menu-toggle").focus()');

  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false });
  expect(await settle('document.activeElement.matches("#providers .nav-item.active")'),
    'widening with a closed drawer moves focus from the hidden menu toggle to desktop navigation');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await openDrawer();
  await evaluate('document.getElementById("drawer-scrim").click()');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'the scrim closes the drawer');

  await openDrawer();
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))');
  expect(await settle('!document.getElementById("sidebar").classList.contains("open")'), 'Escape closes the drawer');
  expect(await evaluate('!document.getElementById("main").hasAttribute("inert")'), 'closing the drawer releases the page');

  await evaluate('document.querySelector(".skip").focus()');
  expect(await evaluate('(() => { const link = document.querySelector(".skip"); const r = link.getBoundingClientRect();' +
    ' if (r.top < 0) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);' +
    ' return !!hit && link.contains(hit); })()'),
    'the focused skip link is not covered by the mobile top bar');
  await evaluate('window.scrollTo(0, document.documentElement.scrollHeight); document.querySelector(".skip").click()');
  expect(await evaluate('location.hash === "#main"'), 'the skip link activates its real main target');
  expect(await settle('document.getElementById("main").getBoundingClientRect().top >= document.getElementById("mobile-topbar").getBoundingClientRect().bottom - 1'),
    'the skip target stays below the sticky mobile top bar');
  expect(await evaluate('document.getElementById("title").getBoundingClientRect().top >= document.getElementById("mobile-topbar").getBoundingClientRect().bottom - 1'),
    'the page title remains visible after using the skip link');
  await evaluate('history.replaceState(null, "", location.pathname)');


  await openDrawer();
  await clickText('#providers button', 'OpenAI');
  expect(await settle('document.activeElement.id === "title"'), 'a mobile selection moves focus to the page title');
  expect(await evaluate('!document.getElementById("sidebar").classList.contains("open")'), 'a mobile selection closes the drawer');

  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');
  await evaluate('document.querySelector(".provider-link").click()');
  expect(await settle('document.activeElement.id === "title"'),
    'a closed-drawer provider link still lands focus on the page title');
  expect(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
    'no horizontal page overflow at 390px');

  // Real usage can exceed four figures; a fitting page must not split a currency amount.
  const originalAmounts = await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].map(el => el.textContent)');
  expect(originalAmounts.length === 3, 'the amount boundary probe has all three provider periods');
  for (const width of [320, 390, 540]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].forEach(el => { el.textContent = "$12,345.67"; })');
    const amounts = await evaluate('(() => {' +
      ' return [...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].map(el => {' +
      ' const range = document.createRange(); range.selectNodeContents(el); const rects = [...range.getClientRects()];' +
      ' const box = el.getBoundingClientRect(); return { lines: rects.length, contained: rects.every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.right <= innerWidth) }; }); })()');
    expect(amounts.length === 3 && amounts.every(a => a.lines === 1 && a.contained),
      'large provider amounts remain whole and contained at ' + width + 'px', amounts);
  }
  await evaluate('[...document.querySelectorAll(".provider-analytics > .usage-totals .metric > strong")].forEach((el, i) => { el.textContent = ' + JSON.stringify(originalAmounts) + '[i]; })');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await openDrawer();
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false });
  expect(await settle('document.activeElement.classList.contains("nav-item")'),
    'widening past the breakpoint moves focus out of the now-hidden drawer control');
  expect(await evaluate('!document.getElementById("sidebar").classList.contains("open")'),
    'widening past the breakpoint clears the drawer state');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('document.activeElement.id === "menu-toggle"'),
    'narrowing past the breakpoint moves focus off a now-hidden drawer button');
  await call('Emulation.clearDeviceMetricsOverride');

  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate('document.querySelector("#providers .nav-item.active").focus()');
  expect(await evaluate('document.activeElement.matches("#providers .nav-item.active")'),
    'desktop navigation has focus before the reduced-motion resize');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  expect(await settle('document.activeElement.id === "menu-toggle"'),
    'narrowing with reduced motion moves focus before the sidebar becomes hidden');
  await call('Emulation.clearDeviceMetricsOverride');
  expect(await settle('document.activeElement.matches("#providers .nav-item.active")'),
    'widening with reduced motion restores desktop navigation focus');
  await call('Emulation.setEmulatedMedia', { features: [] });

  // The 10-second timer takes the same render path, so drive it through the refresh button
  // and wait for the navigation node to actually be replaced before asserting anything.
  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length || 0');
  await evaluate('document.getElementById("search").value = "계정"; document.getElementById("search").dispatchEvent(new Event("input"))');
  await evaluate('document.querySelector("details.account-details").open = true');
  await evaluate('const b = document.querySelector("#providers .nav-item.active"); b.dataset.qmMark = "1"; b.focus(); true');
  await evaluate('document.getElementById("refresh").click()');
  expect(await settle('(() => { const b = document.querySelector("#providers .nav-item.active");' +
    ' return b && !b.dataset.qmMark && !document.getElementById("refresh").disabled ? true : null; })()'),
    'the refresh replaced the navigation before the preservation checks ran');
  expect(await evaluate('document.activeElement.dataset.provider === "openai"'),
    'keyboard focus survives the re-render', await focusId());
  expect(await evaluate('document.querySelector("#providers .nav-item.active").getAttribute("aria-current") === "page"'),
    'the selected destination keeps aria-current across the re-render');
  expect(await evaluate('document.getElementById("search").value === "계정"'), 'the search text survives the re-render');
  expect(await evaluate('!!document.querySelector("details.account-details[open]")'), 'an open disclosure survives the re-render');

  await evaluate('document.getElementById("search").value = ""; document.getElementById("search").dispatchEvent(new Event("input"))');
  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');


  // --- row hierarchy: one vocabulary across summary rows and account windows ---
  expect(/% 남음/.test((await text('.summary-provider .quota-caption')) ?? ''),
    'summary bars name the remaining share the way account windows do', await text('.summary-provider .quota-caption'));
  const missing = await countOf('.quota-bar.stale .quota-note');
  expect(missing > 0, 'a summary window with no eligible measurement says so in the row', missing);

  await clickText('#providers button', 'OpenAI');
  const named = await settle('document.querySelectorAll(".account-name").length || 0');
  expect(named === 3, 'the provider screen renders every account name', named);

  const badged = await evaluate('[...document.querySelectorAll(".window.stale")]' +
    '.map(w => { const b = w.querySelector(".window-title .badge"); return b ? b.textContent : null; })');
  expect(Array.isArray(badged) && badged.filter(Boolean).length === 1,
    'only a window-specific reason is badged; account-wide status stays in the heading', badged);
  expect(Array.isArray(badged) && badged.includes('리셋 후 갱신 대기'),
    'an elapsed reset on an otherwise healthy account is badged, not just dimmed', badged);
  const expiredMeta = await evaluate('(() => {' +
    ' const w = [...document.querySelectorAll(".window")].find(el => el.querySelector(".window-title .badge")?.textContent === "리셋 후 갱신 대기");' +
    ' return w?.querySelector(".window-meta").textContent; })()');
  expect(typeof expiredMeta === 'string' && !/대기/.test(expiredMeta) && /\d/.test(expiredMeta),
    'an expired reset keeps its timestamp in metadata without repeating the waiting badge', expiredMeta);
  const reauthWindow = await evaluate('(() => {' +
    ' const acc = [...document.querySelectorAll(".account")].find(a => a.textContent.includes("로그인 필요"));' +
    ' if (!acc) return null; const w = acc.querySelector(".window");' +
    ' return { badge: !!w.querySelector(".window-title .badge"), meta: w.querySelector(".window-meta").textContent }; })()');
  expect(reauthWindow && !reauthWindow.badge && /로그인/.test(reauthWindow.meta),
    'an account-wide status is stated once per window, not badged a second time', reauthWindow);

  const longName = await evaluate('(() => {' +
    ' const el = [...document.querySelectorAll(".account-name")].find(n => n.title.startsWith("장기 보관용"));' +
    ' return el ? { clipped: el.scrollWidth > el.clientWidth + 1, title: el.title, shown: el.textContent } : null; })()');
  expect(longName && longName.clipped, 'a long account name is clipped instead of pushing the row apart', longName);
  expect(longName && longName.title === longName.shown, 'the clipped name keeps its full value in its title', longName);

  const multiWindowAccount = snapshot.providers.find(p => p.id === 'anthropic').accounts[0];
  const previousObservation = multiWindowAccount.updatedAt;
  multiWindowAccount.updatedAt = new Date(Date.now() - 16 * 60000).toISOString();
  await clickText('#providers button', 'Anthropic');
  await evaluate('document.querySelector(".account").dataset.qmMark = "stale-age"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".account").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'the stale multi-window account has completed a refresh');
  expect((await countOf('.window.stale')) === 3 && (await countOf('.window-title .badge')) === 0,
    'an account-wide observation expiry does not produce repeated window warning badges');
  expect(/15분 이상 갱신 없음/.test((await text('.window-meta')) ?? ''),
    'the stale account still explains why its measurements are unavailable');
  multiWindowAccount.updatedAt = previousObservation;
  await evaluate('document.querySelector(".account").dataset.qmMark = "restoring"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".account").dataset.qmMark && !document.getElementById("refresh").disabled'),
    'the restored observation has completed a refresh');

  await clickText('#providers button', '요약');
  await settle('document.querySelectorAll(".summary-provider").length || 0');

  const fills = await evaluate('(() => { const ok = document.querySelector(".quota-bar:not(.low) .fill"); const low = document.querySelector(".quota-bar.low .fill");' +
    ' return ok && low ? [getComputedStyle(ok).backgroundColor, getComputedStyle(low).backgroundColor] : null; })()');
  expect(Array.isArray(fills) && fills[0] !== fills[1], 'healthy and low quota fills use different semantic colours', fills);

  const lightBg = await evaluate('getComputedStyle(document.documentElement).backgroundColor');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const darkBg = await settle('(() => { const c = getComputedStyle(document.documentElement).backgroundColor;' +
    ' return c === ' + JSON.stringify(lightBg) + ' ? null : c; })()');
  expect(darkBg !== null, 'light-dark() resolves a separate dark surface', { light: lightBg, dark: darkBg });
  const darkText = await evaluate('getComputedStyle(document.documentElement).color');
  expect(darkText !== darkBg, 'dark text stays distinct from the dark surface', { darkText, darkBg });

  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  expect(await settle('getComputedStyle(document.getElementById("refresh")).transitionDuration === "0s"'),
    'reduced motion removes control transitions');
  await call('Emulation.setEmulatedMedia', { features: [] });

  await clickText('#providers button', 'OpenAI');
  await settle('document.querySelectorAll(".account").length === 3');
  await checkSubscriptions({evaluate, settle, expect, call,
    replaceIdentity:async()=>snapshot[ACCOUNT_BINDINGS].set("openai\0a1","replacement-person"),
    beforeFailure: async () => {
      await evaluate(`window.qmOriginalFetch = window.fetch; window.fetch = (url, options) => String(url).endsWith('/subscriptions/selection') ? Promise.reject(new TypeError('synthetic offline')) : window.qmOriginalFetch(url, options)`);
    },
    afterFailure: async () => { await evaluate('window.fetch = window.qmOriginalFetch; delete window.qmOriginalFetch'); },
  });

  if (process.env.QUOTA_UI_EVIDENCE_DIR) {
    await mkdir(process.env.QUOTA_UI_EVIDENCE_DIR, {recursive:true});
    for (const [name, width, height] of [['desktop',1280,1000], ['tablet',768,1000], ['mobile',390,844], ['narrow',320,844]]) {
      await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width<760});
      await settle('!document.getElementById("sidebar").classList.contains("open") && (innerWidth > 760 || document.getElementById("sidebar").getBoundingClientRect().right <= 0)');
      await evaluate('window.scrollTo(0,0)');
      const capture = await call('Page.captureScreenshot', {format:'png'});
      await writeFile(join(process.env.QUOTA_UI_EVIDENCE_DIR, name+'.png'), Buffer.from(capture.data,'base64'));
      await evaluate('document.querySelector(".subscription-settings").scrollIntoView({block:"center",behavior:"instant"})');
      const controlsCapture=await call('Page.captureScreenshot',{format:"png"});
      await writeFile(join(process.env.QUOTA_UI_EVIDENCE_DIR,name+'-controls.png'),Buffer.from(controlsCapture.data,'base64'));
    }
  }
  for (const problem of problems) failures.push(problem);
  expect(problems.length === 0, 'browser console stays clean', problems);
} finally {
  const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  if (browser && child.exitCode === null) await browser.send('Browser.close').catch(() => child.kill('SIGTERM'));
  else if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  browser?.close();
  await new Promise(resolve=>server.close(resolve));
  await subscriptions.close();
  await rm(settingsDir, {recursive:true, force:true});
  await rm(profile, { recursive: true, force: true, maxRetries:5, retryDelay:100 });
}

if (failures.length) {
  console.error('ui-check failed (' + failures.length + ' of ' + checks.length + '):');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('ui-check passed: ' + checks.length + ' assertions');
