import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createCollector} from '../src/collector.mjs';
import {rename} from 'node:fs/promises';
test('a configured credential is a secret under every provider, and real OCX ids survive',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-crosskey-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-14T14:00:00Z');
 // Distinct keys per provider. Reusing one sentinel everywhere hides exactly the
 // per-provider scoping bug this test exists to catch.
 const alpha='SYNTHETIC_KEY_ALPHA',beta='SYNTHETIC_KEY_BETA',gamma='SYNTHETIC_KEY_GAMMA';
 // A key hides inside a longer string just as well as it sits alone.
 const composite='vendor/'+alpha;
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{
  anthropic:{apiKey:alpha,models:[alpha,'claude-opus-5']},
  cursor:{apiKey:beta,models:[beta,alpha,composite,`${alpha}[1m]`,`vendor/${alpha}:latest`,'grok-4.6'],
   defaultModel:`${alpha}[1m]`,
   apiKeyPool:[{id:'p',key:beta,label:'backup '+alpha}]},
  google:{apiKeyPool:[{id:'pool',key:gamma,label:gamma}],models:['gemini-3.8-flash']},
  short:{apiKey:'sk-1234',models:['vendor/sk-1234','glm-5.3'],apiKeyPool:[{id:'q',key:'sk-1234',label:'backup sk-1234'}]},
  // A key that is only a name fragment of ordinary models must not delete them.
  fragment:{apiKey:'gpt',models:['gpt-5.6-luna','gpt-6-astra','gpt'],defaultModel:'gpt-5.6-luna'},
  // A longer key can also be the opening of a real model name.
  vertex:{apiKey:'gemini-3',models:['gemini-3.8-flash','gemini-3'],defaultModel:'gemini-3.8-flash'},
  kimi:{models:['k3','k3[1m]','glm-5.3[1m]',
   'C:/Users/Jun[1]/.opencodex/api-key','~root/[private]','[private]','..[1m]','[]',
   'C:/secret[1m]','~root/secret[1m]','C:secret[1m]','C:.env[1]',
   '~jun/.opencodex/config.json','~/.opencodex/x','.opencodex/config.json','a/.b/c','~a/b/c','~a',
   '~anthropic/claude-opus-latest'],
   defaultModel:'/home/private/.opencodex/api-key'},
 }}));
 await writeFile(join(dir,'auth.json'),'{}');
 const call=(id,provider,model)=>JSON.stringify({requestId:id,timestamp:now-1000,provider,model,
  usageStatus:'reported',usage:{inputTokens:1,outputTokens:1}});
 await writeFile(join(dir,'usage.jsonl'),[call('observed-key','cursor',alpha),call('observed-composite','cursor',composite),
  call('observed-decorated','cursor',`vendor/${alpha}:latest`),call('observed-path','kimi','~jun/.opencodex/config.json'),
  call('configured-and-observed','kimi','k3[1m]'),call('observed-only','kimi','claude-opus-4-8[1m]')].join('\n')+'\n');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();const snapshot=await collector.snapshot();
 const at=id=>snapshot.providers.find(p=>p.id===id);
 const body=JSON.stringify(snapshot);
 // A key is a secret wherever it appears, not only inside the provider that declares it.
 for(const secret of [alpha,beta,gamma])assert.equal(body.includes(secret),false,secret);
 // The default selector is published as a model name and passes the same two checks.
 assert.equal(at('cursor').defaultModel,null);
 assert.equal(at('kimi').defaultModel,null);
 assert.equal(body.includes('/home/private'),false);
 // A pooled key used as its own label falls back to the generic account name.
 assert.ok(at('google').accounts.some(a=>a.id==='key:pool'&&a.label==='API 계정 1'));
 assert.deepEqual(at('anthropic').supportedModels,['claude-opus-5']);
 assert.deepEqual(at('cursor').supportedModels,['grok-4.6']);
 assert.equal(body.includes(composite),false);
 // A known key wearing model syntax leaves all three discovery paths: the configured
 // list, the default selector, and a row seen only in the usage log.
 for(const shape of [`${alpha}[1m]`,`vendor/${alpha}:latest`]){
  assert.equal(body.includes(shape),false,shape);
  assert.equal(at('cursor').supportedModels.includes(shape),false,shape);
  assert.equal(at('cursor').analytics.modelPrices.some(p=>p.model===shape),false,shape);
  assert.equal(at('cursor').analytics.unpricedModels.some(m=>m.model===shape),false,shape);
 }
 assert.equal(at('cursor').defaultModel,null);
 assert.deepEqual(at('cursor').accounts.filter(a=>a.id==='key:p').map(a=>a.label),['API 계정 1']);
 // A bracketed marker belongs to a model id, not to a path. Allowing it must not
 // readmit a Windows absolute path, a named-user home, or an empty base.
 for(const shape of ['C:/Users/Jun[1]/.opencodex/api-key','~root/[private]','[private]','..[1m]','[]',
  'C:/secret[1m]','~root/secret[1m]','C:secret[1m]','C:.env[1]',
  '~jun/.opencodex/config.json','~/.opencodex/x','.opencodex/config.json','a/.b/c','~a/b/c','~a'])
  assert.equal(at('kimi').supportedModels.includes(shape),false,shape);
 // The same path must not arrive through the usage log either.
 assert.equal(body.includes('~jun/.opencodex/config.json'),false);
 // The catalog's leading-tilde alias is a real id and stays.
 assert.ok(at('kimi').supportedModels.includes('~anthropic/claude-opus-latest'));
 // A colon tag is a real id shape, so the drive-letter rule must be the narrow one.
 assert.ok(at('kimi').supportedModels.includes('k3[1m]'));
 assert.deepEqual(at('fragment').supportedModels,['gpt-5.6-luna','gpt-6-astra']);
 assert.equal(at('fragment').defaultModel,'gpt-5.6-luna');
 assert.deepEqual(at('vertex').supportedModels,['gemini-3.8-flash']);
 assert.equal(at('vertex').defaultModel,'gemini-3.8-flash');
 // A short key is still a key. It is matched as a complete token so that a
 // one-character key cannot erase every model whose name merely starts with it.
 assert.equal(body.includes('sk-1234'),false);
 assert.deepEqual(at('short').supportedModels,['glm-5.3']);
 assert.deepEqual(at('short').accounts.filter(a=>a.id==='key:q').map(a=>a.label),['API 계정 1']);
 // Installed OCX 2.55.0 registers k3[1m], glm-5.3[1m] and claude-*[1m]. A bracketed id
 // is a real model, so it stays listed and simply carries no price.
 assert.deepEqual(at('kimi').supportedModels,['k3','k3[1m]','glm-5.3[1m]','~anthropic/claude-opus-latest']);
 const kimi=Object.fromEntries(at('kimi').analytics.modelPrices.map(r=>[r.model,r]));
 assert.deepEqual(kimi['k3[1m]'].sources,['ocx-config','observed']);
 assert.equal(kimi['k3[1m]'].status,'unpriced');
 assert.deepEqual(kimi['k3[1m]'].rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.equal(typeof kimi['k3[1m]'].reason,'string');
 assert.deepEqual(kimi['claude-opus-4-8[1m]'].sources,['observed']);
 assert.ok(at('kimi').analytics.unpricedModels.some(m=>m.model==='k3[1m]'));
});
test('every configured and observed model keeps a listed price record, and no secret rides along',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-prices-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-11T12:30:00Z');
 await writeFile(join(dir,'config.json'),JSON.stringify({
  providers:{
   anthropic:{apiKey:'SECRET_SENTINEL',models:['claude-opus-5','claude-sonnet-5','never-published-model',
    'claude-sonnet-4@20250514','Pro/deepseek-ai/DeepSeek-V3','~anthropic/claude-opus-latest',
    '/home/private/.opencodex/api-key','../../etc/passwd','has space','../secret','./config.json',
    '~/.opencodex/api-key','SECRET_SENTINEL'],
    defaultModel:'claude-sonnet-5'},
   'opencode-go':{apiKey:'SECRET_SENTINEL',models:['kimi-k2.7-code','deepseek-flash','deepseek/deepseek-v4-flash','a/b/c/d/e/f'],defaultModel:'kimi-k2.7-code'},
   cursor:{apiKeyPool:[{id:'pool',key:'POOLED_SENTINEL'}],apiKey:'SECRET_SENTINEL'},
 },
 disabledModels:['anthropic/claude-sonnet-5','opencode-go/deepseek/deepseek-v4-flash','opencode-go/a/b/c/d/e/f'],
 }));
 await writeFile(join(dir,'auth.json'),'{}');
 const call=(id,provider,model)=>JSON.stringify({requestId:id,timestamp:now-1000,provider,model,
  usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 await writeFile(join(dir,'usage.jsonl'),[call('seen','opencode-go','glm-5.3'),
  call('path','anthropic','/home/private/.opencodex/api-key'),call('home','anthropic','~/.opencodex/api-key'),
  call('up','anthropic','../../etc/passwd'),call('key','cursor','SECRET_SENTINEL'),
  call('pool','cursor','POOLED_SENTINEL'),call('real','cursor','grok-4.6')].join('\n')+'\n');
 await writeFile(catalogPath,JSON.stringify({anthropic:{models:{'never-published-model':{cost:{input:0,output:0}}}}}));
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();const snapshot=await collector.snapshot();
 const priced=id=>Object.fromEntries(snapshot.providers.find(p=>p.id===id).analytics.modelPrices.map(r=>[r.model,r]));
 const anthropic=priced('anthropic');
 // A provider-qualified disable removes only that provider's model.
 assert.equal('claude-sonnet-5' in anthropic,false);
 assert.equal(anthropic['claude-opus-5'].status,'official');
 assert.equal(anthropic['claude-opus-5'].rates.input,5);
 assert.equal(anthropic['claude-opus-5'].checkedAt,'2026-09-15');
 // No public price is a listed state with a reason, not a disappearance. An all-zero
 // catalog row is rejected upstream, so this model stays genuinely unpriced.
 const missing=anthropic['never-published-model'];
 assert.equal(missing.status,'unpriced');
 assert.deepEqual(missing.rates,{input:null,output:null,cacheRead:null,cacheWrite:null});
 assert.equal(typeof missing.reason,'string');
 assert.deepEqual(missing.sources,['ocx-config']);
 assert.equal(missing.unit,'usd-per-million-tokens');
 // A model ID is an ID, not an arbitrary string: neither a path nor a credential can be
 // published as one, whatever the credential happens to look like.
 for(const shape of ['/home/private/.opencodex/api-key','../../etc/passwd','has space','../secret','./config.json','~/.opencodex/api-key','SECRET_SENTINEL'])
  assert.equal(shape in anthropic,false,shape);
 // Real IDs carry namespaces and version suffixes and must survive that filter.
 assert.equal(anthropic['claude-sonnet-4@20250514'].status,'unpriced');
 assert.equal(anthropic['Pro/deepseek-ai/DeepSeek-V3'].status,'unpriced');
 // A bare tilde is a home reference; the catalog's alias marker carries its vendor.
 assert.equal(anthropic['~anthropic/claude-opus-latest'].status,'unpriced');
 // A recorded name passes the same gate as a configured one: the usage log belongs to
 // another product, so a path in its model field is not republished as a model.
 for(const shape of ['/home/private/.opencodex/api-key','~/.opencodex/api-key','../../etc/passwd'])
  assert.equal(shape in anthropic,false,'observed '+shape);
 // Configuration and the usage log are separate discovery sources and stay separate.
 const go=priced('opencode-go');
 assert.deepEqual(go['kimi-k2.7-code'].sources,['ocx-config']);
 assert.deepEqual(go['glm-5.3'].sources,['observed']);
 assert.equal(go['glm-5.3'].requests,1);
 assert.equal(go['glm-5.3'].status,'official');
 assert.equal(go['glm-5.3'].providerBasis,'attributed');
 // Priced as of the snapshot instant. Without a timestamp this peak-scheduled model
 // would be listed as unpriced even though it has a valid current rate.
 assert.equal(go['deepseek-flash'].status,'official');
 assert.equal(go['deepseek-flash'].rates.input,.15);
 assert.ok(go['deepseek-flash'].conditions.includes('peak-hours'));
 // A disable entry qualifies a vendor-prefixed model with its provider, so it has more
 // than one separator and must still match.
 assert.equal('deepseek/deepseek-v4-flash' in go,false);
 // Qualification must not consume the model's own segment allowance.
 assert.equal('a/b/c/d/e/f' in go,false);
 assert.ok(snapshot.analytics.modelPriceConditions['long-context'].length>0);
 // A recorded name that is character-identical to a model ID is still refused when it
 // is a key this configuration holds. Only its value can tell them apart.
 const cursor=priced('cursor');
 assert.equal('SECRET_SENTINEL' in cursor,false);
 assert.equal('POOLED_SENTINEL' in cursor,false);
 assert.equal(cursor['grok-4.6'].status,'official');
 assert.deepEqual(snapshot.providers.find(p=>p.id==='cursor').analytics.unpricedModels,[]);
 const body=JSON.stringify(snapshot);
 assert.equal(body.includes('SECRET_SENTINEL'),false);
 assert.equal(body.includes('POOLED_SENTINEL'),false);
 assert.equal(body.includes('/etc/passwd'),false);
 for(const secret of [dir,catalogPath,'models.json','usage.jsonl','.opencodex','/home/'])assert.equal(body.includes(secret),false,secret);
});
test('collector reprices a newly cataloged model without restart and exposes missing-model diagnostics',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-catalog-')),catalogPath=join(dir,'models.json');
 const now=Date.parse('2026-09-10T12:30:00Z');
 await writeFile(join(dir,'config.json'),JSON.stringify({providers:{'opencode-go':{apiKey:'synthetic-key'}}}));
 await writeFile(join(dir,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),JSON.stringify({requestId:'new-model',timestamp:now,provider:'opencode-go',model:'next-model',usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100,cachedInputTokens:0}})+'\n');
 const collector=await createCollector({home:dir,codexHome:dir,dataDir:join(dir,'state'),catalogPath,now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();let snapshot=await collector.snapshot();
 const go=s=>s.providers.find(p=>p.id==='opencode-go').analytics;
 assert.deepEqual(go(snapshot).unpricedModels,[{model:'next-model',requests:1}]);assert.equal(snapshot.analytics.pricingCatalog.status,'missing');
 await writeFile(catalogPath,JSON.stringify({'opencode-go':{models:{'next-model':{cost:{input:2,output:4,cache_read:.2}}}}}));
 await collector.collect();snapshot=await collector.snapshot();
 assert.equal(go(snapshot).periods.weekly.requests,1);assert.equal(go(snapshot).periods.weekly.apiUsd,.0024);
 assert.equal(go(snapshot).periods.weekly.localPriceRequests,1);assert.deepEqual(go(snapshot).unpricedModels,[]);
 assert.equal(snapshot.analytics.pricingCatalog.status,'ok');assert.equal(JSON.stringify(snapshot).includes('synthetic-key'),false);
});
test('timer collects with no browser; source files stay intact and restart retains history',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-')),native=join(dir,'native'),dataDir=join(dir,'state');await mkdir(native);
 let now=1800000000000;
 const files={'config.json':{providers:{openai:{}},codexAccounts:[{id:'pool',logLabel:'pabcdef',plan:'pro'}]},'auth.json':{},'codex-accounts.json':{pool:{credential:{accessToken:'PRIVATE_SENTINEL'}}},'codex-quota-cache.json':{version:1,quotas:{pool:{updatedAt:now,weeklyPercent:10,weeklyResetAt:now/1000+86400}}},'provider-account-quota-cache.json':{version:1,rows:{}}};
 for(const [name,value]of Object.entries(files))await writeFile(join(dir,name),JSON.stringify(value));await writeFile(join(native,'auth.json'),'{}');
 await writeFile(join(dir,'usage.jsonl'),JSON.stringify({requestId:'one',timestamp:now-1000,provider:'openai-pabcdef',model:'gpt-6-astra',usageStatus:'reported',usage:{inputTokens:100000,outputTokens:1000}})+'\n');
 const opts={home:dir,codexHome:native,dataDir,now:()=>now,intervalMs:20};
 let collector=await createCollector(opts);t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});await collector.start();
 const initial=await collector.snapshot();assert.equal(initial.providers[0].accounts[1].analytics.periods.weekly.apiUsd,1.05);
 now+=60000;files['codex-quota-cache.json'].quotas.pool.updatedAt=now;files['codex-quota-cache.json'].quotas.pool.weeklyPercent=12;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(files['codex-quota-cache.json']));
 // Observe a timer-owned collection, without invoking collect or an HTTP/browser route.
 const deadline=Date.now()+2000;let next;
 while(Date.now()<deadline){next=await collector.snapshot();if(next.analytics.lastCollectedAt===new Date(now).toISOString())break;await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(next.analytics.lastCollectedAt,new Date(now).toISOString());
 await collector.close();collector=await createCollector(opts);await collector.start();
 const restored=await collector.snapshot();assert.equal(restored.analytics.historyStartedAt,initial.analytics.historyStartedAt);
 assert.equal(restored.providers[0].accounts[1].analytics.periods.weekly.apiUsd,1.05);assert.equal(restored.providers[0].accounts[1].windows[0].analytics.history.length,2);
 assert.equal(JSON.stringify(restored).includes('PRIVATE_SENTINEL'),false);
 const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(dir,'codex-accounts.json'),'utf8'),JSON.stringify(files['codex-accounts.json']));
});

