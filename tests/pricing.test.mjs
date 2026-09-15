import test from 'node:test';import assert from 'node:assert/strict';import {OLLAMA_CREDIT_PLANS,ollamaModelPricing,priceUsage,lookupModelPrice,PRICE_CONDITIONS} from '../src/pricing.mjs';
const row=(model,usage,provider='openai',extra={})=>({model,provider,usageStatus:'reported',usage,...extra});
test('unknown models, missing and contradictory tokens remain unpriced',()=>{
 for(const r of [row('no-model',{}),row('gpt-6-astra',{}),row('gpt-6-astra',{inputTokens:2,outputTokens:1,cacheReadInputTokens:5})])assert.equal(priceUsage(r).usd,null);
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1,outputTokens:2},'xai')).usd,null);
});
test('cache included in input and reasoning included in output are never counted twice',()=>{
 const r=priceUsage(row('gpt-6-astra',{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,reasoningOutputTokens:500}));
 assert.equal(r.usd,.33);
});
test('OpenAI long context and confirmed fast tier apply correct rates',()=>{
 const r=priceUsage(row('gpt-6-astra',{inputTokens:300000,outputTokens:1000},'openai',{tierOutcome:{responseServiceTier:'priority'}}));assert.equal(r.usd,12.15);
});
test('Fable cache writes are an explicit 5-minute estimate; cache hits use 0.025x',()=>{
 const r=priceUsage(row('claude-fable-5-1',{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,cacheCreationInputTokens:10000},'anthropic'));assert.equal(r.usd,.295);assert.equal(r.basis,'local-catalog');
});
test('Grok >=200k doubles all token rates and unsupported tier combinations stay unknown',()=>{
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:200000,outputTokens:1000},'xai')).usd,.812);
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:200000,outputTokens:1000},'xai',{responseServiceTier:'priority'})).usd,null);
});
test('requested priority alone does not prove a billed priority tier',()=>{
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1000,outputTokens:1000},'openai',{requestedServiceTier:'priority'})).usd,null);
});

test('Ollama reference prices preserve model sizes and cache discounts with provider isolation',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000};
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'ollama-cloud')).usd,.59);
 assert.equal(priceUsage(row('gpt-oss:120b-cloud',{inputTokens:1000000,outputTokens:0},'ollama-cloud')).usd,.15);
 assert.equal(priceUsage(row('gpt-oss:20b',{inputTokens:1000000,outputTokens:0},'ollama-cloud')).usd,.07);
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'openai')).usd,null);
 assert.equal(priceUsage(row('glm-5.3-flash:unverified',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('mistral-large-3',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('glm-5.3-flash',usage,'ollama-cloud',{usageStatus:'unreported'})).usd,null);
});
test('Ollama DeepSeek peak applies only weekdays 12 through 18 UTC and requires timestamp',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000};
 const cost=time=>priceUsage(row('deepseek-v4-flash:0731',usage,'ollama-cloud',{timestamp:Date.parse(time)})).usd;
 assert.equal(cost('2026-09-09T11:59:59Z'),.88);
 assert.equal(cost('2026-09-09T12:00:00Z'),1.76);
 assert.equal(cost('2026-09-09T17:59:59Z'),1.76);
 assert.equal(cost('2026-09-09T18:00:00Z'),.88);
 assert.equal(cost('2026-09-12T13:00:00Z'),.88);
 assert.equal(priceUsage(row('deepseek-v4-flash',usage,'ollama-cloud')).usd,null);
 assert.equal(priceUsage(row('deepseek-v4-pro:0813-cloud',usage,'ollama-cloud',{timestamp:Date.parse('2026-09-09T06:00Z')})).usd,2.64);
});

// Cursor forwards known models; token estimates affect confidence, not provider eligibility.
test('Cursor Grok uses API-equivalent rates and preserves estimated-token basis',()=>{
 const result=priceUsage(row('grok-4.6',{inputTokens:100000,outputTokens:1000,estimated:true},'cursor',{usageStatus:'estimated'}));
 assert.equal(result.usd,.206);assert.equal(result.basis,'local-catalog');
 assert.equal(priceUsage(row('grok-4.6',{inputTokens:100000,outputTokens:1000},'anthropic')).usd,null);
});

