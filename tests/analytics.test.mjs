import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openHistory } from '../src/history.mjs';
import { attributeUsage, readIdentities } from '../src/identity.mjs';
import { windowAnalytics, enrichSnapshot } from '../src/analytics.mjs';
import { WINDOW_SCOPES, resolveScope, confirmScope } from '../src/window-scope.mjs';
const HOUR = 3600000, NOW = 1800000000000, RESET = NOW + 10 * HOUR;
const identities = { labels: new Map([['openai\0pabcdef','a1'], ['openai\0paaaaaa','a2']]), plans: new Map() };
const price = row => ({ usd: row.model === 'unknown' ? null : row.usage?.outputTokens / 100, basis: 'official' });
const iso = ms => new Date(ms).toISOString();
function snapshot(at, used, reset = RESET, stale = false) {
 return { schemaVersion: 1, observedAt: iso(at), warnings: [], providers: [{id:'openai', name:'OpenAI', accounts:[
  { id:'a1',label:'Account 1',plan:'pro',status:'ok',updatedAt:iso(at),windows:[{id:'weekly',label:'주간',usedPercent:used,remainingPercent:100-used,resetAt:iso(reset),stale}]},
  { id:'a2',label:'Account 2',plan:'pro',status:'ok',updatedAt:iso(at),windows:[]},
 ]}]};
}
const entry = (id, at, options = {}) => ({requestId:id,timestamp:at,provider:'openai-pabcdef',model:'priced',usageStatus:'reported',usage:{inputTokens:100,outputTokens:100},...options});
async function fixture(t) {
 const dir = await mkdtemp(join(tmpdir(),'quota-analytics-'));
 let store = await openHistory(dir);
 t.after(async () => { store.close(); await rm(dir,{recursive:true,force:true}); });
 const file = join(dir,'usage.jsonl');
 return {dir,file,get store(){return store;},async reopen(){store.close();store=await openHistory(dir);},
  async ingest(rows){await writeFile(file,rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n');await store.ingest(file,identities,price,NOW);}};
}

test('unattributed provider names and collided labels never become selected-account usage', async t => {
 assert.deepEqual(attributeUsage({provider:'openai'},identities),{provider:'openai',account:null});
 assert.deepEqual(attributeUsage({provider:'openai-main'},identities),{provider:'openai',account:null});
 assert.deepEqual(attributeUsage({provider:'openai-pabcdef'},identities),{provider:'openai',account:'a1'});
 const f=await fixture(t);await writeFile(join(f.dir,'config.json'),JSON.stringify({codexAccounts:[{id:'a1',logLabel:'pabcdef'},{id:'a2',logLabel:'pabcdef'}]}));
 const collision=await readIdentities(f.dir);assert.equal(attributeUsage({provider:'openai-pabcdef'},collision).account,null);
});

test('missing/stale/reset/gap samples do not invent current velocity or capacity', async t => {
 const f=await fixture(t);await f.ingest([]);
 let s=snapshot(NOW,20),p=s.providers[0],a=p.accounts[0],w=a.windows[0];
 assert.equal(windowAnalytics(f.store,p,a,w,NOW).status,'collecting');
 f.store.capture(snapshot(NOW-HOUR,10),NOW-HOUR);f.store.capture(s,NOW);
 assert.equal(windowAnalytics(f.store,p,a,w,NOW).recentRatePpHour,null);
 assert.equal(windowAnalytics(f.store,p,a,{...w,stale:true},NOW).status,'stale');
 assert.equal(windowAnalytics(f.store,p,a,{...w,resetAt:iso(RESET+HOUR)},NOW).capacityApiUsd,null);
 assert.equal(windowAnalytics(f.store,p,a,{...w,resetAt:null},NOW).status,'unsupported');
});

test('incremental ingestion handles partial lines, malformed rows, replay and restart without double counting', async t => {
 const f=await fixture(t);const line=JSON.stringify(entry('one',NOW-10000));
 await writeFile(f.file,line.slice(0,20));await f.store.ingest(f.file,identities,price,NOW);
 assert.equal(f.store.stats('openai','a1',0,NOW).requests,0);
 await appendFile(f.file,line.slice(20)+'\n{bad json\n');await f.store.ingest(f.file,identities,price,NOW);
 assert.equal(f.store.get('invalidUsageLines'),1);assert.equal(f.store.stats('openai','a1',0,NOW).apiUsd,1);
 await f.reopen();await f.store.ingest(f.file,identities,price,NOW);
 assert.equal(f.store.stats('openai','a1',0,NOW).requests,1);
 await rename(f.file,f.file+'.old');await writeFile(f.file,line+'\n'+JSON.stringify(entry('two',NOW-1000))+'\n');
 await f.store.ingest(f.file,identities,price,NOW);assert.equal(f.store.stats('openai','a1',0,NOW).requests,2);
 assert.equal((await stat(join(f.dir,'history.sqlite'))).mode&0o777,0o600);
});

test('attempt costs use each physical route without adding parent usage or guessing missing account', async t => {
 const f=await fixture(t);
 await f.ingest([entry('attempts',NOW-1000,{usage:{inputTokens:999999,outputTokens:999999},attempts:[
  {...entry('unused',NOW),provider:'openai-pabcdef',usage:{inputTokens:100,outputTokens:200}},
  {...entry('unused',NOW),provider:'openai-paaaaaa',usage:{inputTokens:100,outputTokens:300}},
  {...entry('unused',NOW),provider:'openai',model:'unknown'},
 ]})]);
 assert.equal(f.store.stats('openai','a1',0,NOW).apiUsd,2);
 assert.equal(f.store.stats('openai','a2',0,NOW).apiUsd,3);
 const all=f.store.stats('openai',undefined,0,NOW);assert.equal(all.requests,3);assert.equal(all.apiUsd,5);assert.equal(all.unknownPriceRequests,1);
 assert.equal(f.store.stats('openai',null,0,NOW).requests,1);
});

test('20 percentage points in 20 minutes projects 60 pp/hour; reset timing and capacity use matched intervals', async t => {
 const f=await fixture(t);
 await f.ingest([entry('one',NOW-15*60000,{usage:{inputTokens:1,outputTokens:1000}}),entry('two',NOW-5*60000,{usage:{inputTokens:1,outputTokens:1000}})]);
 for(const [minutes,used] of [[20,10],[10,20],[0,30]])f.store.capture(snapshot(NOW-minutes*60000,used),NOW-minutes*60000);
 const s=snapshot(NOW,30),p=s.providers[0],a=p.accounts[0],w=a.windows[0];
 const r=windowAnalytics(f.store,p,a,w,NOW);
 assert.equal(r.recentRatePpHour,60);assert.equal(r.averageRatePpHour,60);
 assert.equal(r.capacityApiUsd,100);assert.equal(r.remainingApiUsd,70);assert.equal(r.matchedApiUsd,20);assert.equal(r.unexplainedDeltaPp,0);
 assert.equal(r.exhaustsAt,iso(NOW+70*60000));assert.equal(r.resetBeforeExhaustion,false);
 // The same burn rate with an imminent reset is explicitly distinguished from actual exhaustion.
 const soon=NOW+30*60000;
 const second=await fixture(t);
 for(const [minutes,used] of [[19,10],[9,20],[1,28]]) second.store.capture(snapshot(NOW-minutes*60000,used,soon),NOW-minutes*60000);
 const s2=snapshot(NOW,28,soon);const r2=windowAnalytics(second.store,s2.providers[0],s2.providers[0].accounts[0],s2.providers[0].accounts[0].windows[0],NOW);
 assert.equal(r2.resetBeforeExhaustion,true);
});

test('flat quota readings keep their costs; unattributed traffic makes capacity a partial estimate', async t => {
 const f=await fixture(t);
 await f.ingest([entry('one',NOW-15*60000),entry('two',NOW-5*60000)]);
 for(const [minutes,used] of [[20,10],[10,10],[0,20]])f.store.capture(snapshot(NOW-minutes*60000,used),NOW-minutes*60000);
 const s=snapshot(NOW,20),p=s.providers[0],a=p.accounts[0],w=a.windows[0];
 assert.equal(windowAnalytics(f.store,p,a,w,NOW).capacityApiUsd,20);
 await appendFile(f.file,JSON.stringify(entry('unattributed',NOW-1000,{provider:'openai'}))+'\n');await f.store.ingest(f.file,identities,price,NOW);
 const bound=windowAnalytics(f.store,p,a,w,NOW);assert.equal(bound.capacityApiUsd,20);assert.equal(bound.capacityBasis,'partial');assert.equal(bound.confidence,'low');assert.equal(bound.unexplainedDeltaPp,0);
});

test('rolling-period provider totals include unattributed records; account figures stay separated', async t => {
 const f=await fixture(t);await f.ingest([
  entry('a',NOW-2*HOUR),entry('b',NOW-HOUR,{provider:'openai-paaaaaa'}),entry('c',NOW-1000,{provider:'openai'}),
 ]);
 const pricing={pricingSources:[],subscriptionFor:()=>({monthlyUsd:2,label:'Test',basis:'official',sourceUrl:null,reason:null})};
 const s=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW);
 assert.equal(s.providers[0].analytics.periods.weekly.apiUsd,3);
 assert.equal(s.providers[0].accounts[0].analytics.periods.weekly.apiUsd,1);
 assert.equal(s.providers[0].analytics.unattributed.requests,1);
 assert.equal(s.providers[0].analytics.pace.projectedFiveHourUsd,7.5);
 assert.equal(s.providers[0].accounts[0].analytics.monthlyValueRatio,.5);
});

test('new reset never counts a pre-reset segment toward recent speed', async t => {
 const f=await fixture(t);await f.ingest([]);
 for(const [minutes,used,reset] of [[30,80,RESET-HOUR],[20,90,RESET-HOUR],[10,1,RESET],[0,2,RESET]])f.store.capture(snapshot(NOW-minutes*60000,used,reset),NOW-minutes*60000);
 let s=snapshot(NOW,2),p=s.providers[0],a=p.accounts[0];
 assert.equal(windowAnalytics(f.store,p,a,a.windows[0],NOW).recentRatePpHour,6);
});

test('stationary readings yield zero observed velocity, no invented exhaustion time', async t => {
 const f=await fixture(t);await f.ingest([]);
 for(const minutes of [20,10,0])f.store.capture(snapshot(NOW-minutes*60000,12),NOW-minutes*60000);
 const s=snapshot(NOW,12),p=s.providers[0],a=p.accounts[0],r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.recentRatePpHour,0);assert.equal(r.exhaustsAt,null);assert.equal(r.resetBeforeExhaustion,true);assert.equal(r.capacityApiUsd,null);
});

test('reading identical observations later does not move the exhaustion timestamp', async t => {
 const f=await fixture(t);
 for(const [m,u] of [[20,10],[10,20],[0,30]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,30).providers[0],a=p.accounts[0],w=a.windows[0];
 const first=windowAnalytics(f.store,p,a,w,NOW);
 const later=windowAnalytics(f.store,p,a,w,NOW+2*60000);
 assert.equal(later.exhaustsAt,first.exhaustsAt);
 assert.equal(later.projectedUsedAtReset,first.projectedUsedAtReset);
});

test('forecast forgets consumption before a gap or downward correction', async t => {
 const f=await fixture(t);
 for(const [m,u] of [[50,10],[40,30],[5,30],[0,30]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,30).providers[0],a=p.accounts[0];
 assert.equal(windowAnalytics(f.store,p,a,a.windows[0],NOW).recentRatePpHour,0);
 const reset=RESET+HOUR;
 const corrected=await fixture(t);
 for(const [m,u] of [[30,10],[20,30],[10,20],[0,20]]) corrected.store.capture(snapshot(NOW-m*60000,u,reset),NOW-m*60000);
 const b=snapshot(NOW,20,reset).providers[0].accounts[0];
 assert.equal(windowAnalytics(corrected.store,p,b,b.windows[0],NOW).recentRatePpHour,0);
});

test('a consumption burst leaving the hour boundary fades smoothly', async t => {
 const f=await fixture(t);
 for(let m=70;m>=0;m--) f.store.capture(snapshot(NOW-m*60000,m>=60?10:20+(60-m)/6),NOW-m*60000);
 const evaluate=at=>{const p=snapshot(at,30).providers[0],a=p.accounts[0];return windowAnalytics(f.store,p,a,a.windows[0],at);};
 const before=evaluate(NOW);
 f.store.capture(snapshot(NOW+60000,30+1/6),NOW+60000);
 const p=snapshot(NOW+60000,30+1/6).providers[0],a=p.accounts[0];
 const after=windowAnalytics(f.store,p,a,a.windows[0],NOW+60000);
 assert.ok(Math.abs(Date.parse(after.exhaustsAt)-Date.parse(before.exhaustsAt))<10*60000);
});

test('one rounded percentage point is insufficient for a finite forecast', async t => {
 const f=await fixture(t);
 for(const [m,u] of [[20,10],[10,10],[0,11]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,11).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.exhaustsAt,null); assert.equal(r.resetBeforeExhaustion,null);
 assert.equal(r.status,'collecting');
});

test('exhaustion uses the full observed history including eleven idle hours', async t => {
 const f=await fixture(t);
 for(let m=720;m>=0;m-=10) f.store.capture(snapshot(NOW-m*60000,m>=60?10:10+(60-m)/5),NOW-m*60000);
 const p=snapshot(NOW,22).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.ok(Math.abs(r.recentRatePpHour-12)<1e-9);
 assert.ok(Math.abs(r.forecastRatePpHour-1)<1e-9);
 assert.ok(Math.abs(r.forecastObservedHours-12)<1e-9);
 assert.equal(r.exhaustsAt,iso(NOW+78*HOUR));
});

test('long-term forecast retains valid prior cycles and excludes the reset crossing', async t => {
 const f=await fixture(t);
 for(const [m,u,r] of [[60,70,NOW-25*60000],[40,90,NOW-25*60000],[20,10,RESET],[0,10,RESET]]) f.store.capture(snapshot(NOW-m*60000,u,r),NOW-m*60000);
 const p=snapshot(NOW,10).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.recentRatePpHour,0);assert.equal(r.forecastRatePpHour,30);
 assert.equal(r.exhaustsAt,iso(NOW+3*HOUR));
});

test('long-term forecast uses at most seven days even for monthly quotas', async t => {
 const f=await fixture(t);
 for(let m=8*24*60;m>=0;m-=20) {
  const s=snapshot(NOW-m*60000,m>=7*24*60?0:70*(7*24*60-m)/(7*24*60));
  s.providers[0].accounts[0].windows[0].id='monthly';f.store.capture(s,NOW-m*60000);
 }
 const p=snapshot(NOW,70).providers[0],a=p.accounts[0];a.windows[0].id='monthly';
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.ok(Math.abs(r.forecastObservedHours-168)<1e-8);
 assert.ok(Math.abs(r.forecastRatePpHour-70/168)<1e-8);
});

test('seven-day boundary remains anchored when a cached snapshot is read later',()=>{
 const points=Array.from({length:506},(_,i)=>({at:NOW-(505-i)*20*60000,used:i/10,reset:RESET}));
 const store={points:(_p,_a,_w,from)=>points.filter(p=>p.at>=from),stats:()=>({})};
 const p=snapshot(NOW,50.5).providers[0],a=p.accounts[0];
 const first=windowAnalytics(store,p,a,a.windows[0],NOW),later=windowAnalytics(store,p,a,a.windows[0],NOW+2*60000);
 assert.equal(first.exhaustsAt,later.exhaustsAt);
 assert.ok(Math.abs(first.forecastObservedHours-168)<1e-8);
});

test('forecast weights elapsed time rather than uneven polling frequency', async t => {
 const sparse=await fixture(t),dense=await fixture(t);
 const used=m=>m>=30?10+(60-m)/3:20+(30-m)*2/3;
 for(const m of [60,45,30,15,0]) sparse.store.capture(snapshot(NOW-m*60000,used(m)),NOW-m*60000);
 for(const m of [60,45,30,29,28,27,20,15,10,0]) dense.store.capture(snapshot(NOW-m*60000,used(m)),NOW-m*60000);
 const p=snapshot(NOW,40).providers[0],a=p.accounts[0];
 const x=windowAnalytics(sparse.store,p,a,a.windows[0],NOW),y=windowAnalytics(dense.store,p,a,a.windows[0],NOW);
 assert.ok(Math.abs(x.forecastRatePpHour-30)<1e-9);
 assert.ok(Math.abs(x.forecastRatePpHour-y.forecastRatePpHour)<1e-9);
 assert.ok(Math.abs(Date.parse(x.exhaustsAt)-Date.parse(y.exhaustsAt))<=1);
});

test('an intervening reset breaks the run even if the old reset identifier returns', async t => {
 const f=await fixture(t);
 for(const [m,u,r] of [[30,10,RESET],[20,30,RESET],[10,1,RESET+HOUR],[0,30,RESET]]) f.store.capture(snapshot(NOW-m*60000,u,r),NOW-m*60000);
 const p=snapshot(NOW,30).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.recentRatePpHour,null);assert.equal(r.exhaustsAt,null);
});

test('expired reset cannot produce a new forecast and full quota is already exhausted', async t => {
 const f=await fixture(t);
 for(const [m,u] of [[20,98],[10,100],[0,100]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,100).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.exhaustsAt,iso(NOW));assert.equal(r.resetBeforeExhaustion,false);
 assert.equal(windowAnalytics(f.store,p,a,a.windows[0],RESET+1).exhaustsAt,null);
});

test('fresh capture survives closing and reopening the database; repeated cache timestamps are not new samples', async t => {
 const f=await fixture(t);await f.ingest([]);const s=snapshot(NOW,12);
 f.store.capture(s,NOW);f.store.capture(s,NOW+60000);await f.reopen();
 assert.equal(f.store.points('openai','a1','weekly',0).length,1);assert.equal(f.store.get('historyStartedAt'),NOW);
});

test('Claude plan is bound to matching profile account, not to whichever account is active', async t => {
 const f=await fixture(t);const credentials=join(f.dir,'claude');const {mkdir}=await import('node:fs/promises');await mkdir(credentials);
 await writeFile(join(f.dir,'config.json'),'{}');
 await writeFile(join(f.dir,'auth.json'),JSON.stringify({anthropic:{accounts:[{id:'a1',credential:{accountId:'physical-one',access:'rotated'}},{id:'a2',credential:{accountId:'physical-two',access:'other'}}]}}));
 const profile=join(f.dir,'profile.json');await writeFile(profile,JSON.stringify({oauthAccount:{accountUuid:'physical-one',organizationRateLimitTier:'default_claude_max_20x'}}));
 await writeFile(join(credentials,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'old',rateLimitTier:'default_claude_max_5x'}}));
 const identity=await readIdentities(f.dir,{claudeHome:credentials,claudeProfile:profile});
 assert.equal(identity.plans.get('anthropic\0a1'),'default_claude_max_20x');assert.equal(identity.plans.get('anthropic\0a2'),undefined);
});

