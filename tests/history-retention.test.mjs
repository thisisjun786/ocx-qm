import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,open,rename,rm,truncate,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openHistory} from '../src/history.mjs';
const DAY=86400000,NOW=1800000000000;
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'quota-retention-'));
 const store=await openHistory(dir,options);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {dir,store};
}
const usage=(requestId,timestamp)=>({requestId,timestamp,provider:'openai',model:'m',usage:{outputTokens:1}});
const snapshot=(at,used=10)=>({providers:[{id:'openai',accounts:[{id:'a1',updatedAt:new Date(at).toISOString(),windows:[{id:'weekly',usedPercent:used,resetAt:new Date(NOW+DAY).toISOString(),stale:false}]}]}]});
test('retention removes only expired records and their timings, preserving cutoff and metadata',async t=>{
 const {store:s}=await fixture(t);const cutoff=NOW-90*DAY;
 s.db.exec('CREATE TABLE ollama_observations (source TEXT,at INTEGER,payload TEXT,PRIMARY KEY(source,at))');
 for(const [id,at] of [['old',cutoff-1],['edge',cutoff],['new',NOW]]){
  s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,at,'ollama-cloud','a','m',1,1,0,2,1,'official');
  s.db.prepare('INSERT INTO usage_timings VALUES (?,?,?,?)').run(id,1,1,1);
  s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('p','a','weekly',at,NOW+DAY,10);
  s.db.prepare('INSERT INTO ollama_observations VALUES (?,?,?)').run('test',at,'{}');
 }
 s.set('usageCursor',{offset:123});s.set('historyStartedAt',cutoff-1);
 s.maintain(NOW);
 for(const table of ['usage','samples','ollama_observations','usage_timings']) assert.equal(s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,2);
 assert.deepEqual(s.get('usageCursor'),{offset:123});assert.equal(s.get('historyStartedAt'),cutoff-1);
 s.maintain(NOW);assert.equal(s.db.prepare('SELECT count(*) n FROM usage').get().n,2);
});
test('expired source rows stay excluded on reimport while recent usage remains idempotent',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl');
 const rows=[['old',NOW-91*DAY],['new',NOW]].map(([requestId,timestamp])=>({requestId,timestamp,provider:'openai',model:'m',usage:{outputTokens:1}}));
 await writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 const ids={labels:new Map()};await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
 s.set('usageCursor',null);await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('history reset keeps the exact boundary and excludes older sources across replay and rotation',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),reset=NOW-DAY,ids={labels:new Map()};
 s.set('historyResetAt',reset);
 s.capture(snapshot(reset-1,9),NOW);s.capture(snapshot(reset,10),NOW);s.capture(snapshot(reset,10),NOW);s.capture(snapshot(reset+1,11),NOW);
 assert.deepEqual(s.points('openai','a1','weekly',0).map(row=>row.at),[reset,reset+1]);
 await writeFile(file,[usage('old',reset-1),usage('edge',reset),usage('new',reset+1)].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,2);
 s.set('usageCursor',null);s.db.prepare('DELETE FROM meta WHERE key=?').run('ollamaPricingReplayV1');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,2);
 await rename(file,join(dir,'usage.jsonl.1'));
 await writeFile(file,[usage('old-after-rotation',reset-1),usage('new-after-rotation',reset+2)].map(JSON.stringify).join('\n')+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,3);
});
test('history reset rejects an old source line completed after the reset marker',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),ids={labels:new Map()};
 const old=JSON.stringify(usage('old-partial',NOW-1));
 await writeFile(file,old.slice(0,-1));await s.ingest(file,ids,()=>({usd:1}),NOW);
 s.set('historyResetAt',NOW);
 await appendFile(file,old.slice(-1)+'\n'+JSON.stringify(usage('new-complete',NOW))+'\n');
 await s.ingest(file,ids,()=>({usd:1}),NOW);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('without a history reset marker, in-retention older sources are retained',async t=>{
 const {store:s,dir}=await fixture(t),file=join(dir,'usage.jsonl'),at=NOW-DAY;
 s.capture(snapshot(at),NOW);await writeFile(file,JSON.stringify(usage('pre-reset-default',at))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW);
 assert.equal(s.points('openai','a1','weekly',0).length,1);
 assert.equal(s.stats('openai',undefined,0,NOW).requests,1);
});
test('database page cap stops growth and leaves committed records readable',async t=>{
 const {store:s}=await fixture(t,{maxBytes:1024*1024});
 s.set('sentinel','preserved');
 s.db.exec('CREATE TABLE fill (payload BLOB)');
 assert.throws(()=>{for(let i=0;i<100;i++)s.db.exec('INSERT INTO fill VALUES (zeroblob(65536))');},/full/i);
 assert.equal(s.get('sentinel'),'preserved');
 const size=s.db.prepare('PRAGMA page_count').get().page_count*s.db.prepare('PRAGMA page_size').get().page_size;
 assert.ok(size<=1024*1024);
});

