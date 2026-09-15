import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendSubscriptions } from '../src/recommendation.mjs';
const now=1800000000000, DAY=86400000;
function fixture({days=30,dollars=6000,peak=300,short=false,weeklyDollars=dollars/Math.min(days,30)*Math.min(days,7)}={}) {
 const account=()=>({plan:'pro',status:'ok',analytics:{subscription:{monthlyUsd:200,label:'Pro'}},windows:[
  {id:'weekly',analytics:{capacityApiUsd:1000,confidence:'medium'}},
  ...(short?[{id:'five-hour',analytics:{capacityApiUsd:100,confidence:'medium'}}]:[]),
 ]});
 return {provider:{id:'openai',accounts:[account(),account()],analytics:{periods:{weekly:{apiUsd:weeklyDollars},monthly:{apiUsd:dollars,unknownPriceRequests:0,localPriceRequests:0}}}},
 store:{pricedBounds:(_provider,from)=>({since:Math.max(now-days*DAY,from)}),peakFiveHour:()=>peak}};
}
test('missing costs or no measured weekly capacity keep recommendations collecting',()=>{
 for(const mutate of [p=>p.analytics.periods.monthly.apiUsd=null,p=>p.accounts.forEach(a=>a.windows[0].analytics.capacityApiUsd=null)]) {
  const {provider,store}=fixture();mutate(provider);const r=recommendSubscriptions(provider,store,now);assert.equal(r.status,'collecting');assert.equal(r.recommendedAccounts,null);
 }
});
test('30-day work normalizes to weekly demand and 20% spare utilization',()=>{
 const {provider,store}=fixture();const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyDemandApiUsd,1400);assert.equal(r.minimumAccounts,2);assert.equal(r.recommendedAccounts,2);assert.equal(r.additionalAccounts,0);assert.equal(r.estimatedMonthlyUsd,400);assert.equal(r.status,'ready');
});
test('peak five-hour work can need more accounts than weekly average',()=>{
 const {provider,store}=fixture({short:true});const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.peakFiveHourAccounts,3);assert.equal(r.minimumAccounts,3);assert.equal(r.recommendedAccounts,4);assert.equal(r.additionalAccounts,2);assert.equal(r.estimatedMonthlyUsd,800);
});
test('short histories stay provisional and sub-day histories do not produce recommendations',()=>{
 let f=fixture({days:7,dollars:1400});assert.equal(recommendSubscriptions(f.provider,f.store,now).status,'provisional');
 f=fixture({days:.5});assert.equal(recommendSubscriptions(f.provider,f.store,now).recommendedAccounts,null);
});
test('model-specific caps and local-catalog estimates retain provisional status',()=>{
 const f=fixture();f.provider.accounts[0].windows.push({id:'custom-0',usedPercent:30});assert.equal(recommendSubscriptions(f.provider,f.store,now).status,'provisional');
});


test('unknown calls are skipped while known costs still produce a provisional recommendation',()=>{
 const {provider,store}=fixture();provider.analytics.periods.monthly.unknownPriceRequests=141;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyDemandApiUsd,1400);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
 assert.match(r.reason,/미확인 사용은 제외/);
});
test('partial weekly and five-hour capacities remain usable as provisional estimates',()=>{
 const {provider,store}=fixture({short:true});
 for(const a of provider.accounts) for(const w of a.windows) w.analytics.capacityBasis='lower-bound';
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.recommendedAccounts,4);assert.equal(r.status,'provisional');
 // A conservative capacity raises the count for RECORDED demand only. Demand is read
 // from the same log, so the reason must not present the count as an upper bound.
 assert.match(r.reason,/기록되지 않은 사용이 있으면 실제 필요량은 이보다 클 수도 있습니다/);
 assert.doesNotMatch(r.reason,/상한/);
 provider.accounts[0].windows[1].analytics.capacityApiUsd=null;
 assert.equal(recommendSubscriptions(provider,store,now).recommendedAccounts,4);
});