test('second-level provider reset rounding does not fragment one actual quota window', async t => {
 const f=await fixture(t);await f.ingest([]);
 for(const [minutes,used,jitter] of [[20,10,1000],[10,20,-1000],[0,30,0]])f.store.capture(snapshot(NOW-minutes*60000,used,RESET+jitter),NOW-minutes*60000);
 const s=snapshot(NOW,30),p=s.providers[0],a=p.accounts[0];
 assert.equal(windowAnalytics(f.store,p,a,a.windows[0],NOW).recentRatePpHour,60);
});

test('oversized records are counted and skipped; copytruncate/regrowth uses a fingerprint', async t => {
 const f=await fixture(t);await f.ingest([entry('first',NOW-10000)]);
 const oversized='x'.repeat(1024*1024+1);
 await appendFile(f.file,oversized+'\n'+JSON.stringify(entry('second',NOW-1000))+'\n');await f.store.ingest(f.file,identities,price,NOW);
 assert.equal(f.store.get('invalidUsageLines'),1);assert.equal(f.store.stats('openai','a1',0,NOW).requests,2);
 await writeFile(f.file,JSON.stringify(entry('replacement',NOW-500))+'\n'+oversized+'\n');
 await f.store.ingest(f.file,identities,price,NOW);assert.equal(f.store.stats('openai','a1',0,NOW).requests,3);
});