test('failed maintenance rolls back every table and its completion timestamp',async t=>{
 const {store:s}=await fixture(t);
 s.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('old',NOW-91*DAY,'p','a','m',1,1,0,2,1,'official');
 s.db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)').run('p','a','weekly',NOW-91*DAY,NOW+DAY,10);
 s.db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON samples BEGIN SELECT RAISE(ABORT,'test interruption'); END");
 assert.throws(()=>s.maintain(NOW),/test interruption/);
 assert.equal(s.stats('p',undefined,0,NOW).requests,1);
 assert.equal(s.get('lastMaintenanceAt'),null);
});

test('full-disk ingestion preserves the committed cursor for retry',async t=>{
 const {store:s,dir}=await fixture(t,{maxBytes:1024*1024});
 s.set('usageCursor',{ino:'prior',offset:0});
 const file=join(dir,'usage.jsonl');
 const rows=Array.from({length:10000},(_,i)=>JSON.stringify({requestId:String(i),timestamp:NOW,provider:'openai',model:'m'.repeat(200),usage:{outputTokens:1}}));
 await writeFile(file,rows.join('\n')+'\n');
 await assert.rejects(s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW),/full/i);
 assert.equal(s.db.isTransaction,false);
 const cursor=s.get('usageCursor');
 assert.ok(cursor.offset<Buffer.byteLength(rows.join('\n')+'\n'));
 assert.equal(s.get('usageReadAt'),null);
});

const HOUR=3600000;
const observation=s=>({since:s.get('usageObservedSince'),through:s.get('usageObservedThrough'),pending:s.get('usageTailPending')});

test('a rotated or rewritten log restarts the observation run; a pricing replay does not',async t=>{
 const {store:s,dir}=await fixture(t);
 const file=join(dir,'usage.jsonl');
 await writeFile(file,JSON.stringify(usage('one',NOW-HOUR))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR);
 assert.equal(observation(s).since,NOW-HOUR);
 // Re-reading the same file for a tariff change is not lost history.
 s.db.prepare('DELETE FROM meta WHERE key=?').run('ollamaPricingReplayV1');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR/2);
 assert.equal(observation(s).since,NOW-HOUR);
 // A different file is a different history.
 await rename(file,file+'.old');
 await writeFile(file,JSON.stringify(usage('two',NOW))+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW);
 assert.equal(observation(s).since,NOW);
});