test('all 19 published Ollama model prices have their published input, cache-read and output rates',()=>{
 const expected=[
  ['deepseek-v4-flash',.22,.007,.66],['deepseek-v4-pro',.66,.022,1.98],['gemma4',.14,.05,.4],['glm-5.3',1.4,.26,4.4],['glm-5.3-flash',.15,.03,.5],['glm-5.2',1.4,.26,4.4],['glm-5.1',1,.2,3.2],['gpt-oss:120b',.15,.014,.6],['gpt-oss:20b',.07,.035,.3],['kimi-k3',3,.3,15],['kimi-k2.7-code',.95,.19,4],['kimi-k2.6',.95,.16,4],['minimax-m3',.6,.12,2.4],['minimax-m2.7',.3,.06,1.2],['mistral-large-3',.5,null,1.5],['nemotron-3-nano',.06,null,.24],['nemotron-3-super',.015,.015,.6],['nemotron-3-ultra',.1,.1,3],['qwen3.5:397b',.6,null,3.6],
 ];
 for(const [model,inputUsdPerMillion,cachedInputUsdPerMillion,outputUsdPerMillion] of expected){
  const actual=ollamaModelPricing(model,Date.parse('2026-09-09T11:59:59Z'));
  assert.deepEqual(actual,{model,inputUsdPerMillion,cachedInputUsdPerMillion,outputUsdPerMillion,peak:false,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 }
});

test('Ollama aliases canonicalize and DeepSeek rates change only at official peak boundaries',()=>{
 const before=ollamaModelPricing('deepseek-v4-flash:0731-cloud',Date.parse('2026-09-09T11:59:59Z'));
 const starts=ollamaModelPricing('deepseek-v4-flash:0731',Date.parse('2026-09-09T12:00:00Z'));
 const ends=ollamaModelPricing('deepseek-v4-flash',Date.parse('2026-09-09T18:00:00Z'));
 const weekend=ollamaModelPricing('deepseek-v4-flash',Date.parse('2026-09-12T13:00:00Z'));
 assert.equal(ollamaModelPricing('gpt-oss:120b-cloud',Date.parse('2026-09-09T12:00:00Z')).model,'gpt-oss:120b');
 assert.deepEqual([before.inputUsdPerMillion,before.cachedInputUsdPerMillion,before.outputUsdPerMillion,before.peak],[.22,.007,.66,false]);
 assert.deepEqual([starts.inputUsdPerMillion,starts.cachedInputUsdPerMillion,starts.outputUsdPerMillion,starts.peak],[.44,.014,1.32,true]);
 assert.deepEqual([ends.inputUsdPerMillion,ends.cachedInputUsdPerMillion,ends.outputUsdPerMillion,ends.peak],[.22,.007,.66,false]);
 assert.equal(weekend.peak,false);
 assert.equal(ollamaModelPricing('deepseek-v4-flash'),null);
 assert.equal(ollamaModelPricing('unpublished-model',Date.now()),null);
});

test('all account-provider suffixes use the same price-validation provider',()=>{
 const usage={inputTokens:100000,outputTokens:1000};
 for(const provider of ['openai-main','openai-pabcdef','openai-oabcdef','openai-kabcdef'])assert.equal(priceUsage(row('gpt-6-astra',usage,provider)).usd,1.05);
 assert.equal(priceUsage(row('gpt-6-astra',usage,'xai-oabcdef')).usd,null);
});

test('Ollama credit comparison retains separate official reference plans',()=>{
 assert.deepEqual(OLLAMA_CREDIT_PLANS.pro,{monthlyUsd:20,includedCreditsUsd:60,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 assert.deepEqual(OLLAMA_CREDIT_PLANS.max,{monthlyUsd:100,includedCreditsUsd:300,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
 assert.deepEqual(OLLAMA_CREDIT_PLANS.team,{monthlyUsd:500,includedCreditsUsd:1000,sourceUrl:'https://ollama.com/pricing',checkedAt:'2026-09-10'});
});

test('verified GPT-5.4 mini and Composer 2.5 Fast rates avoid unsupported cache writes and tiers',()=>{
 const usage={inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000};
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:100000,outputTokens:100000,cachedInputTokens:50000})).usd,.49125);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:300000,outputTokens:1000})).usd,null);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:1000,outputTokens:1000},'openai',{responseServiceTier:'fast'})).usd,null);
 assert.equal(priceUsage(row('gpt-5.4-mini',{inputTokens:1000,outputTokens:1000,cacheCreationInputTokens:1})).usd,null);
 assert.equal(priceUsage(row('composer-2.5-fast',usage,'cursor')).usd,16.75);
 assert.equal(priceUsage(row('composer-2.5-fast',{inputTokens:1000,outputTokens:1000,cacheCreationInputTokens:1},'cursor')).usd,null);
});

const AT=Date.parse('2026-09-11T12:00:00Z');