test('Claude overall and Fable weekly limits match separate traffic and independent resets', async t => {
 const f = await fixture(t);
 const ids = { labels: new Map([['anthropic\0pabcdef','a1']]), plans: new Map() };
 const rows = [
  entry('f1',NOW-15*60000,{provider:'anthropic-pabcdef',model:'claude-fable-5'}),
  entry('f2',NOW-5*60000,{provider:'anthropic-pabcdef',model:'claude-fable-5-1'}),
  entry('s1',NOW-5*60000,{provider:'anthropic-pabcdef',model:'claude-sonnet-5',usage:{outputTokens:800}}),
  entry('unassigned-sonnet',NOW-5*60000,{provider:'anthropic',model:'claude-sonnet-5'}),
 ];
 await writeFile(f.file,rows.map(JSON.stringify).join('\n')+'\n');
 await f.store.ingest(f.file,ids,price,NOW);
 const snap = (minutes,used,fableUsed) => ({observedAt:iso(NOW),warnings:[],providers:[{id:'anthropic',accounts:[{
  id:'a1',label:'Claude',status:'ok',updatedAt:iso(NOW-minutes*60000),windows:[
   {id:'weekly',label:'주간',usedPercent:used,remainingPercent:100-used,resetAt:iso(RESET),stale:false},
   {id:'custom-0',label:'Fable',usedPercent:fableUsed,remainingPercent:100-fableUsed,resetAt:iso(NOW+HOUR),stale:false},
  ]}]}]});
 for (const [m,u,fu] of [[20,10,20],[10,15,30],[0,20,40]]) f.store.capture(snap(m,u,fu),NOW-m*60000);
 const enriched=enrichSnapshot(snap(0,20,40),f.store,ids,{subscriptionFor:()=>({monthlyUsd:null}),pricingSources:[]},NOW);
 const [all,fable]=enriched.providers[0].accounts[0].windows;
 assert.equal(all.label,'전체 주간');assert.equal(fable.label,'Fable 주간');assert.equal(fable.usageScope,'fable');
 assert.equal(all.analytics.matchedApiUsd,10);assert.equal(fable.analytics.matchedApiUsd,2);
 assert.equal(all.analytics.capacityApiUsd,100);assert.equal(fable.analytics.capacityApiUsd,10);
 assert.equal(all.analytics.capacityBasis,'partial');assert.equal(fable.analytics.capacityBasis,'matched');
 assert.equal(all.analytics.unexplainedDeltaPp,0);assert.equal(fable.analytics.unexplainedDeltaPp,0);
 assert.equal(all.analytics.recentRatePpHour,30);assert.equal(fable.analytics.recentRatePpHour,60);
 assert.equal(fable.analytics.exhaustsAt,iso(NOW+HOUR));assert.notEqual(all.analytics.exhaustsAt,fable.analytics.exhaustsAt);
 // The scope is now the registry entry, not an enum string.
 assert.equal(f.store.stats('anthropic','a1',0,NOW,WINDOW_SCOPES.find(s=>s.id==='fable')).requests,2);
 // It narrows rows only: the same interval without a scope still sees everything.
 assert.equal(f.store.stats('anthropic','a1',0,NOW).requests,3);
 assert.equal(windowAnalytics(f.store,{id:'anthropic'},enriched.providers[0].accounts[0],{...fable,stale:true},NOW).capacityApiUsd,null);
});

