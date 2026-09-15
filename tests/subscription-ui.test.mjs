import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionState, loadSubscriptions, reconcileSubscriptionDrafts} from '../public/subscriptions.js';

test('older catalog load cannot replace a newer selection response', async () => {
  const original = globalThis.fetch, pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  try {
    const state = subscriptionState(), older = loadSubscriptions(state), newer = loadSubscriptions(state);
    pending[1]({ok:true,json:async()=>({plans:[],selections:[{planId:'new'}]})}); await newer;
    pending[0]({ok:true,json:async()=>({plans:[],selections:[{planId:'old'}]})}); await older;
    assert.equal(state.catalog.selections[0].planId,'new');
  } finally {globalThis.fetch = original;}
});

test('drafts clear on observed identity invalidation/removal and survive normal refresh', () => {
  const state = subscriptionState(), key = JSON.stringify(['openai','a1']);
  const snapshot = basis => ({providers:[{id:'openai',accounts:[{id:'a1',analytics:{subscription:{basis}}}]}]});
  state.drafts.set(key,'openai:plus'); state.messages.set(key,{text:'unsaved'});
  reconcileSubscriptionDrafts(state,snapshot('unselected'),snapshot('unselected'));
  assert.equal(state.drafts.get(key),'openai:plus');
  reconcileSubscriptionDrafts(state,snapshot('unselected'),snapshot('unbound'));
  assert.equal(state.drafts.size,0); assert.equal(state.messages.size,0);
  state.drafts.set(key,'openai:plus');
  reconcileSubscriptionDrafts(state,snapshot('unbound'),{providers:[]});
  assert.equal(state.drafts.size,0);
});

 test('identity context change clears even an unselected draft',()=>{
  const state=subscriptionState(),key=JSON.stringify(['openai','a1']);
  const snap=selectionContext=>({providers:[{id:'openai',accounts:[{id:'a1',analytics:{subscription:{basis:'unselected',selectionContext}}}]}]});
  state.drafts.set(key,'openai:plus');
  reconcileSubscriptionDrafts(state,snap('old'),snap('new'));
  assert.equal(state.drafts.size,0);
});
