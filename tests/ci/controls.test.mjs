import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {selectChecks,planFromGit} from '../../scripts/ci/plan.mjs';
import {aggregate} from '../../scripts/ci/gate.mjs';
const input={baseRef:'dev',headRef:'codex/fix',baseRepo:'owner/qm',headRepo:'fork/qm'};
const needs=(app='true',release='false')=>({changes:{result:'success',outputs:{app,release}},...Object.fromEntries(['check','tests','browser','macos'].map(j=>[j,{result:app==='true'?'success':'skipped'}]))});

test('only explicit prose is cheap; control, unknown, mixed, deleted and empty changes run every job',()=>{
  assert.deepEqual(selectChecks({...input,paths:['README.md','DESIGN.md']}),{app:false,release:false});
  for(const paths of [[],['src/a.mjs'],['AGENTS.md'],['POLICY.md'],['.github/workflows/ci.yml'],['package.json'],['tests/a.test.mjs'],['README.md','src/a.mjs'],['new-doc.md'],['src/prompt.md']]) assert.equal(selectChecks({...input,paths}).app,true);
  assert.equal(selectChecks({...input,baseRef:'codex/parent',paths:['src/a.mjs']}).app,true);
  for(const paths of [null,[''],[42]]) assert.throws(()=>selectChecks({...input,paths}));
});
test('release requires same-repository dev and always runs full verification',()=>{
  for(const override of [{headRef:'fix'},{headRef:'dev',headRepo:'fork/qm'}]) assert.throws(()=>selectChecks({...input,baseRef:'main',paths:['README.md'],...override}));
  assert.deepEqual(selectChecks({...input,baseRef:'main',headRef:'dev',headRepo:'owner/qm',paths:['README.md']}),{app:true,release:true});
});
test('gates reject every missing, cancelled, malformed or unexpected result',()=>{
  assert.equal(aggregate(needs(),'false'),'dev-gate: passed');
  assert.equal(aggregate(needs('false'),'false'),'dev-gate: passed');
  assert.equal(aggregate(needs('true','true'),'true'),'release-gate: passed');
  for(const job of ['changes','check','tests','browser','macos']) for(const status of ['failure','cancelled','skipped',null,'pending']) {
    const n=needs();n[job].result=status;assert.throws(()=>aggregate(n,'false'));
  }
  for(const job of ['changes','check','tests','browser','macos']) {const n=needs();delete n[job];assert.throws(()=>aggregate(n,'false'));}
  for(const bad of [true,'',null,'yes']) {const n=needs();n.changes.outputs.app=bad;assert.throws(()=>aggregate(n,'false'));}
  assert.throws(()=>aggregate({...needs(),extra:{result:'success'}},'false'));
  assert.throws(()=>aggregate(needs('false','true'),'true'));
  assert.throws(()=>aggregate(needs('true','false'),'true'));
  assert.throws(()=>aggregate(needs(),'garbage'));
  const docs=needs('false');docs.tests.result='success';assert.throws(()=>aggregate(docs,'false'));
});
test('real Git diff sees both rename sides and verifies the actual combined candidate',t=>{
  const cwd=mkdtempSync(join(tmpdir(),'qm-ci-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-b','dev');git('config','user.name','CI test');git('config','user.email','ci@example.test');
  writeFileSync(join(cwd,'runtime.mjs'),'export const value=1;\n');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');
  git('checkout','-b','feature');git('mv','runtime.mjs','README.md');git('commit','-m','rename');const head=git('rev-parse','HEAD');
  git('checkout','dev');git('merge','--no-ff','feature','-m','candidate');const candidate=git('rev-parse','HEAD');
  const env={BASE_SHA:base,HEAD_SHA:head,BASE_REF:'dev',HEAD_REF:'feature',BASE_REPO:'owner/qm',HEAD_REPO:'owner/qm',GITHUB_SHA:candidate};
  const plan=planFromGit(env,cwd);assert.equal(plan.app,true);assert.deepEqual(plan.paths,['README.md','runtime.mjs']);
  assert.throws(()=>planFromGit({...env,HEAD_SHA:base},cwd));
  assert.throws(()=>planFromGit({...env,GITHUB_SHA:head},cwd));
  assert.throws(()=>planFromGit({...env,BASE_SHA:'z'.repeat(40)},cwd));
  git('checkout','feature');assert.throws(()=>planFromGit({...env,GITHUB_SHA:head},cwd));
});