test('Ollama replay fills reference price and latency without duplicating or reassigning history', async t => {
 const f = await fixture(t);
 const r = entry('ollama-replay',NOW-1000,{provider:'ollama-cloud',model:'glm-5.3',durationMs:2300,firstOutputMs:450});
 await writeFile(f.file,JSON.stringify(r)+'\n{bad-json\n');
 await f.store.ingest(f.file,identities,()=>({usd:null,basis:'unknown'}),NOW);
 f.store.set('ollamaPricingReplayV1',false);
 await f.store.ingest(f.file,identities,row=>{assert.equal(row.timestamp,NOW-1000);return {usd:.12,basis:'official'};},NOW);
 assert.equal(f.store.stats('ollama-cloud',undefined,0,NOW).requests,1);
 assert.equal(f.store.stats('ollama-cloud',null,0,NOW).apiUsd,.12);
 const timing=f.store.db.prepare('SELECT durationMs,firstOutputMs FROM usage_timings').get();
 assert.equal(timing.durationMs,2300);assert.equal(timing.firstOutputMs,450);assert.equal(f.store.get('invalidUsageLines'),1);
 await f.reopen();assert.equal(f.store.get('ollamaPricingReplayV1'),true);
});

test('priced observation spans are scoped to the window, excluding ancient and unreported activity',async t=>{
 const f=await fixture(t);
 await f.ingest([
  entry('ancient-priced',NOW-40*24*HOUR),
  entry('old-unpriced',NOW-20*24*HOUR,{model:'unknown'}),
  entry('first-current-priced',NOW-4*24*HOUR,{usage:{inputTokens:1,outputTokens:100000}}),
  entry('last-current-priced',NOW-HOUR,{usage:{inputTokens:1,outputTokens:100000}}),
 ]);
 assert.equal(f.store.bounds('openai').since,NOW-40*24*HOUR);
 assert.equal(f.store.pricedBounds('openai',NOW-30*24*HOUR,NOW).since,NOW-4*24*HOUR);
 assert.equal(f.store.pricedBounds('openai',NOW-7*24*HOUR,NOW,'a2').since,null);
 const s=enrichSnapshot(snapshot(NOW,30),f.store,identities,{subscriptionFor:()=>({monthlyUsd:200}),pricingSources:[]},NOW);
 assert.equal(s.providers[0].analytics.pace.projectedWeekUsd,3500);
 assert.equal(s.providers[0].analytics.recommendation.observedDays,4);
 assert.equal(s.providers[0].analytics.recommendation.weeklyDemandApiUsd,3500);
});