test('a unit price belongs to one provider and never crosses to another',()=>{
 // Same model ID, two providers, two published tariffs and two different schedules.
 const ollama=lookupModelPrice('ollama-cloud','deepseek-v4-flash',{timestamp:AT});
 const go=lookupModelPrice('opencode-go','deepseek-v4-flash',{timestamp:AT});
 assert.deepEqual([ollama.rates.input,ollama.rates.output],[.44,1.32]);
 assert.deepEqual([go.rates.input,go.rates.output],[.15,.6]);
 // Anthropic's rate reaches Cursor only because a route says Cursor forwards it.
 assert.equal(lookupModelPrice('anthropic','claude-opus-5').rates.input,5);
 assert.equal(lookupModelPrice('cursor','claude-opus-5').rates.input,5);
 for(const provider of ['xai','opencode-go','google'])assert.equal(lookupModelPrice(provider,'claude-opus-5').status,'unpriced',provider);
 // An account suffix is the same provider; another vendor is not.
 assert.equal(lookupModelPrice('openai-pabcdef','gpt-6-astra').rates.input,10);
 assert.equal(lookupModelPrice('xai-oabcdef','gpt-6-astra').status,'unpriced');
 assert.equal(lookupModelPrice('openai',null).status,'unpriced');
 // Asking without conditions is a question, not an error.
 assert.equal(lookupModelPrice('openai','gpt-6-astra',null).rates.input,10);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',undefined).rates.input,10);
});

test('the quoted unit price reproduces the recorded amount for the same conditions',()=>{
 const cases=[
  [{provider:'openai',model:'gpt-6-astra',usage:{inputTokens:300000,outputTokens:1000},tierOutcome:{responseServiceTier:'priority'}},12.15],
  [{provider:'openai',model:'gpt-6-astra',usage:{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000}},.33],
  [{provider:'anthropic',model:'claude-fable-5-1',usage:{inputTokens:100000,outputTokens:1000,cacheReadInputTokens:80000,cacheCreationInputTokens:10000}},.295],
  [{provider:'xai',model:'grok-4.6',usage:{inputTokens:200000,outputTokens:1000}},.812],
  [{provider:'opencode-go',model:'deepseek-flash',usage:{inputTokens:20000,outputTokens:100,cachedInputTokens:10000}},.00159],
  [{provider:'ollama-cloud',model:'glm-5.3-flash',usage:{inputTokens:1000000,outputTokens:1000000,cachedInputTokens:500000}},.59],
 ];
 for(const [partial,expected] of cases){
  const r={timestamp:AT,usageStatus:'reported',...partial},u=r.usage;
  const price=lookupModelPrice(r.provider,r.model,{timestamp:r.timestamp,inputTokens:u.inputTokens,tierOutcome:r.tierOutcome});
  let read=u.cacheReadInputTokens??u.cachedInputTokens??0;
  const write=u.cacheCreationInputTokens??0;
  if(read+write>u.inputTokens&&u.cacheReadInputTokens===undefined&&u.cachedInputTokens!==undefined)read=Math.max(0,read-write);
  const quoted=((u.inputTokens-read-write)*price.rates.input+u.outputTokens*price.rates.output
   +read*price.rates.cacheRead+write*(price.rates.cacheWrite??0))/1e6*price.tierMultiplier;
  // The hand-written expectation, the quote and the valuation must all be the same number.
  assert.equal(priceUsage(r).usd,expected,r.model);
  assert.equal(quoted,expected,`quoted ${r.model}`);
 }
});

test('a missing cache price stays missing and an unsupported field is never advertised as free',()=>{
 const mistral=lookupModelPrice('ollama-cloud','mistral-large-3',{timestamp:AT});
 assert.equal(mistral.rates.cacheRead,null);
 assert.equal(mistral.rates.cacheWrite,null);
 assert.deepEqual(mistral.unsupported,['cache-write']);
 // The Ollama tuple stores 0 in that slot, but the valuation refuses any positive write.
 assert.equal(priceUsage({provider:'ollama-cloud',model:'mistral-large-3',timestamp:AT,usageStatus:'reported',
  usage:{inputTokens:1000,outputTokens:0,cacheCreationInputTokens:1}}).usd,null);
 assert.equal(lookupModelPrice('openai','gpt-5.4-mini').rates.cacheWrite,null);
 assert.equal(lookupModelPrice('cursor','composer-2.5-fast').rates.cacheWrite,null);
 // A published zero is a real free rate and stays zero.
 assert.equal(lookupModelPrice('xai','grok-4.6').rates.cacheWrite,0);
});

