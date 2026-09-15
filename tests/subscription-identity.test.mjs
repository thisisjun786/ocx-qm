import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readSnapshot,ACCOUNT_BINDINGS} from '../src/snapshot.mjs';
import {credentialBinding} from '../src/subscription-identity.mjs';

test('credential bindings support existing OAuth fields and distinguish replacement from refresh',()=>{
  const a=credentialBinding('anthropic',{accountId:'person-a',access:'token-one'});
  assert.ok(a);assert.equal(a,credentialBinding('anthropic',{accountId:'person-a',access:'token-two'}));
  assert.notEqual(a,credentialBinding('anthropic',{accountId:'person-b',access:'token-one'}));
  assert.notEqual(credentialBinding('anthropic',{access:'opaque-one'}),credentialBinding('anthropic',{access:'opaque-two'}));
  assert.equal(credentialBinding('openai',{account_id:'present-but-logged-out'}),null);
});

test('real snapshot binds native login, pool and unmatched default key without JSON disclosure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'qm-bind-')),home=join(dir,'ocx'),native=join(dir,'codex');
  await mkdir(home);await mkdir(native);t.after(()=>rm(dir,{recursive:true,force:true}));
  const write=(path,obj)=>writeFile(path,JSON.stringify(obj));
  const config={providers:{openai:{},anthropic:{},cursor:{apiKey:'UNMATCHED-KEY',apiKeyPool:[{id:'one',key:'POOL-KEY'}]}},codexAccounts:[{id:'pool-a'}]};
  await write(join(home,'config.json'),config);
  await write(join(home,'auth.json'),{anthropic:{accounts:[{id:'a',credential:{access:'ACCESS-SECRET',accountId:'person-a'}}]}});
  await write(join(home,'codex-accounts.json'),{'pool-a':{accessToken:'POOL-TOKEN',accountId:'pool-person'}});
  await write(join(native,'auth.json'),{tokens:{account_id:'native-person',access_token:'NATIVE-TOKEN'}});
  const first=await readSnapshot(home,Date.now(),native),bindings=first[ACCOUNT_BINDINGS];
  for(const key of ['openai\0__main__','openai\0pool-a','anthropic\0a','cursor\0key:one','cursor\0key:default']) assert.match(bindings.get(key),/^[a-f0-9]{64}$/);
  const serialized=JSON.stringify(first);
  for(const hidden of ['ACCESS-SECRET','NATIVE-TOKEN','POOL-KEY','person-a',...bindings.values()]) assert.ok(!serialized.includes(hidden));
  await write(join(native,'auth.json'),{tokens:{account_id:'native-replacement',access_token:'NEW-TOKEN'}});
  assert.notEqual((await readSnapshot(home,Date.now(),native))[ACCOUNT_BINDINGS].get('openai\0__main__'),bindings.get('openai\0__main__'));
  await write(join(native,'auth.json'),{});
  assert.equal((await readSnapshot(home,Date.now(),native))[ACCOUNT_BINDINGS].get('openai\0__main__'),null);
  config.providers.cursor.apiKeyPool.push({id:'one',key:'CONFLICTING-KEY'});await write(join(home,'config.json'),config);
  assert.equal((await readSnapshot(home,Date.now(),native))[ACCOUNT_BINDINGS].get('cursor\0key:one'),null);
});
