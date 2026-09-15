import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from '../src/history.mjs';
import { parseOllamaUsage, calibrateOllama, createOllamaMonitor } from '../src/ollama.mjs';
const M=60000, NOW=1800000000000;
const limits=(used,count,extra={})=>({session:{used,models:{'glm-5.3':count,...extra}}});
const observations=Array.from({length:6},(_,i)=>({at:NOW+i*M,limits:limits(i*.1,i)}));
const rows=Array.from({length:5},(_,i)=>({at:NOW+(i+1)*M,model:'glm-5.3',input:100,output:20,usd:.1}));
test('Ollama fractions retain precision and unavailable windows stay absent',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(parseOllamaUsage({limits:{session:{usage:.001,models:[{name:'x',request_count:2}]},weekly:{usage:0}}}))),{session:{used:.1,models:{x:2}},weekly:{used:0,models:{}}});
 assert.throws(()=>parseOllamaUsage({limits:{monthly:{usage:'0.1'}}}));
});
test('isolated single-model counter matches calibrate workload mix without invented GPU seconds',()=>{
 const [m]=calibrateOllama(observations,rows,'session');
 assert.equal(m.requests,5);assert.equal(m.deltaPp,.5);assert.equal(m.inputTokensPerPp,1000);assert.equal(m.outputTokensPerPp,200);assert.equal(m.apiUsdPerPp,1);
 assert.equal(calibrateOllama(observations,rows.slice(1),'session').length,0);
 const mixed=structuredClone(observations);mixed.at(-1).limits.session.models.other=1;
 assert.equal(calibrateOllama(mixed,rows,'session').length,0);
 const drop=structuredClone(observations);drop[3].limits.session.used=0;
 assert.equal(calibrateOllama(drop,rows,'session').length,0);
 const gap=structuredClone(observations);gap[3].at+=10*M;
 assert.equal(calibrateOllama(gap,rows,'session').length,0);
});
test('read-only Ollama polling preserves recent failed lookups until expiry and does not expose secrets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ollama-monitor-'));const store=await openHistory(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const cfg={providers:{'ollama-cloud':{apiKey:'SECRET_SENTINEL',baseUrl:'https://ollama.com/v1'}}};
 await writeFile(join(dir,'config.json'),JSON.stringify(cfg));
 let calls=0,fail=false,time=NOW;
 const monitor=createOllamaMonitor({home:dir,store,now:()=>time,fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://ollama.com/api/usage');assert.equal(options.redirect,'error');
  if(fail)throw new Error('SECRET_SENTINEL');
  return {ok:true,text:async()=>JSON.stringify({limits:{session:{usage:.02},weekly:{usage:.1}}})};
 }});
 const snap=()=>({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]});
 await monitor.collect();let s=monitor.enrich(snap());assert.equal(s.providers[0].accounts[0].windows[0].usedPercent,2);
 assert.equal(s.providers[0].accounts[0].windows[0].resetAt,null);assert.equal(JSON.stringify(s).includes('SECRET_SENTINEL'),false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM ollama_observations').get().n,1);
 fail=true;time+=10000;await monitor.collect();const account=monitor.enrich(snap()).providers[0].accounts[0];
 assert.equal(account.status,'ok');assert.equal(account.refresh.status,'delayed');assert.equal(account.updatedAt,new Date(NOW).toISOString());assert.equal(account.windows[0].stale,false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM ollama_observations').get().n,1);
 time=NOW+15*M+1;assert.equal(monitor.enrich(snap()).providers[0].accounts[0].status,'stale');
 cfg.providers['ollama-cloud'].baseUrl='https://evil.example/v1';await writeFile(join(dir,'config.json'),JSON.stringify(cfg));
 await monitor.collect();assert.equal(calls,2);
});

test('persisted reported-token gate allows complete runs and excludes unreported calls',async t=>{
 for (const reported of [true,false]) await t.test(String(reported),async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ollama-gate-')),store=await openHistory(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'ollama-cloud':{apiKey:'test-key'}}}));
  let tick=0;
  const monitor=createOllamaMonitor({home:dir,store,now:()=>NOW+tick*M,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({limits:{session:{usage:tick*.001,models:[{name:'glm-5.3',request_count:tick}]}}})})});
  for(tick=0;tick<=5;tick++)await monitor.collect();tick=5;
  const records=rows.map((r,i)=>({requestId:`gate-${i}`,timestamp:r.at,provider:'ollama-cloud',model:r.model,usageStatus:i===4&&!reported?'unreported':'reported',usage:{inputTokens:r.input,outputTokens:r.output}}));
  const file=join(dir,'usage.jsonl');await writeFile(file,records.map(JSON.stringify).join('\n')+'\n');
  await store.ingest(file,{labels:new Map()},()=>({usd:.1,basis:'official'}),NOW+5*M);
  assert.equal(store.db.prepare('SELECT sum(tokensReported) n FROM usage_timings').get().n,reported?5:4);
  const s=monitor.enrich({providers:[{id:'ollama-cloud',accounts:[{id:'key:default'}]}]});
  assert.equal(s.providers[0].accounts[0].ollama.windows[0].models.length,reported?1:0);
 });
});
