// API-equivalent display prices, USD per million tokens. Never actual subscription billing.
import { providerModelPricing, GO_PRICING, DEEPSEEK_PRICING, DEEPSEEK_RELEASE } from './opencode-pricing.mjs';
// API/Ollama/Composer pages rechecked 2026-09-10; other source dates are retained below.
const OAI='https://developers.openai.com/api/docs/pricing';
const CLAUDE='https://platform.claude.com/docs/en/about-claude/pricing';
const XAI='https://docs.x.ai/developers/pricing';
const GOOGLE='https://ai.google.dev/gemini-api/docs/pricing';
const PRO='https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro';
const MAX='https://support.claude.com/en/articles/11049741-what-is-the-max-plan';
const CURSOR='https://cursor.com/pricing';
const OLLAMA='https://ollama.com/pricing';
const GROK='https://x.ai/pricing';
const COMPOSER='https://prod.cursor.com/docs/models/cursor-composer-2-5';
const MINI='https://developers.openai.com/api/docs/models/gpt-5.4-mini';
const DEVIN='https://docs.devin.ai/desktop/models';
const CHECKED_AT='2026-09-10';
export const pricingSources = [
 ['OpenCode Go 모델 단가',GO_PRICING],['DeepSeek API 단가',DEEPSEEK_PRICING],['DeepSeek V4.1 Flash 전환 공지',DEEPSEEK_RELEASE],
 ['OpenAI API',OAI],['Claude API',CLAUDE],['xAI API',XAI],['Gemini API',GOOGLE],
 ['ChatGPT Pro 요금제',PRO],['Claude Max 요금제',MAX],['Cursor 구독',CURSOR],['Ollama 토큰 단가·구독',OLLAMA],['Grok 구독',GROK],['Cursor Composer 2.5 토큰 단가',COMPOSER],['GPT-5.4 mini 토큰 단가',MINI],['Devin 모델 단가',DEVIN],
].map(([label,url])=>({label,url,checkedAt:[DEVIN,CLAUDE].includes(url)?'2026-09-15':[OAI,XAI,OLLAMA,COMPOSER,MINI,GO_PRICING,DEEPSEEK_PRICING,DEEPSEEK_RELEASE].includes(url)?CHECKED_AT:'2026-09-09'}));
// Tuple: input, output, cache read, cache write. Only exact model IDs are accepted.
const rates = {
 'gpt-6-astra':[10,50,1,12.5,OAI],
 'gpt-5.6-sol':[4,20,.4,5,OAI],
 // Installed OpenCodex expected-prices.ts maps this native selector to Sol.
 // Keep it local-catalog until independently verified against a public price source.
 'gpt-daybreak-blue-latest':[4,20,.4,5,OAI,'local-catalog'],
 'gpt-5.6-terra':[2,12,.2,2.5,OAI],
 'gpt-5.6-luna':[.2,1.2,.02,.25,OAI],
 // OpenAI documents a 400k context window but no long-context or Fast-mode tuple.
 'gpt-5.4-mini':[.75,4.5,.075,null,OAI,'unknown-long-context-and-fast'],
 'claude-fable-5-1':[10,50,.25,12.5,CLAUDE],
 'claude-fable-5':[10,50,1,12.5,CLAUDE],
 'claude-sonnet-5':[2,10,.2,2.5,CLAUDE],
 'claude-opus-5':[5,25,.5,6.25,CLAUDE],
 'claude-opus-4-6':[5,25,.5,6.25,CLAUDE],
 'grok-4.6':[2,6,.5,0,XAI],
 'grok-4.5':[2,6,.3,0,XAI],
 // Cursor documents its fast model and cache-read price, but no cache-write price.
 'composer-2.5-fast':[3,15,.5,null,COMPOSER,'cursor-composer'],
 // Exact installed OpenCodex 2.48.0 expected-prices.ts tuple. Official current row
 // was not located during source-open; therefore explicitly local-catalog, not official.
 'gemini-3.8-flash':[.75,3.75,.075,0,GOOGLE,'local-catalog'],
 // Devin publishes swe-2 list prices without a cache-write rate.
 'swe-2':[3,15,.3,null,DEVIN,undefined,['list-price-reference']],
};
// Ollama's new token prices are a reference for legacy GPU subscriptions.
const ollamaRates = {
 'deepseek-v4-flash':[.22,.66,.007,0,OLLAMA], 'deepseek-v4-pro':[.66,1.98,.022,0,OLLAMA],
 'gemma4':[.14,.4,.05,0,OLLAMA], 'glm-5.3':[1.4,4.4,.26,0,OLLAMA],
 'glm-5.3-flash':[.15,.5,.03,0,OLLAMA], 'glm-5.2':[1.4,4.4,.26,0,OLLAMA], 'glm-5.1':[1,3.2,.2,0,OLLAMA],
 'gpt-oss:120b':[.15,.6,.014,0,OLLAMA], 'gpt-oss:20b':[.07,.3,.035,0,OLLAMA],
 'kimi-k3':[3,15,.3,0,OLLAMA], 'kimi-k2.7-code':[.95,4,.19,0,OLLAMA], 'kimi-k2.6':[.95,4,.16,0,OLLAMA],
 'minimax-m3':[.6,2.4,.12,0,OLLAMA], 'minimax-m2.7':[.3,1.2,.06,0,OLLAMA],
 'mistral-large-3':[.5,1.5,null,0,OLLAMA], 'nemotron-3-nano':[.06,.24,null,0,OLLAMA],
 'nemotron-3-super':[.015,.6,.015,0,OLLAMA], 'nemotron-3-ultra':[.1,3,.1,0,OLLAMA],
 'qwen3.5:397b':[.6,3.6,null,0,OLLAMA],
};
const ollamaAliases = new Map();
for (const model of Object.keys(ollamaRates)) {
 ollamaAliases.set(model, model);
 ollamaAliases.set(model.includes(':') ? model+'-cloud' : model+':cloud', model);
}
for (const [tag,model] of [['deepseek-v4-flash:0731','deepseek-v4-flash'],['deepseek-v4-pro:0813','deepseek-v4-pro']]) {
 ollamaAliases.set(tag,model);ollamaAliases.set(tag+'-cloud',model);
}
export const OLLAMA_CREDIT_PLANS = Object.freeze({
 pro:Object.freeze({monthlyUsd:20,includedCreditsUsd:60,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
 max:Object.freeze({monthlyUsd:100,includedCreditsUsd:300,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
 team:Object.freeze({monthlyUsd:500,includedCreditsUsd:1000,sourceUrl:OLLAMA,checkedAt:CHECKED_AT}),
});
const valid = n => typeof n === 'number' && Number.isFinite(n) && n>=0;
const unknown = reason => ({usd:null,basis:'unknown',reason,sourceUrl:null});
const normalizedProvider = provider => typeof provider === 'string' ? provider.replace(/-(?:main|[pko][a-f0-9]{6})$/,'') : '';
const isOllamaPeak = timestamp => {
 if(!valid(timestamp)||timestamp<=0||timestamp>=8.64e15)return null;
 const time=new Date(timestamp),day=time.getUTCDay(),hour=time.getUTCHours();
 return day>=1&&day<=5&&hour>=12&&hour<18;
};
export function ollamaModelPricing(model,timestamp) {
 const canonical=ollamaAliases.get(model),rate=ollamaRates[canonical];
 if(!rate)return null;
 const peak=canonical.startsWith('deepseek-v4-')?isOllamaPeak(timestamp):false;
 if(peak===null)return null;
 const multiplier=peak?2:1;
 return {model:canonical,inputUsdPerMillion:rate[0]*multiplier,cachedInputUsdPerMillion:rate[2]===null?null:rate[2]*multiplier,outputUsdPerMillion:rate[1]*multiplier,peak,sourceUrl:OLLAMA,checkedAt:CHECKED_AT};
}
// A model ID alone never selects a price: a route names the providers that may bill a
// given source's rate. Cursor forwarding an upstream model is a deliberate entry here.
const ROUTES={
 [OAI]:['openai','openai-apikey','chatgpt','openai-multi','cursor'],
 [CLAUDE]:['anthropic','anthropic-apikey','cursor'],[XAI]:['xai','cursor'],[GOOGLE]:['cursor','google'],[COMPOSER]:['cursor'],
 [DEVIN]:['devin','devin-cli'],
};
// A promotional rate with a published end. The successor tariff is not verified here,
// so a call after the endpoint stays unpriced instead of inheriting the promotion.
// Same shape as the Go V4 Pro transition in opencode-pricing.mjs.
const PROMO_END={'gemini-3.8-flash':Date.parse('2027-01-01T00:00:00Z')};
const promoExpired=(model,timestamp)=>Object.hasOwn(PROMO_END,model??'')&&valid(timestamp)&&timestamp>=PROMO_END[model];

// The single selection order. priceUsage and lookupModelPrice both call this, so a
// quoted unit price cannot drift away from the amount actually charged.
function resolveModelRate(rawProvider,model,timestamp,inputTokens,catalog,isOllama) {
 const scoped=providerModelPricing(rawProvider,model,timestamp,inputTokens);
 if(scoped?.reason)return {rate:null,reason:scoped.reason};
 const nativeRate=isOllama ? Object.hasOwn(ollamaRates,model??'') ? ollamaRates[model] : null : Object.hasOwn(rates,model??'') ? rates[model] : null;
 const nativeApplies=nativeRate && (!ROUTES[nativeRate[4]] || ROUTES[nativeRate[4]].includes(rawProvider));
 // Hard rejection: an ended promotion must not quietly fall through to a catalog row.
 if(nativeApplies&&promoExpired(model,timestamp))return {rate:null,reason:'판촉 단가 적용 기간이 끝나 이후 단가 미확인'};
 const r=scoped?.rate ?? (nativeApplies ? nativeRate : null) ?? (!isOllama ? catalog?.(rawProvider,model,inputTokens) : null);
 if(!r&&nativeRate)return {rate:null,reason:'모델과 제공자 연결 미확인'};
 if(!r)return {rate:null,reason:'모델 단가 미확인'};
 return {rate:r,reason:null,scoped,origin:scoped?.rate ? 'provider-scoped' : nativeApplies&&r===nativeRate ? 'builtin' : 'catalog'};
}

export function priceUsage(row, { catalog, claudeCacheTtl } = {}) {
 const rawProvider=normalizedProvider(row?.provider);
 const isOllama=rawProvider==='ollama-cloud';
 const model=isOllama ? ollamaAliases.get(row?.model) : row?.model;
 const u=row?.usage;
 const resolved=resolveModelRate(rawProvider,model,row?.timestamp,u?.inputTokens,catalog,isOllama);
 if(!resolved.rate)return unknown(resolved.reason);
 const r=resolved.rate;
 if(!u||!valid(u.inputTokens)||!valid(u.outputTokens))return unknown('토큰 기록 미확인');
 if(['unreported','unsupported'].includes(row.usageStatus))return unknown('토큰 사용량 미보고');
 let read=u.cacheReadInputTokens??u.cachedInputTokens??0,write=u.cacheCreationInputTokens??0;
 if(!valid(read)||!valid(write))return unknown('캐시 기록 형식 오류');
 if(read+write>u.inputTokens&&u.cacheReadInputTokens===undefined&&u.cachedInputTokens!==undefined)read=Math.max(0,read-write);
 if(read+write>u.inputTokens)return unknown('캐시 토큰이 입력보다 큼');
 const isOpenAI=r[4]===OAI, isClaude=r[4]===CLAUDE, isXai=r[4]===XAI;
 const responseTier=row.tierOutcome?.responseServiceTier??row.responseServiceTier;
 const requestedTier=row.tierOutcome?.requestedServiceTier??row.requestedServiceTier;
 if(!responseTier&&requestedTier&&!['default','auto','standard'].includes(requestedTier))return unknown('요청한 서비스 등급의 실제 적용 여부 미확인');
 const tier=responseTier??'default';
 let mult=1;
 if(['priority','fast'].includes(tier)) {
  if(r[5]==='unknown-long-context-and-fast')return unknown('서비스 등급 단가 미확인');
  if(isOpenAI||isXai)mult=2;else return unknown('서비스 등급 단가 미확인');
 } else if(tier==='flex'||tier==='batch') {
  if(isOpenAI)mult=.5;else return unknown('서비스 등급 단가 미확인');
 } else if(!['default','auto','standard'].includes(tier))return unknown('서비스 등급 미확인');
 let [inputRate,outputRate,readRate,writeRate]=r;
 // Claude cache writes bill differently by storage TTL: 5 minutes is the default
 // assumption, 1 hour costs twice the input rate. Any other requested TTL has no
 // published price, so the row stays unpriced instead of guessing.
 const claudeTtl=claudeCacheTtl??'5m';
 if(isClaude){
  if(claudeTtl!=='5m'&&claudeTtl!=='1h')return unknown('캐시 쓰기 보관 시간 단가 미확인');
  if(claudeTtl==='1h')writeRate=scaled(inputRate,2);
 }
 if(read>0&&readRate===null)return unknown('캐시 읽기 단가 미확인');
 if(write>0&&writeRate===null)return unknown('캐시 쓰기 단가 미확인');
 if (isOllama) {
  if (write>0 || (read>0 && readRate===null)) return unknown('Ollama 캐시 단가 미확인');
  const pricing=ollamaModelPricing(row?.model,row.timestamp);
  if(!pricing)return unknown(model.startsWith('deepseek-v4-')?'피크 시간 확인에 필요한 호출 시각 없음':'모델 단가 미확인');
  inputRate=pricing.inputUsdPerMillion;outputRate=pricing.outputUsdPerMillion;readRate=pricing.cachedInputUsdPerMillion;
 }

 if(isOpenAI&&u.inputTokens>272000){
  if(r[5]==='unknown-long-context-and-fast')return unknown('긴 입력 단가 미확인');
  inputRate*=2;readRate*=2;writeRate*=2;outputRate*=1.5;
 }
 if(isXai&&u.inputTokens>=200000){
  if(mult!==1)return unknown('긴 입력과 우선 처리 결합 단가 미확인');
  inputRate*=2;readRate*=2;outputRate*=2;
 }
 // outputTokens already contains reasoning; inputTokens already contains cache reads/writes.
 const usd=((u.inputTokens-read-write)*inputRate+u.outputTokens*outputRate+read*readRate+write*writeRate)/1e6*mult;
 if(!valid(usd))return unknown('환산액 범위 초과');
 const assumed=(isClaude&&write>0)||u.estimated===true||row.usageStatus==='estimated'||r[5]==='local-catalog';
 return {usd,basis:assumed?'local-catalog':'official',sourceUrl:r[4],reason:assumed?`추정 토큰·로컬 단가 또는 ${claudeTtl==='1h'?'1시간':'5분'} 캐시 쓰기 가정 포함`:null};
}

// Evidence grade, kept separate from the calculation's own `basis`. `basis` stays a
// two-value estimate flag persisted with every usage row and read back as
// localPriceRequests, so it must not carry a third meaning. These rows are prices the
// installed OCX publishes with its own source and check date: weaker than opening the
// provider's page ourselves, stronger than an anonymous catalog row.
const OCX_RELEASE='OpenCodex 2.55.0 expected-prices.ts';
const OCX_EVIDENCE={
 'openai\0gpt-daybreak-blue-latest':{detail:`${OCX_RELEASE} · gpt-5.6-sol 별칭에서 파생`,checkedAt:'2026-08-11',conditions:['alias-derived']},
 'google\0gemini-3.8-flash':{detail:`${OCX_RELEASE} · 확인 상태 verified`,checkedAt:'2026-09-03',conditions:[]},
 'cursor\0gemini-3.8-flash':{detail:`${OCX_RELEASE} · 확인 상태 verified`,checkedAt:'2026-09-03',conditions:[]},
};
const SOURCE_CHECKED_AT=new Map(pricingSources.map(s=>[s.url,s.checkedAt]));
export const PRICE_CONDITIONS=Object.freeze({
 'long-context':'입력이 임계값을 넘으면 단가가 오릅니다.',
 'service-tier-priority':'priority·fast 등급은 2배입니다.',
 'service-tier-discount':'flex·batch 등급은 0.5배입니다.',
 'peak-hours':'제공자가 정한 피크 시간대에는 단가가 2배입니다.',
 'promotional':'공표된 기간까지만 적용되는 판촉 단가입니다.',
 'alias-derived':'별칭이 가리키는 모델의 단가에서 파생했습니다.',
 'cache-write-assumed':'캐시 쓰기는 5분 보관 단가를 가정합니다.',
 'cache-write-1h-assumed':'캐시 쓰기는 1시간 보관 단가를 가정합니다.',
 'list-price-reference':'할인·무료 프로모션을 제외한 API 정가 환산입니다.',
});
// null is "not published" and 0 is "free". Plain multiplication would turn the first
// into the second, so every conditional rate adjustment goes through this.
const scaled=(n,m)=>n===null||n===undefined?null:n*m;
const tupleRates=t=>({input:t[0]??null,output:t[1]??null,cacheRead:t[2]??null,cacheWrite:t[3]??null});

/**
 * Unit price for one provider and one exact model ID, with its source, check date,
 * effective window and conditions. Answers whether a PRICE exists for the given
 * conditions; whether a given usage row can be valued is priceUsage's separate question.
 * Never returns another provider's rate: the provider is part of the key.
 */
export function lookupModelPrice(provider, model, options) {
 // A caller passing null is asking for the unconditioned price, not an exception.
 const given=options!==null&&typeof options==='object'?options:{};
 const {timestamp,inputTokens,catalog,claudeCacheTtl}=given;
 const rawProvider=normalizedProvider(provider);
 const isOllama=rawProvider==='ollama-cloud';
 const requestedModel=typeof model==='string'&&model?model:null;
 const canonical=isOllama?ollamaAliases.get(requestedModel)??null:requestedModel;
 const empty={provider:rawProvider,model:canonical??requestedModel,requestedModel,unit:'usd-per-million-tokens',
  status:'unpriced',rates:{input:null,output:null,cacheRead:null,cacheWrite:null},tierMultiplier:null,
  sourceUrl:null,checkedAt:null,effectiveFrom:null,effectiveTo:null,conditions:[],unsupported:[],conflict:null,reason:null};
 const no=reason=>({...empty,reason});
 if(!rawProvider)return no('제공자 ID가 없습니다.');
 if(!requestedModel)return no('모델 ID가 없습니다.');
 // Same tier precedence and same rule as priceUsage: a requested-only tier is fine
 // when it is an ordinary one, and unproven priority is not.
 const responseTier=given.tierOutcome?.responseServiceTier??given.responseServiceTier;
 const requestedTier=given.tierOutcome?.requestedServiceTier??given.requestedServiceTier;
 if(!responseTier&&requestedTier&&!['default','auto','standard'].includes(requestedTier))return no('요청한 서비스 등급의 실제 적용 여부 미확인');
 const tier=responseTier??'default';
 const resolved=resolveModelRate(rawProvider,canonical,timestamp,inputTokens,catalog,isOllama);
 if(!resolved.rate)return no(resolved.reason);
 const r=resolved.rate,fromCatalog=resolved.origin==='catalog';
 const isOpenAI=r[4]===OAI,isClaude=r[4]===CLAUDE,isXai=r[4]===XAI;
 let mult=1;
 if(['priority','fast'].includes(tier)){
  if(r[5]==='unknown-long-context-and-fast')return no('서비스 등급 단가 미확인');
  if(isOpenAI||isXai)mult=2;else return no('서비스 등급 단가 미확인');
 } else if(tier==='flex'||tier==='batch'){
  if(isOpenAI)mult=.5;else return no('서비스 등급 단가 미확인');
 } else if(!['default','auto','standard'].includes(tier))return no('서비스 등급 미확인');
 let {input,output,cacheRead,cacheWrite}=tupleRates(r);
 const unsupported=[];
 // Same TTL rule as priceUsage: 1-hour Claude cache writes cost twice the input
 // rate, and an unsupported TTL prices nothing.
 const claudeTtl=claudeCacheTtl??'5m';
 if(isClaude){
  if(claudeTtl!=='5m'&&claudeTtl!=='1h')return no('캐시 쓰기 보관 시간 단가 미확인');
  if(claudeTtl==='1h')cacheWrite=scaled(input,2);
 }
 if(isOllama){
  const published=ollamaModelPricing(requestedModel,timestamp);
  if(!published)return no(canonical?.startsWith('deepseek-v4-')?'피크 시간 확인에 필요한 호출 시각 없음':'모델 단가 미확인');
  input=published.inputUsdPerMillion;output=published.outputUsdPerMillion;cacheRead=published.cachedInputUsdPerMillion;
  // The tuple slot reads 0, but the calculation refuses any positive cache write here.
  // Publishing 0 would advertise a free write the valuation will not honour.
  cacheWrite=null;unsupported.push('cache-write');
 }
 if(isOpenAI&&valid(inputTokens)&&inputTokens>272000){
  if(r[5]==='unknown-long-context-and-fast')return no('긴 입력 단가 미확인');
  input=scaled(input,2);cacheRead=scaled(cacheRead,2);cacheWrite=scaled(cacheWrite,2);output=scaled(output,1.5);
 }
 if(isXai&&valid(inputTokens)&&inputTokens>=200000){
  if(mult!==1)return no('긴 입력과 우선 처리 결합 단가 미확인');
  input=scaled(input,2);cacheRead=scaled(cacheRead,2);output=scaled(output,2);
 }
 const ocx=OCX_EVIDENCE[`${rawProvider}\0${canonical}`];
 const conditions=new Set(resolved.scoped?.conditions??[]);
 if(isOpenAI&&r[5]!=='unknown-long-context-and-fast')conditions.add('long-context');
 if(isXai)conditions.add('long-context');
 // Declare only the tiers this provider, model and input size actually price. xAI has
 // no flex or batch, gpt-5.4-mini has no priced priority, and xAI above its long-input
 // threshold cannot combine the two, so none of those may be advertised.
 const tierUnknown=r[5]==='unknown-long-context-and-fast';
 const longXai=isXai&&valid(inputTokens)&&inputTokens>=200000;
 if((isOpenAI||isXai)&&!tierUnknown&&!longXai)conditions.add('service-tier-priority');
 if(isOpenAI)conditions.add('service-tier-discount');
 if(isOllama&&canonical?.startsWith('deepseek-v4-'))conditions.add('peak-hours');
 if(isClaude&&cacheWrite!==null)conditions.add(claudeTtl==='1h'?'cache-write-1h-assumed':'cache-write-assumed');
 for(const id of ocx?.conditions??[])conditions.add(id);
 for(const id of Array.isArray(r[6])?r[6]:[])conditions.add(id);
 let effectiveTo=resolved.scoped?.effectiveTo??null;
 if(!fromCatalog&&Object.hasOwn(PROMO_END,canonical??'')){conditions.add('promotional');effectiveTo=new Date(PROMO_END[canonical]).toISOString();}
 // A lower-priority source disagrees only when it states a different number for the
 // SAME conditions, so both sides are compared after their own conditions are applied.
 // The catalog expresses context thresholds and nothing else: under an applied service
 // tier or an active peak multiplier it makes no comparable claim, and its silence is
 // not agreement. An omitted field is likewise no claim at all.
 // Effective rates are products of published decimals, so 1.2 * 1.5 is 1.7999999999999998
 // and a strict comparison would call that a different price from 1.8.
 const differs=(a,b)=>Math.abs(a-b)>1e-9*Math.max(1,Math.abs(a),Math.abs(b));
 const comparable=['default','auto','standard'].includes(tier)&&resolved.scoped?.peak!==true;
 const alternate=!isOllama&&!fromCatalog&&comparable?catalog?.(rawProvider,canonical,inputTokens):null;
 const effective=[input,output,cacheRead,cacheWrite];
 // A 1-hour cache write is a different condition than the catalog's default write
 // rate, so under that option the write slot is not a comparable claim.
 const conflict=alternate&&[0,1,2,3].some(i=>!(isClaude&&claudeTtl==='1h'&&i===3)&&alternate[i]!=null&&effective[i]!=null&&differs(alternate[i],effective[i]))
  ? {status:'local-catalog',rates:tupleRates(alternate),reason:'로컬 카탈로그가 다른 단가를 제시합니다. 우선순위가 높은 근거를 사용했습니다.'} : null;
 return {...empty,
  status:fromCatalog?'local-catalog':ocx?'ocx-provided':r[5]==='local-catalog'?'local-catalog':'official',
  rates:{input,output,cacheRead,cacheWrite},tierMultiplier:mult,
  sourceUrl:fromCatalog?null:r[4]??null,
  checkedAt:fromCatalog?null:ocx?.checkedAt??SOURCE_CHECKED_AT.get(r[4])??null,
  effectiveFrom:resolved.scoped?.effectiveFrom??null,effectiveTo,
  conditions:[...conditions],unsupported,conflict,
  reason:ocx?.detail??null};
}