test('different plans and widely different capacities use the arithmetic mean',()=>{
 const {provider,store}=fixture({dollars:15000});
 provider.accounts[0].plan='plus';provider.accounts[0].windows[0].analytics.capacityApiUsd=100;
 provider.accounts[1].windows[0].analytics.capacityApiUsd=1000;
 provider.accounts.push({...provider.accounts[1],windows:[{id:'weekly',analytics:{capacityApiUsd:4000,confidence:'medium'}}]});
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.weeklyCapacityPerAccountUsd,1700);assert.equal(r.capacitySampleAccounts,3);assert.equal(r.recommendedAccounts,3);
});
test('one measured account supplies the baseline despite unknown plans and prices',()=>{
 const {provider,store}=fixture();
 for(const a of provider.accounts){a.plan=null;a.analytics.subscription.monthlyUsd=null;}
 provider.accounts[0].windows[0].analytics.capacityApiUsd=null;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.capacitySampleAccounts,1);assert.equal(r.weeklyCapacityPerAccountUsd,1000);assert.equal(r.recommendedAccounts,2);
 assert.equal(r.currentAccounts,2);assert.equal(r.estimatedMonthlyUsd,null);assert.equal(r.status,'provisional');
});
test('missing five-hour estimates use measured peers or fall back to the weekly estimate',()=>{
 const {provider,store}=fixture({short:true});
 provider.accounts[0].windows[1].analytics.capacityApiUsd=null;
 let r=recommendSubscriptions(provider,store,now);assert.equal(r.fiveHourSampleAccounts,1);assert.equal(r.recommendedAccounts,4);
 provider.accounts[1].windows[1].analytics.capacityApiUsd=null;
 r=recommendSubscriptions(provider,store,now);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
});
test('stale and reauth accounts are excluded, measured key accounts are usable',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='reauth';provider.accounts[1].id='key:subscription';
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.currentAccounts,1);assert.equal(r.capacitySampleAccounts,1);assert.equal(r.recommendedAccounts,2);
 provider.accounts[1].status='stale';assert.equal(recommendSubscriptions(provider,store,now).recommendedAccounts,null);
});


test('recent growth is not diluted by a quiet month',()=>{
 const {provider,store}=fixture({dollars:17443,weeklyDollars:15148});
 for(const a of provider.accounts)a.windows[0].analytics.capacityApiUsd=8152;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.baselineWeeklyDemandApiUsd,17443/30*7);assert.equal(r.weeklyDemandApiUsd,15148);
 assert.equal(r.demandBasis,'recent-week');assert.equal(r.recommendedAccounts,3);
});
test('four days of priced history are not divided by thirty days',()=>{
 const {provider,store}=fixture({days:4,dollars:1341,weeklyDollars:1341});
 for(const a of provider.accounts)a.windows[0].analytics.capacityApiUsd=1843;
 const r=recommendSubscriptions(provider,store,now);
 assert.equal(r.observedDays,4);assert.equal(r.recentObservedDays,4);assert.equal(r.weeklyDemandApiUsd,2346.75);assert.equal(r.recommendedAccounts,2);
});
test('a quiet recent week does not erase the longer workload baseline',()=>{
 const {provider,store}=fixture({dollars:12000,weeklyDollars:1000});
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.weeklyDemandApiUsd,2800);assert.equal(r.demandBasis,'monthly-baseline');assert.equal(r.recommendedAccounts,4);
});

test('temporary quota failures do not remove configured subscriptions or invent additional accounts',()=>{
 for(const status of ['stale','unavailable']) {
  const {provider,store}=fixture();
  provider.accounts[0].status=status;provider.accounts[0].active=false;
  if(status==='unavailable')provider.accounts[0].windows=[];
  const r=recommendSubscriptions(provider,store,now);
  assert.equal(r.currentAccounts,2,status);assert.equal(r.capacitySampleAccounts,1,status);
  assert.equal(r.recommendedAccounts,2,status);assert.equal(r.additionalAccounts,0,status);
  assert.equal(r.status,'provisional',status);
 }
});

test('configured counts exclude paused accounts and unmeasured pay-as-you-go keys',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='paused';
 provider.accounts.push({id:'key:default',status:'unavailable',plan:null,windows:[],analytics:{subscription:{monthlyUsd:null}}});
 const r=recommendSubscriptions(provider,store,now);assert.equal(r.currentAccounts,1);assert.equal(r.additionalAccounts,1);
});

test('an expired secondary window does not exclude a fresh measured weekly window',()=>{
 const {provider,store}=fixture();provider.accounts[0].status='stale';
 provider.accounts[0].windows[0].stale=false;
 provider.accounts[0].windows.push({id:'monthly',stale:true,analytics:{capacityApiUsd:1000}});
 assert.equal(recommendSubscriptions(provider,store,now).capacitySampleAccounts,2);
 provider.accounts[0].windows[0].stale=true;
 assert.equal(recommendSubscriptions(provider,store,now).capacitySampleAccounts,1);
});

test('mixed plans and partial capacity preserve estimates without claiming a ready homogeneous cohort',()=>{
 const {provider,store}=fixture();provider.accounts[0].plan='plus';
 let r=recommendSubscriptions(provider,store,now);
 assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
 provider.accounts[0].plan='pro';provider.accounts[0].windows[0].analytics.capacityBasis='partial';
 r=recommendSubscriptions(provider,store,now);assert.equal(r.recommendedAccounts,2);assert.equal(r.status,'provisional');
});