test('a promotional rate stops at its published end instead of being assumed onward',()=>{
 const before=Date.parse('2026-12-31T23:59:59Z'),ends=Date.parse('2027-01-01T00:00:00Z');
 const promo=lookupModelPrice('google','gemini-3.8-flash',{timestamp:before});
 assert.equal(promo.rates.input,.75);
 assert.equal(promo.effectiveTo,'2027-01-01T00:00:00.000Z');
 assert.ok(promo.conditions.includes('promotional'));
 for(const provider of ['google','cursor']){
  assert.equal(lookupModelPrice(provider,'gemini-3.8-flash',{timestamp:ends}).status,'unpriced',provider);
  assert.equal(lookupModelPrice(provider,'gemini-3.8-flash',{timestamp:ends+86400000}).status,'unpriced',provider);
 }
 // No timestamp is not evidence of a future call. A one-way cliff is not a peak schedule.
 assert.equal(lookupModelPrice('google','gemini-3.8-flash',{}).rates.input,.75);
 const at=t=>({provider:'google',model:'gemini-3.8-flash',timestamp:t,usageStatus:'reported',usage:{inputTokens:1000,outputTokens:100}});
 assert.equal(priceUsage(at(before)).usd,.001125);
 assert.equal(priceUsage(at(ends)).usd,null);
});

test('the new evidence grade leaves the persisted estimate flag untouched',()=>{
 // basis is stored on every usage row and counted as localPriceRequests, so it keeps
 // its two values. The finer provenance lives only on the lookup.
 const daybreak={provider:'openai-main',model:'gpt-daybreak-blue-latest',usageStatus:'reported',
  usage:{inputTokens:100000,outputTokens:1000,cachedInputTokens:80000}};
 assert.equal(priceUsage(daybreak).basis,'local-catalog');
 assert.equal(priceUsage({provider:'google',model:'gemini-3.8-flash',timestamp:AT,usageStatus:'reported',
  usage:{inputTokens:1000,outputTokens:100}}).basis,'local-catalog');
 assert.equal(lookupModelPrice('openai','gpt-daybreak-blue-latest').status,'ocx-provided');
 assert.equal(lookupModelPrice('openai','gpt-daybreak-blue-latest').checkedAt,'2026-08-11');
 assert.equal(lookupModelPrice('google','gemini-3.8-flash').status,'ocx-provided');
 assert.equal(lookupModelPrice('google','gemini-3.8-flash').checkedAt,'2026-09-03');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').status,'official');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').checkedAt,'2026-09-10');
 assert.equal(lookupModelPrice('openai','gpt-6-astra').unit,'usd-per-million-tokens');
});

test('the lookup applies the same service-tier rule as the valuation',()=>{
 // An ordinary requested tier is acceptable; an unproven priority is not.
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{requestedServiceTier:'default'}).rates.input,10);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{requestedServiceTier:'priority'}).status,'unpriced');
 assert.equal(priceUsage(row('gpt-6-astra',{inputTokens:1000,outputTokens:1000},'openai',{requestedServiceTier:'default'})).usd,.06);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{responseServiceTier:'priority'}).tierMultiplier,2);
 assert.equal(lookupModelPrice('openai','gpt-6-astra',{responseServiceTier:'flex'}).tierMultiplier,.5);
 assert.equal(lookupModelPrice('anthropic','claude-opus-5',{responseServiceTier:'priority'}).status,'unpriced');
 assert.equal(lookupModelPrice('xai','grok-4.6',{responseServiceTier:'priority',inputTokens:200000}).status,'unpriced');
 assert.equal(lookupModelPrice('openai','gpt-5.4-mini',{inputTokens:300000}).status,'unpriced');
});

