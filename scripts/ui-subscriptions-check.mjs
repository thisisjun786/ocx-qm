// Browser flow assertions, called by the existing synthetic dashboard harness.
export async function checkSubscriptions({evaluate, settle, expect, call, beforeFailure, afterFailure, replaceIdentity}) {
  const first = 'document.querySelector(".subscription-select")';
  const save = 'document.querySelector(".subscription-save")';
  expect(await settle(`${first}?.options.length > 1`), 'official plan options loaded');
  expect(await evaluate(`${first}.value === ''`), 'fresh accounts start unselected');
  expect(await evaluate(`${first}.getAttribute('aria-label').includes('계정 1')`), 'plan select names its account');
  expect(await evaluate('document.querySelectorAll("input[type=number]").length === 0'), 'no manual subscription amount field');
  await evaluate(`${first}.value='openai:plus'; ${first}.dispatchEvent(new Event('change')); ${first}.focus()`);
  expect(await evaluate(`!${save}.disabled`), 'changing a plan enables save');
  await evaluate('document.querySelector(".subscription-settings").dataset.probe="draft"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".subscription-settings").dataset.probe && !document.getElementById("refresh").disabled'), 'poll render completed with draft');
  expect(await evaluate(`${first}.value === 'openai:plus' && document.activeElement === ${first}`), 'draft and keyboard focus survive refresh');
  await evaluate(`${save}.focus(); ${save}.click()`);
  expect(await settle('document.querySelector(".subscription-status")?.textContent === "저장했습니다." && !document.getElementById("refresh").disabled'), 'plan save completes and refreshes');
  expect(await evaluate(`${first}.value === 'openai:plus'`), 'saved plan remains selected');
  expect(await evaluate(`document.activeElement === ${first}`), 'keyboard save restores focus to the plan select');
  expect(await evaluate('document.querySelectorAll(".subscription-select")[1].value === ""'), 'saving one account does not select another');
  expect(await evaluate('document.querySelector(".subscription-info").textContent.includes("$20") && document.querySelector(".subscription-source a").href.startsWith("https://")'), 'selected plan shows official price and source');

  await beforeFailure();
  await evaluate(`${first}.value='openai:pro-5x'; ${first}.dispatchEvent(new Event('change')); ${save}.click()`);
  expect(await settle('document.querySelector(".subscription-status[role=alert]")?.textContent.length > 0'), 'failed save exposes an inline error');
  expect(await evaluate(`${first}.value === 'openai:pro-5x' && !${save}.disabled`), 'failed save retains draft and enables retry');
  await afterFailure();
  await evaluate(`${save}.click()`);
  expect(await settle('document.querySelector(".subscription-status")?.textContent === "저장했습니다." && !document.getElementById("refresh").disabled'), 'retry saves the retained choice');

  await call('Page.reload');
  expect(await settle('document.querySelectorAll(".summary-provider").length > 0'), 'page reload completes');
  await evaluate('[...document.querySelectorAll("#providers button")].find(b=>b.dataset.provider==="openai").click()');
  expect(await settle(`${first}?.value === 'openai:pro-5x'`), 'saved plan survives a page reload');
  for (const width of [320,390,768,1280]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:width<760});
    expect(await evaluate('document.documentElement.scrollWidth <= innerWidth+1 && [...document.querySelectorAll(".subscription-select,.subscription-save")].every(e=>e.getBoundingClientRect().right<=innerWidth+1)'), 'subscription controls fit '+width+'px');
    if (width<760) expect(await evaluate(`${first}.getBoundingClientRect().height>=44 && ${save}.getBoundingClientRect().height>=44`), 'subscription controls have mobile touch targets at '+width+'px');
  }
  await call('Emulation.clearDeviceMetricsOverride');
  await evaluate(`window.qmOriginalFetch=window.fetch; window.qmHeld=null; window.fetch=async (url, options)=>{
    const response=await window.qmOriginalFetch(url,options);
    if(String(url).endsWith('/subscriptions/selection')) {window.qmHeld=true; await new Promise(resolve=>window.qmRelease=resolve);}
    return response;
  }`);
  await evaluate(`${first}.value='openai:plus'; ${first}.dispatchEvent(new Event('change')); ${save}.click()`);
  expect(await settle('window.qmHeld===true'), 'successful response held after DB write');
  await replaceIdentity();
  await evaluate('document.querySelector(".subscription-settings").dataset.probe="replacement"; document.getElementById("refresh").click()');
  expect(await settle('!document.querySelector(".subscription-settings").dataset.probe && !document.getElementById("refresh").disabled'), 'replacement identity has rendered');
  expect(await evaluate(`${first}.value === ''`), 'replacement does not inherit selection');
  await evaluate('window.qmRelease(); window.fetch=window.qmOriginalFetch; delete window.qmOriginalFetch');
  expect(await settle(`!${first}.disabled`), 'held response completes');
  expect(await evaluate(`${first}.value === '' && !document.querySelector('.subscription-status').textContent.includes('저장했습니다')`), 'late response cannot restore prior identity selection or message');
  await evaluate(`${first}.value='openai:plus'; ${first}.dispatchEvent(new Event('change')); ${save}.click()`);
  expect(await settle('document.querySelector(".subscription-status")?.textContent === "저장했습니다." && !document.getElementById("refresh").disabled'), 'replacement requires and saves its own new choice');

  await evaluate(`${first}.value=''; ${first}.dispatchEvent(new Event('change')); ${save}.click()`);
  expect(await settle('document.querySelector(".subscription-status")?.textContent === "저장했습니다." && !document.getElementById("refresh").disabled'), 'clearing a selection saves');
  expect(await evaluate(`${first}.value === '' && document.querySelector('.subscription-info').textContent.includes('미선택')`), 'cleared choice shows unselected state');
}