test('history without a current reset still reports finite observation coverage',async t=>{
 const f=await fixture(t);
 for(const [m,u] of [[20,10],[10,20],[0,30]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,0,RESET+HOUR).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.ok(Number.isFinite(r.forecastObservedHours));assert.equal(r.exhaustsAt,null);
});

test('a newer unmatched quota percentage cannot borrow the old forecast timestamp',async t=>{
 const f=await fixture(t);
 for(const [m,u] of [[20,10],[10,20],[0,30]]) f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW+2*60000,90).providers[0],a=p.accounts[0];
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW+2*60000);
 assert.equal(r.exhaustsAt,null);assert.equal(r.projectedUsedAtReset,null);assert.equal(r.status,'collecting');
});

test('one fresh fully consumed measurement establishes exhaustion without a burn-rate estimate',async t=>{
 const f=await fixture(t),p=snapshot(NOW,100).providers[0],a=p.accounts[0];
 f.store.capture({providers:[p]},NOW);
 const r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.exhaustsAt,iso(NOW));assert.equal(r.resetBeforeExhaustion,false);assert.equal(r.forecastRatePpHour,null);
});

test('forecast coverage distinguishes observed time from a gap in the historical span',async t=>{
 const f=await fixture(t);
 for(const [m,u] of [[600,10],[590,20],[10,20],[0,30]])f.store.capture(snapshot(NOW-m*60000,u),NOW-m*60000);
 const p=snapshot(NOW,30).providers[0],a=p.accounts[0],r=windowAnalytics(f.store,p,a,a.windows[0],NOW);
 assert.equal(r.forecastRatePpHour,60);assert.equal(r.forecastSpanHours,10);
 assert.ok(Math.abs(r.forecastCoverage-1/30)<1e-12);
});

test('failed usage collection preserves the last observed demand instead of treating the outage as idle',async t=>{
 const f=await fixture(t);await f.ingest([entry('first',NOW-2*HOUR),entry('last',NOW-HOUR)]);
 const pricing={subscriptionFor:()=>({monthlyUsd:200}),pricingSources:[]};
 const before=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW);
 const later=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW+HOUR,'collection-failed');
 assert.equal(later.providers[0].analytics.pace.usdPerHour,before.providers[0].analytics.pace.usdPerHour);
 assert.equal(later.providers[0].analytics.pace.observedAt,iso(NOW));assert.equal(later.providers[0].analytics.pace.stale,true);
 assert.equal(later.analytics.usageObservedAt,iso(NOW));
});

test('a five-hour limit cannot be worth more than the weekly limit that contains it', async t => {
 const f = await fixture(t);
 // The five-hour window moves in short bursts and the weekly window over days, so
 // each is calibrated from a different run set. Here the short window alone would
 // read 200 usd per 100%p while the weekly window reads 50 — impossible, because
 // spending 200 usd inside five hours would have taken the weekly window past 100%.
 const rows = [
  entry('w1', NOW - 200 * 60000, { provider: 'anthropic-pabcdef', model: 'priced', usage:{inputTokens:100,outputTokens:500} }),
  entry('s1', NOW - 20 * 60000, { provider: 'anthropic-pabcdef', model: 'priced', usage:{inputTokens:100,outputTokens:200} }),
 ];
 await writeFile(f.file, rows.map(JSON.stringify).join('\n') + '\n');
 const ids = { labels: new Map([['anthropic\0pabcdef','a1']]), plans: new Map() };
 await f.store.ingest(f.file, ids, price, NOW);
 const snap = (at, weekUsed, shortUsed) => ({observedAt:iso(at),warnings:[],providers:[{id:'anthropic',accounts:[{
  id:'a1',label:'Claude',status:'ok',updatedAt:iso(at),windows:[
   {id:'five-hour',label:'5시간',usedPercent:shortUsed,remainingPercent:100-shortUsed,resetAt:iso(NOW+HOUR),stale:false},
   {id:'weekly',label:'주간',usedPercent:weekUsed,remainingPercent:100-weekUsed,resetAt:iso(RESET),stale:false},
  ]}]}]});
 for (const [m, week, short] of [[210,0,0],[195,10,0],[30,10,0],[25,10,0],[10,10,1],[0,10,1]]) f.store.capture(snap(NOW-m*60000, week, short), NOW-m*60000);
 const enriched = enrichSnapshot(snap(NOW,10,1), f.store, ids, {subscriptionFor:()=>({monthlyUsd:null}),pricingSources:[]}, NOW);
 const [short, weekly] = enriched.providers[0].accounts[0].windows;
 assert.ok(short.analytics.capacityApiUsd <= weekly.analytics.capacityApiUsd,
  `five-hour ${short.analytics.capacityApiUsd} must not exceed weekly ${weekly.analytics.capacityApiUsd}`);
 assert.equal(short.analytics.capacityApiUsd, weekly.analytics.capacityApiUsd);
 assert.equal(short.analytics.remainingApiUsd, weekly.analytics.capacityApiUsd * short.remainingPercent / 100);
 assert.match(short.analytics.capacityReason, /성립할 수 없습니다/);
 assert.equal(short.analytics.confidence, 'low');
});

