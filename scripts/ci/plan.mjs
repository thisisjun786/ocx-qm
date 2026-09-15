import {appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const prose = new Set(['README.md','CONTRIBUTING.md','SECURITY.md','DESIGN.md','LICENSE']);
const shaPattern = /^[a-f0-9]{40}$/;
export function selectChecks({paths,baseRef,headRef,baseRepo,headRepo}) {
  for(const value of [baseRef,headRef,baseRepo,headRepo]) if(typeof value!=='string'||!value.trim()) throw Error('Missing PR identity');
  if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!p)) throw Error('Invalid changed paths');
  const release=baseRef==='main';
  if(release && (headRef!=='dev'||headRepo!==baseRepo)) throw Error('main accepts only this repository’s dev branch');
  return {app:release||paths.length===0||!paths.every(p=>prose.has(p)),release};
}
export function planFromGit(env=process.env, cwd=process.cwd()) {
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trimEnd();
  for(const key of ['BASE_SHA','HEAD_SHA']) if(!shaPattern.test(env[key]??'')||git('cat-file','-t',env[key])!=='commit') throw Error('Invalid '+key);
  const candidate=git('rev-parse','HEAD'),parents=git('show','-s','--format=%P','HEAD').split(' ');
  if(candidate!==env.GITHUB_SHA||parents.length!==2||parents[0]!==env.BASE_SHA||parents[1]!==env.HEAD_SHA) throw Error('Checkout is not the expected PR merge candidate');
  const mergeBase=git('merge-base',env.BASE_SHA,env.HEAD_SHA);
  // No rename detection: removed application paths cannot disappear behind a docs destination.
  const raw=execFileSync('git',['diff','--name-only','--no-renames','-z',mergeBase,env.HEAD_SHA,'--'],{cwd,encoding:'utf8'});
  if(raw&&!raw.endsWith('\0')) throw Error('Invalid NUL-delimited diff');
  const paths=raw?raw.slice(0,-1).split('\0'):[];
  git('diff','--check',mergeBase,'HEAD','--');
  return {...selectChecks({paths,baseRef:env.BASE_REF,headRef:env.HEAD_REF,baseRepo:env.BASE_REPO,headRepo:env.HEAD_REPO}),candidate,base:env.BASE_SHA,head:env.HEAD_SHA,paths};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const plan=planFromGit();
    const output=`app=${plan.app}\nrelease=${plan.release}\n`;
    if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,output);
    if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## CI candidate\nBase: ${plan.base}\n\nHead: ${plan.head}\n\nCandidate: ${plan.candidate}\n\nChanged paths: ${plan.paths.length}; app=${plan.app}; release=${plan.release}\n`);
    console.log(output);
  } catch(error) {console.error('[ci-plan]',error.message);process.exitCode=1;}
}