test('collector usage-read failure preserves demand and matches capacity only through the last read',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-collector-failure-')),native=join(dir,'native');await mkdir(native);
 const base=1800000000000,minute=60000;let now=base;
 const quota=()=>({version:1,quotas:{pool:{updatedAt:now,weeklyPercent:(now-base)/minute,weeklyResetAt:base+86400000}}});
 const files={'config.json':{providers:{openai:{}},codexAccounts:[{id:'pool',logLabel:'pabcdef',plan:'pro'}]},'auth.json':{},'codex-accounts.json':{pool:{credential:{accessToken:'PRIVATE_SENTINEL'}}},'codex-quota-cache.json':quota(),'provider-account-quota-cache.json':{version:1,rows:{}}};
 for(const [name,value]of Object.entries(files))await writeFile(join(dir,name),JSON.stringify(value));await writeFile(join(native,'auth.json'),'{}');
 const entry=(id,at)=>({requestId:id,timestamp:at,provider:'openai-pabcdef',model:'gpt-6-astra',usageStatus:'reported',usage:{inputTokens:100000,outputTokens:0}});
 const usage=join(dir,'usage.jsonl');await writeFile(usage,JSON.stringify(entry('older',base-2*86400000))+'\n');
 const collector=await createCollector({home:dir,codexHome:native,dataDir:join(dir,'state'),now:()=>now});
 t.after(async()=>{await collector.close();await rm(dir,{recursive:true,force:true});});
 await collector.collect();
 now=base+10*minute;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(quota()));
 await writeFile(usage,[entry('older',base-2*86400000),entry('matched',base+5*minute)].map(JSON.stringify).join('\n')+'\n');
 await collector.collect();const before=await collector.snapshot();
 now=base+20*minute;await writeFile(join(dir,'codex-quota-cache.json'),JSON.stringify(quota()));await rename(usage,join(dir,'usage-unavailable.jsonl'));
 await collector.collect();const after=await collector.snapshot();
 assert.equal(after.analytics.status,'error');assert.equal(after.analytics.usageObservedAt,new Date(base+10*minute).toISOString());
 const previous=before.providers[0].analytics,current=after.providers[0].analytics;
 assert.equal(current.pace.usdPerHour,previous.pace.usdPerHour);assert.equal(current.pace.stale,true);
 assert.equal(current.recommendation.weeklyDemandApiUsd,previous.recommendation.weeklyDemandApiUsd);
 assert.equal(current.recommendation.usageStale,true);assert.equal(current.recommendation.status,'provisional');
 const value=after.providers[0].accounts[1].windows[0].analytics;
 assert.equal(value.capacityApiUsd,10);assert.equal(value.capacityObservedAt,new Date(base+10*minute).toISOString());assert.equal(value.capacityBasis,'partial');assert.equal(value.unexplainedDeltaPp,0);
});