test('a window publishes dollars only once its model set is confirmed by observation', () => {
 for (const entry of WINDOW_SCOPES) {
  if (!entry.models?.length) continue;
  const verdict = confirmScope(entry.confirmation);
  if (entry.id === 'cursor-api') { assert.equal(verdict.confirmed, false); continue; }
  assert.equal(verdict.confirmed, true, entry.id + ' ships a model set without passing confirmation');
 }
 assert.equal(confirmScope(undefined).confirmed, false);
 assert.equal(confirmScope({at:'x',spendHours:1,movedPp:0,control:'c',controlMovedPp:0}).confirmed, false);
 assert.equal(confirmScope({at:'x',spendHours:1,movedPp:1,control:'c',controlHours:1,controlMovedPp:0.5}).confirmed, false);
 // A control that observed no hours proves nothing, so it cannot ratify a mapping.
 assert.equal(confirmScope({at:'x',spendHours:1,movedPp:4,control:'c',controlHours:0,controlMovedPp:0}).confirmed, false);
 assert.equal(confirmScope({at:'x',spendHours:1,movedPp:4,control:'c',controlHours:3,controlMovedPp:0}).confirmed, true);
});

test('cursor first-party and API windows are scoped to disjoint model sets', () => {
 const provider = {id:'cursor'};
 const first = resolveScope(provider, {id:'custom-0', label:'First-party models'});
 const api = resolveScope(provider, {id:'custom-1', label:'API usage'});
 assert.equal(first.id, 'cursor-first-party');
 assert.equal(api.id, 'cursor-api');
 assert.equal(api.exclude, true);
 assert.deepEqual(first.models, api.models);
 // Neither joins the published window identity, so saved group keys and pins survive.
 assert.equal(first.emitScope, undefined);
 assert.equal(api.emitScope, undefined);
 assert.equal(resolveScope(provider, {id:'custom-2', label:'Something new'}), null);
 assert.equal(resolveScope(provider, {id:'monthly', label:'월간'}).id, 'all');
});

const PERIOD_HOURS=[['oneHour',1],['fiveHour',5],['twentyFourHour',24],['weekly',168],['monthly',720]];
const LEGACY_PERIOD_FIELDS=['requests','tokens','inputTokens','outputTokens','cachedTokens','pricedRequests','apiUsd',
 'unknownPriceRequests','localPriceRequests','cacheEstimatedRequests','estimatedCachedTokens','noCacheApiUsd'];