test('a declared tier condition means that tier is actually priced, and none is omitted',()=>{
 // The label used to promise flex and batch at half price for xAI, which the valuation
 // refuses. Conditions are derived from real support instead of a shared sentence.
 const providers=['openai','openai-apikey','chatgpt','openai-multi','cursor','xai','anthropic','google','opencode-go'];
 const models=['gpt-6-astra','gpt-5.4-mini','gpt-5.6-luna','grok-4.6','claude-opus-5','gemini-3.8-flash','composer-2.5-fast'];
 let compared=0;
 for(const provider of providers)for(const model of models)for(const inputTokens of [1000,199999,200000,272001]){
  const quote=lookupModelPrice(provider,model,{timestamp:AT,inputTokens});
  if(quote.status==='unpriced')continue;
  const at=tier=>lookupModelPrice(provider,model,{timestamp:AT,inputTokens,responseServiceTier:tier});
  assert.equal(quote.conditions.includes('service-tier-priority'),at('priority').tierMultiplier===2,`priority ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-priority'),at('fast').tierMultiplier===2,`fast ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-discount'),at('flex').tierMultiplier===.5,`flex ${provider}/${model}@${inputTokens}`);
  assert.equal(quote.conditions.includes('service-tier-discount'),at('batch').tierMultiplier===.5,`batch ${provider}/${model}@${inputTokens}`);
  for(const id of quote.conditions)assert.ok(PRICE_CONDITIONS[id],`missing label for ${id}`);
  compared++;
 }
 assert.ok(compared>=80,`compared ${compared}`);
 // The three shapes that motivated the split.
 const xai=lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:1000});
 assert.deepEqual([xai.conditions.includes('service-tier-priority'),xai.conditions.includes('service-tier-discount')],[true,false]);
 assert.equal(lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:1000,responseServiceTier:'flex'}).status,'unpriced');
 const longXai=lookupModelPrice('xai','grok-4.6',{timestamp:AT,inputTokens:200000});
 assert.equal(longXai.conditions.includes('service-tier-priority'),false);
 const mini=lookupModelPrice('openai','gpt-5.4-mini',{timestamp:AT,inputTokens:1000});
 assert.deepEqual([mini.conditions.includes('service-tier-priority'),mini.conditions.includes('service-tier-discount')],[false,true]);
});

test('source conflict compares two prices conditioned the same way',()=>{
 const catalog=tuple=>()=>tuple;
 const astra=(inputTokens,tuple)=>lookupModelPrice('openai','gpt-6-astra',{timestamp:AT,inputTokens,catalog:catalog(tuple)});
 const base=[10,50,1,12.5,null,'local-catalog'],long=[20,75,2,25,null,'local-catalog'];
 // Below the threshold both sides state the base tuple: agreement.
 assert.equal(astra(100000,base).conflict,null);
 // Above it the built-in effective rate is 20/75 while the catalog still states 10/50.
 // Comparing the catalog against the built-in BASE tuple used to hide this.
 const differs=astra(300000,base);
 assert.deepEqual([differs.rates.input,differs.rates.output],[20,75]);
 assert.deepEqual(differs.conflict.rates,{input:10,output:50,cacheRead:1,cacheWrite:12.5});
 // And when the catalog carries its own matching long-context tier the two agree, even
 // though the catalog tuple differs from the built-in base tuple.
 assert.equal(astra(300000,long).conflict,null);
 // An omitted field is absence of a claim, not disagreement.
 assert.equal(astra(1000,[10,50,null,null,null,'local-catalog']).conflict,null);
 // The catalog has no service tier and no peak schedule, so under either it states
 // nothing comparable and silence must not be published as agreement or disagreement.
 const priority=lookupModelPrice('openai','gpt-6-astra',{timestamp:AT,inputTokens:1000,responseServiceTier:'priority',catalog:catalog([9,9,9,9,null,'local-catalog'])});
 assert.equal(priority.tierMultiplier,2);
 assert.equal(priority.conflict,null);
 const nine=catalog([9,9,9,null,null,'local-catalog']);
 const offPeak=lookupModelPrice('opencode-go','deepseek-flash',{timestamp:Date.parse('2026-09-14T14:00:00Z'),inputTokens:1000,catalog:nine});
 const onPeak=lookupModelPrice('opencode-go','deepseek-flash',{timestamp:Date.parse('2026-09-14T02:00:00Z'),inputTokens:1000,catalog:nine});
 assert.deepEqual([offPeak.rates.input,offPeak.rates.output],[.15,.6]);
 assert.notEqual(offPeak.conflict,null);
 assert.deepEqual([onPeak.rates.input,onPeak.rates.output],[.3,1.2]);
 assert.equal(onPeak.conflict,null);
 // Effective rates are products of published decimals: 1.2 * 1.5 is 1.7999999999999998.
 // That is the same price as 1.8, and a strict comparison would call it a disagreement.
 const luna=(tuple)=>lookupModelPrice('openai','gpt-5.6-luna',{timestamp:AT,inputTokens:300000,catalog:()=>tuple});
 const drifted=luna([.4,1.8,.04,.5,null,'local-catalog']);
 assert.equal(drifted.rates.output,1.7999999999999998);
 assert.equal(drifted.conflict,null);
 assert.notEqual(luna([.4,1.9,.04,.5,null,'local-catalog']).conflict,null);
});
