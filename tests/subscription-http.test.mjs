import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.mjs';
import {openSubscriptions} from '../src/subscriptions.mjs';
import {ACCOUNT_BINDINGS} from '../src/snapshot.mjs';
import {readSelection} from '../src/subscription-http.mjs';

test('subscription API guards writes, isolates accounts, rejects stale contexts and refreshes cache', async t => {
  const dir=await mkdtemp(join(tmpdir(),'qm-http-')),store=await openSubscriptions({dataDir:dir});
  const bindings=new Map([['openai\0a','physical-one'],['openai\0b','physical-two']]);
  const snapshot=async()=>({schemaVersion:1,providers:[{id:'openai',accounts:['a','b'].map(id=>({id,analytics:{subscription:store.forAccount('openai',id,bindings.get('openai\0'+id))}}))}],[ACCOUNT_BINDINGS]:bindings});
  const server=createApp({subscriptions:store,snapshot}); server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();await rm(dir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+server.address().port;
  const input={provider:'openai',account:'a',planId:'openai:plus',selectionContext:store.forAccount('openai','a','physical-one').selectionContext};
  const put=(body=input,headers={})=>fetch(origin+'/api/v1/subscriptions/selection',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  assert.equal((await put(input,{Origin:''})).status,403);
  assert.equal((await put(input,{Origin:'https://foreign.test'})).status,403);
  assert.equal((await put(input,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await put('x'.repeat(4097))).status,413);
  assert.equal((await put('{')).status,400);
  assert.equal((await put({...input,monthlyUsd:1})).status,400);
  assert.equal((await put({...input,account:'absent'})).status,404);
  assert.equal((await put({...input,planId:'cursor:pro'})).status,422);
  await fetch(origin+'/api/v1/snapshot');
  assert.equal((await put()).status,200);
  assert.equal((await put()).status,200);
  const rows=(await (await fetch(origin+'/api/v1/snapshot')).json()).providers[0].accounts;
  assert.equal(rows[0].analytics.subscription.monthlyUsd,20);assert.equal(rows[1].analytics.subscription.monthlyUsd,null);
  bindings.set('openai\0a','replacement');
  assert.equal((await put()).status,409);
  const list=await (await fetch(origin+'/api/v1/subscriptions')).json();
  assert.equal(list.selections.length,0);assert.ok(!JSON.stringify(list).includes('physical-one'));
  bindings.set('openai\0a',null);assert.equal((await put()).status,422);
});

test('slow and chunked bodies enforce receive limits',async()=>{
  const slow=new Readable({read(){}});slow.headers={'content-type':'application/json'};
  await assert.rejects(readSelection(slow,{timeoutMs:10}),e=>e.status===408);slow.destroy();
  const oversized=Readable.from([Buffer.alloc(2048),Buffer.alloc(2049)]);oversized.headers={'content-type':'application/json'};
  await assert.rejects(readSelection(oversized),e=>e.status===413);
});