const pricing={pricingSources:[],subscriptionFor:()=>({monthlyUsd:2,label:'Test',basis:'official',sourceUrl:null,reason:null})};
const ingestAt=async(f,rows,at)=>{await writeFile(f.file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await f.store.ingest(f.file,identities,price,at);};
const accountPeriods=(f,at=NOW,error=null)=>enrichSnapshot(snapshot(at,20),f.store,identities,pricing,at,error).providers[0].accounts[0].analytics.periods;

test('five usage periods nest inside one anchored boundary', async t => {
 const f=await fixture(t);
 // One anchor row shared by all five periods, then each period's own start and
 // start+1ms. Every requestId differs: the stored row id hashes it, so a repeated
 // id would overwrite instead of adding a row.
 const rows=[entry('anchor',NOW),entry('after',NOW+1)];
 for(const [key,hours] of PERIOD_HOURS)rows.push(entry('start-'+key,NOW-hours*HOUR),entry('inside-'+key,NOW-hours*HOUR+1));
 await f.ingest(rows);
 const a=accountPeriods(f);
 // Each row prices at outputTokens/100 = $1 in this fixture, so dollars track the count.
 assert.deepEqual(PERIOD_HOURS.map(([key])=>a[key].requests),[2,4,6,8,10]);
 assert.deepEqual(PERIOD_HOURS.map(([key])=>a[key].apiUsd),[2,4,6,8,10]);
 for(const [key,hours] of PERIOD_HOURS){
  assert.equal(a[key].hours,hours,key);
  assert.equal(a[key].startedAt,iso(NOW-hours*HOUR),key);
  assert.equal(a[key].endedAt,iso(NOW),key);
 }
 // A wrong span in the period table shows up here as a break in the ordering.
 for(let i=1;i<PERIOD_HOURS.length;i++)for(const field of ['requests','tokens','apiUsd'])
  assert.ok(a[PERIOD_HOURS[i][0]][field]>=a[PERIOD_HOURS[i-1][0]][field],PERIOD_HOURS[i][0]+'.'+field);
});

test('the period start is exclusive and the period end is inclusive', async t => {
 // Isolated single-row stores: with rows on both edges, treating the start as
 // inclusive and the end as exclusive cancels out and every count still matches.
 const onStart=await fixture(t);await onStart.ingest([entry('on-start',NOW-HOUR)]);
 const onEnd=await fixture(t);await onEnd.ingest([entry('on-end',NOW)]);
 assert.equal(accountPeriods(onStart).oneHour.requests,0);
 assert.equal(accountPeriods(onEnd).oneHour.requests,1);
});

test('a one-day period is the trailing 24 hours, not a calendar date', async t => {
 // Just past midnight in UTC, then just past midnight in KST. A calendar-day
 // aggregation would drop the row that fell before midnight; a trailing one keeps it.
 for(const midnight of [Date.UTC(2027,0,15,0,0,30),Date.UTC(2027,0,14,15,0,30)]){
  const f=await fixture(t);
  await ingestAt(f,[entry('before-midnight',midnight-23*HOUR),entry('a-day-and-a-ms-ago',midnight-24*HOUR-1)],midnight);
  const a=accountPeriods(f,midnight);
  assert.equal(a.twentyFourHour.requests,1,new Date(midnight).toISOString());
  assert.equal(a.twentyFourHour.startedAt,iso(midnight-24*HOUR));
  assert.equal(a.twentyFourHour.endedAt,iso(midnight));
 }
});

test('log coverage reports the retained sample span and separates a real zero from no record', async t => {
 const empty=await fixture(t);await empty.ingest([]);
 assert.deepEqual(PERIOD_HOURS.map(([k])=>accountPeriods(empty)[k].logCoverageHours),[0,0,0,0,0]);
 assert.deepEqual(PERIOD_HOURS.map(([k])=>accountPeriods(empty)[k].requests),[0,0,0,0,0]);
 const short=await fixture(t);await short.ingest([entry('first',NOW-2*HOUR)]);
 assert.deepEqual(PERIOD_HOURS.map(([k])=>accountPeriods(short)[k].logCoverageHours),[1,2,2,2,2]);
 assert.deepEqual(PERIOD_HOURS.map(([k])=>accountPeriods(short)[k].hours),[1,5,24,168,720]);
 // A retained row makes the span full, but one first read is not two hours of
 // watching, so this alone must not be read as a confirmed idle hour.
 const idle=await fixture(t);await idle.ingest([entry('older',NOW-10*HOUR)]);
 assert.equal(accountPeriods(idle).oneHour.requests,0);
 assert.equal(accountPeriods(idle).oneHour.logCoverageHours,1);
 assert.equal(accountPeriods(idle).oneHour.observedCoverageHours,0);
 // A row stamped ahead of the read cannot make the covered span negative.
 const ahead=await fixture(t);await ahead.ingest([entry('ahead',NOW+30000)]);
 assert.deepEqual(PERIOD_HOURS.map(([k])=>accountPeriods(ahead)[k].logCoverageHours),[0,0,0,0,0]);
});

test('log coverage is the span of the kept log, not proof that this account was watched', async t => {
 const f=await fixture(t);await f.ingest([entry('another-provider',NOW-10*HOUR)]);
 const s=snapshot(NOW,20);
 s.providers.push({id:'anthropic',name:'Anthropic',accounts:[{id:'new',label:'Added today',status:'ok',updatedAt:iso(NOW),windows:[]}]});
 const fresh=enrichSnapshot(s,f.store,identities,pricing,NOW).providers[1].accounts[0].analytics.periods;
 // The only row belongs to a different provider, so a full span here says the log
 // reaches back ten hours, never that this account was observed for ten hours.
 assert.equal(fresh.twentyFourHour.logCoverageHours,10);
 assert.equal(fresh.twentyFourHour.requests,0);
});

test('a failed collection freezes every period at the last successful read', async t => {
 const f=await fixture(t);await f.ingest([entry('before',NOW-30*60000)]);
 const healthy=accountPeriods(f);
 // Written after the last successful read, so it belongs to no period yet.
 f.store.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('later',NOW+30*60000,'openai','a1','m',1,1,0,2,5,'official');
 const failed=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW+HOUR,new Error('read failed'));
 const periods=failed.providers[0].accounts[0].analytics.periods;
 assert.equal(failed.analytics.status,'error');assert.equal(failed.analytics.usageStale,true);
 for(const [key] of PERIOD_HOURS){
  assert.equal(periods[key].endedAt,iso(NOW),key);
  assert.equal(periods[key].requests,healthy[key].requests,key);
 }
});

test('a read timestamp ahead of the clock or missing entirely still bounds the periods', async t => {
 const f=await fixture(t);await f.ingest([entry('one',NOW-30*60000)]);
 f.store.set('usageReadAt',NOW+60000);
 let out=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW);
 assert.equal(out.providers[0].accounts[0].analytics.periods.oneHour.endedAt,iso(NOW));
 assert.equal(out.providers[0].analytics.pace.observedAt,iso(NOW));
 // usageObservedAt stays the raw recorded read, so it is not always the boundary.
 assert.equal(out.analytics.usageObservedAt,iso(NOW+60000));
 f.store.db.prepare('DELETE FROM meta WHERE key=?').run('usageReadAt');
 out=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW);
 assert.equal(out.providers[0].accounts[0].analytics.periods.oneHour.endedAt,iso(NOW));
 assert.equal(out.analytics.usageObservedAt,null);
});

test('provider period totals contain the account totals plus the unattributed remainder', async t => {
 const f=await fixture(t);await f.ingest([
 entry('a',NOW-2*HOUR),entry('b',NOW-HOUR+1,{provider:'openai-paaaaaa'}),entry('c',NOW-1000,{provider:'openai'}),
  entry('d',NOW-2*HOUR+1,{provider:'openai'}),
]);
const p=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW).providers[0];
 for(const [key] of PERIOD_HOURS){
  const total=p.analytics.periods[key],owned=p.accounts.map(a=>a.analytics.periods[key]);
  assert.equal(total.requests,owned.reduce((n,a)=>n+a.requests,0)+total.unattributedRequests,key);
  if(total.apiUsd!==null)assert.equal(total.apiUsd,owned.reduce((n,a)=>n+(a.apiUsd??0),0)+(total.unattributedApiUsd??0),key);
 }
// An hour with no unattributed call leaves the amount unknown rather than zero.
 assert.equal(p.analytics.periods.oneHour.unattributedRequests,1);
 assert.equal(p.analytics.periods.oneHour.unattributedApiUsd,1);
 const quiet=await fixture(t);await quiet.ingest([entry('only-owned',NOW-1000)]);
 const owned=enrichSnapshot(snapshot(NOW,20),quiet.store,identities,pricing,NOW).providers[0].analytics.periods.oneHour;
 assert.equal(owned.unattributedRequests,0);assert.equal(owned.unattributedApiUsd,null);
 assert.equal(p.analytics.periods.weekly.unattributedRequests,p.analytics.unattributed.requests);
});

// Hand-calculated from the seven rows below, one bucket at a time. Each entry is
// [requests, tokens, apiUsd] for the provider, the listed accounts, the rows no
// account claims, and the rows of an account the snapshot does not list.
const RECONCILE_ROWS=[
 ['r1',0.5,'openai-pabcdef',10,100],['r2',3,'openai-paaaaaa',20,200],['r3',10,'openai',30,400],
 ['r4',40,'openai-paaaaaa',40,800],['r5',100,'openai-pabcdef',50,1600],
 ['r6',200,'openai-pabcdef',60,3200],['r7',400,'openai-paaaaaa',70,6400],
].map(([id,hours,provider,inputTokens,outputTokens])=>
 entry(id,NOW-hours*HOUR,{provider,usage:{inputTokens,outputTokens}}));