test('truncating the log in place restarts the observation run',async t=>{
 const {store:s,dir}=await fixture(t);
 const file=join(dir,'usage.jsonl');
 await writeFile(file,Array.from({length:200},(unused,i)=>JSON.stringify(usage('r'+i,NOW-HOUR))).join('\n')+'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW-HOUR);
 assert.equal(observation(s).since,NOW-HOUR);
 await writeFile(file,'\n');
 await s.ingest(file,{labels:new Map()},()=>({usd:1,basis:'official'}),NOW);
 assert.equal(observation(s).since,NOW);
});

test('a record left unresolved holds the observed end, and losing it restarts the run',async t=>{
 const price=()=>({usd:1,basis:'official'});
 const ids={labels:new Map()};
 const complete=await fixture(t),vanished=await fixture(t);
 for(const {store:s,dir} of [complete,vanished]){
  const file=join(dir,'usage.jsonl');
  await writeFile(file,JSON.stringify(usage('first',NOW-2*HOUR))+'\n');
  await s.ingest(file,ids,price,NOW-2*HOUR);
  // A half-written final line: read, but not resolvable yet.
  await appendFile(file,JSON.stringify(usage('partial',NOW-HOUR)).slice(0,40));
  await s.ingest(file,ids,price,NOW-HOUR);
  assert.ok(observation(s).pending,'tail recorded');
  assert.equal(observation(s).through,NOW-2*HOUR,'end held at the last complete read');
 }
 // Finishing the line resolves it: the same bytes are still there.
 const file=join(complete.dir,'usage.jsonl');
 const line=JSON.stringify(usage('partial',NOW-HOUR));
 await appendFile(file,line.slice(40)+'\n');
 await complete.store.ingest(file,ids,price,NOW);
 assert.equal(observation(complete.store).since,NOW-2*HOUR);
 assert.equal(observation(complete.store).through,NOW);
 assert.equal(observation(complete.store).pending,null);
 // Dropping the pending record and appending an unrelated newline is not resolution.
 const other=join(vanished.dir,'usage.jsonl');
 await writeFile(other,JSON.stringify(usage('first',NOW-2*HOUR))+'\n'+'\n');
 await vanished.store.ingest(other,ids,price,NOW);
 assert.equal(observation(vanished.store).since,NOW);
});

test('a failed read records the break without inventing a successful read',async t=>{
 const {store:s,dir}=await fixture(t,{maxBytes:1024*1024});
 const file=join(dir,'usage.jsonl');
 const rows=Array.from({length:10000},(unused,i)=>JSON.stringify({requestId:String(i),timestamp:NOW,provider:'openai',model:'m'.repeat(200),usage:{outputTokens:1}}));
 await writeFile(file,rows.join('\n')+'\n');
 await assert.rejects(s.ingest(file,{labels:new Map()},()=>({usd:1}),NOW),/full/i);
 assert.equal(s.get('usageReadAt'),null);
 // The run start is recorded because the discontinuity is real; the endpoint is not,
 // so no span is claimed.
 assert.equal(s.get('usageObservedSince'),NOW);
 assert.equal(s.get('usageObservedThrough'),null);
});

const MiB=1024*1024,BATCH=MiB;
// Every 1 MiB chunk and the final partial chunk carry their own marker, so hashing one
// chunk repeatedly, or only a prefix, cannot produce the expected digest. No byte is a
// newline, so the whole body stays one unfinished record.
const tailBody=size=>{
 const body=Buffer.alloc(size);
 for(let i=0;i<size;i++)body[i]=97+(i%23);
 for(let off=0;off<size;off+=MiB)if(off+6<=size)body.write('CHUNK'+(off/MiB),off);
 if(size>=3)body.write('END',size-3);
 return body;
};
// Watch every buffer allocator the implementation could reach, so swapping Buffer.alloc
// for an unsafe variant cannot hide an allocation from the measurement.
const watchAllocations=()=>{
 const originals={alloc:Buffer.alloc,allocUnsafe:Buffer.allocUnsafe,allocUnsafeSlow:Buffer.allocUnsafeSlow};
 const sizes=[];
 for(const name of Object.keys(originals))
  Buffer[name]=function(length,...rest){if(typeof length==='number')sizes.push(length);return originals[name].call(Buffer,length,...rest);};
 return {sizes,restore(){for(const name of Object.keys(originals))Buffer[name]=originals[name];}};
};
const measure=async run=>{const watch=watchAllocations();try{await run();}finally{watch.restore();}return watch.sizes;};

test('verifying a tail hashes the whole range without allocating alongside it',async t=>{
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 for(const size of [64,BATCH+1,2*MiB,8*MiB]){
  const {store:s,dir}=await fixture(t);
  const file=join(dir,'usage.jsonl');
  // The large cases sit behind one complete record so the tail does not start at zero;
  // an implementation that ignored the offset would still match a zero-offset fixture.
  const prefix=size>BATCH?JSON.stringify(usage('complete',NOW-HOUR))+'\n':'';
  const from=Buffer.byteLength(prefix);
  const body=tailBody(size);
  await writeFile(file,Buffer.concat([Buffer.from(prefix),body]));
  const first=await measure(()=>s.ingest(file,ids,price,NOW-HOUR));
  assert.ok(first.length>0,size+' allocations observed');
  assert.ok(Math.max(...first)<=BATCH,size+' first read peak '+Math.max(...first));
  if(size===64)assert.equal(Math.max(...first),64);
  const pending=s.get('usageTailPending');
  assert.equal(pending.from,from,size+' tail start');
  assert.equal(pending.length,size,size+' tail length');
  assert.equal(pending.digest,createHash('sha256').update(body).digest('hex'),size+' tail digest');
  assert.equal(s.get('usageObservedThrough'),null,size+' unresolved tail holds the end');
  // The next poll re-verifies the stored range; that path must stay bounded too.
  const second=await measure(()=>s.ingest(file,ids,price,NOW));
  assert.ok(second.length>0,size+' second allocations observed');
  assert.ok(Math.max(...second)<=BATCH,size+' second read peak '+Math.max(...second));
  assert.equal(s.get('usageObservedSince'),NOW-HOUR,size+' unchanged file keeps the run');
  assert.deepEqual(s.get('usageTailPending'),pending,size+' unchanged file keeps the record');
  if(size<=BATCH+1)continue;
  // Change one byte past the first chunk, keeping the size, the first bytes and the
  // consumed boundary. Only reading the range to its end can notice.
  const handle=await open(file,'r+');
  try{await handle.write(Buffer.from([0x21]),0,1,from+BATCH+12345);}finally{await handle.close();}
  await s.ingest(file,ids,price,NOW+HOUR);
  assert.equal(s.get('usageObservedSince'),NOW+HOUR,size+' a byte past the first chunk restarts the run');
 }
});

test('a tail digest we never managed to read is not a match',async t=>{
 const {store:s,dir}=await fixture(t);
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 const file=join(dir,'usage.jsonl');
 await writeFile(file,'a'.repeat(100));
 await s.ingest(file,ids,price,NOW-HOUR);
 // The file shrank while the tail was being read, so the stored digest is null.
 s.set('usageTailPending',{from:0,length:100,digest:null});
 s.set('usageObservedSince',NOW-HOUR);
 await truncate(file,50);
 await s.ingest(file,ids,price,NOW);
 // Comparing one failed read against another must not read as an unbroken run.
 assert.equal(s.get('usageObservedSince'),NOW);
});


// Replace the file handle's read for the duration of one ingest so a read can come back
// short of what was asked without needing a filesystem that does that. Only reads larger
// than the 64-byte fingerprint are scripted, by the order in which they arrive.
const withReadFaults=async(file,script,run)=>{
 const probe=await open(file,'r');const proto=Object.getPrototypeOf(probe);await probe.close();
 const original=proto.read;
 let match=0,fired=0;
 proto.read=async function(buffer,offset,length,position){
  if(length>64){
   const behaviour=script[match++];
   if(behaviour==='short'){fired++;return original.call(this,buffer,offset,Math.max(1,Math.floor(length/2)),position);}
   if(behaviour==='none'){fired++;return {bytesRead:0,buffer};}
  }
  return original.call(this,buffer,offset,length,position);
 };
 try{await run();}finally{proto.read=original;}
 return fired;
};

test('a read that comes back short keeps hashing; one that stops short stays incomplete',async t=>{
 const ids={labels:new Map()},price=()=>({usd:1,basis:'official'});
 const body=tailBody(300);
 const start=async()=>{
  const {store:s,dir}=await fixture(t);
  const file=join(dir,'usage.jsonl');
  const prefix=JSON.stringify(usage('complete',NOW-2*HOUR))+'\n';
  await writeFile(file,Buffer.concat([Buffer.from(prefix),body]));
  return {s,file,from:Buffer.byteLength(prefix)};
 };
 const expected=createHash('sha256').update(body).digest('hex');
 // Writing the tail record: two reads finish the range that one read did not.
 const whole=await start();
 assert.equal(await withReadFaults(whole.file,[,,'short'],()=>whole.s.ingest(whole.file,ids,price,NOW)),1);
 assert.equal(whole.s.get('usageTailPending').digest,expected);
 assert.equal(whole.s.get('usageObservedThrough'),null,'the unresolved record still holds the end');
 // Stopping before the range ends leaves the record unverified, not verified.
 const stopped=await start();
 assert.equal(await withReadFaults(stopped.file,[,,'short','none'],()=>stopped.s.ingest(stopped.file,ids,price,NOW)),2);
 assert.equal(stopped.s.get('usageTailPending').digest,null);
 const empty=await start();
 assert.equal(await withReadFaults(empty.file,[,,'none'],()=>empty.s.ingest(empty.file,ids,price,NOW)),1);
 assert.equal(empty.s.get('usageTailPending').digest,null);
 // Re-verifying a stored record: the same two shapes, one poll later.
 const rechecked=await start();
 await rechecked.s.ingest(rechecked.file,ids,price,NOW-HOUR);
 assert.equal(rechecked.s.get('usageTailPending').digest,expected);
 assert.equal(await withReadFaults(rechecked.file,['short'],()=>rechecked.s.ingest(rechecked.file,ids,price,NOW)),1);
 assert.equal(rechecked.s.get('usageObservedSince'),NOW-HOUR,'a short read that finishes keeps the run');
 const broken=await start();
 await broken.s.ingest(broken.file,ids,price,NOW-HOUR);
 assert.equal(await withReadFaults(broken.file,['short','none'],()=>broken.s.ingest(broken.file,ids,price,NOW)),2);
 assert.equal(broken.s.get('usageObservedSince'),NOW,'a verification that stopped short restarts the run');
});