const WITHOUT_A2={
 oneHour:[[1,110,1],[1,110,1],[0,0,null],[0,0,null]],
 fiveHour:[[2,330,3],[1,110,1],[0,0,null],[1,220,2]],
 twentyFourHour:[[3,760,7],[1,110,1],[1,430,4],[1,220,2]],
 weekly:[[5,3250,31],[2,1760,17],[1,430,4],[2,1060,10]],
 monthly:[[7,12980,127],[3,5020,49],[1,430,4],[3,7530,74]],
};
const WITH_BOTH={
 oneHour:[[1,110,1],[1,110,1],[0,0,null],[0,0,null]],
 fiveHour:[[2,330,3],[2,330,3],[0,0,null],[0,0,null]],
 twentyFourHour:[[3,760,7],[2,330,3],[1,430,4],[0,0,null]],
 weekly:[[5,3250,31],[4,2820,27],[1,430,4],[0,0,null]],
 monthly:[[7,12980,127],[6,12550,123],[1,430,4],[0,0,null]],
};
const partition=p=>[[p.requests,p.tokens,p.apiUsd],
 [p.listedAccountRequests,p.listedAccountTokens,p.listedAccountApiUsd],
 [p.unattributedRequests,p.unattributedTokens,p.unattributedApiUsd],
 [p.unlistedAccountRequests,p.unlistedAccountTokens,p.unlistedAccountApiUsd]];

test('every retained call is explained whether or not its account is still listed', async t => {
 const f=await fixture(t);await f.ingest(RECONCILE_ROWS);
 const read=accounts=>{
  const s=snapshot(NOW,20);s.providers[0].accounts=accounts.map(id=>({...s.providers[0].accounts.find(a=>a.id===id)}));
  return enrichSnapshot(s,f.store,identities,pricing,NOW).providers[0].analytics.periods;
 };
 for(const [label,accounts,table] of [['a2 removed',['a1'],WITHOUT_A2],['both listed',['a1','a2'],WITH_BOTH]]){
  const periods=read(accounts);
  for(const [key] of PERIOD_HOURS){
   assert.deepEqual(partition(periods[key]),table[key],label+' '+key);
   const p=periods[key];
   // The three parts are queried separately, so this is an independent identity.
   assert.equal(p.requests,p.listedAccountRequests+p.unattributedRequests+p.unlistedAccountRequests,label+' '+key);
   assert.equal(p.tokens,p.listedAccountTokens+p.unattributedTokens+p.unlistedAccountTokens,label+' '+key);
   // A partitioned SUM of doubles is not bit-associative, so amounts are compared
   // with a magnitude-aware tolerance. Whole-dollar fixtures still land exactly.
   const parts=(p.listedAccountApiUsd??0)+(p.unattributedApiUsd??0)+(p.unlistedAccountApiUsd??0);
   assert.ok(Math.abs(parts-(p.apiUsd??0))<=1e-9*Math.max(1,Math.abs(p.apiUsd??0)),label+' '+key);
  }
 }
 // A snapshot that repeats an account id cannot double-count against the provider.
 const repeated=read(['a1','a1']);
 for(const [key] of PERIOD_HOURS) assert.deepEqual(partition(repeated[key]),WITHOUT_A2[key],'repeated '+key);
});

test('the three original period keys keep every field a schemaVersion 1 reader already used', async t => {
 const f=await fixture(t);await f.ingest([entry('a',NOW-2*HOUR)]);
 const out=enrichSnapshot(snapshot(NOW,20),f.store,identities,pricing,NOW);
 const analytics=out.providers[0].accounts[0].analytics;
 assert.equal(out.schemaVersion,1);
 for(const key of ['fiveHour','weekly','monthly'])for(const field of LEGACY_PERIOD_FIELDS)
  assert.ok(field in analytics.periods[key],key+'.'+field);
 for(const field of ['usdPerHour','projectedFiveHourUsd','projectedWeekUsd','observedHours','observedAt','stale','pricedCoverage'])
  assert.ok(field in analytics.pace,field);
 // The projections keep resting on the seven-day sample whichever period is read.
 assert.equal(analytics.pace.basisPeriod,'weekly');
});

test('successfully reading an empty log is observation; a log that was missing is not', async t => {
 const START=NOW-2*HOUR;
 // Same present snapshot, different real read histories. The file never changes, so
 // two reads two hours apart establish the same interval 721 reads would.
 const watched=await fixture(t);
 await ingestAt(watched,[],START);await ingestAt(watched,[],NOW);
 const missing=await fixture(t);
 await rm(missing.file,{force:true});
 await assert.rejects(missing.store.ingest(missing.file,identities,price,START),{code:'ENOENT'});
 await ingestAt(missing,[],NOW);
 const seen=accountPeriods(watched),unread=accountPeriods(missing);
 assert.equal(seen.oneHour.requests,0);assert.equal(seen.oneHour.observedCoverageHours,1);
 assert.equal(seen.fiveHour.observedCoverageHours,2);
 // The retained log holds nothing either way, so only the observation tells them apart.
 assert.equal(seen.oneHour.logCoverageHours,0);assert.equal(unread.oneHour.logCoverageHours,0);
 for(const [key] of PERIOD_HOURS) assert.equal(unread[key].observedCoverageHours,0,key);
 assert.notEqual(seen.oneHour.observedCoverageHours,unread.oneHour.observedCoverageHours);
});

test('a deliberate history reset bounds the observed span instead of covering the gap', async t => {
 const f=await fixture(t);
 await ingestAt(f,[],NOW-2*HOUR);
 f.store.set('historyResetAt',NOW-30*60000);
 await ingestAt(f,[],NOW);
 const a=accountPeriods(f);
 // Half an hour of the last hour lies before the reset, so only half is covered.
 assert.equal(a.oneHour.observedCoverageHours,0.5);
 assert.equal(a.fiveHour.observedCoverageHours,0.5);
});
