import {pathToFileURL} from 'node:url';
const checks=['check','tests','browser','macos'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bool=value=>{if(value!=='true'&&value!=='false') throw Error('Expected literal true/false');return value==='true';};
export function aggregate(needs, expectedRelease) {
  const releaseExpected=bool(expectedRelease);
  if(!object(needs)||!object(needs.changes)||needs.changes.result!=='success'||!object(needs.changes.outputs)) throw Error('changes must succeed with outputs');
  const app=bool(needs.changes.outputs.app),release=bool(needs.changes.outputs.release);
  if(release!==releaseExpected || (release&&!app)) throw Error('Invalid release selection');
  if(Object.keys(needs).sort().join(',')!==['changes',...checks].sort().join(',')) throw Error('Missing or unexpected job');
  for(const job of checks) {
    if(!object(needs[job])||needs[job].result!==(app?'success':'skipped')) throw Error(`${job}: expected ${app?'success':'skipped'}`);
  }
  return `${release?'release-gate':'dev-gate'}: passed`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(aggregate(JSON.parse(process.env.NEEDS_JSON),process.env.EXPECTED_RELEASE));}
  catch(error) {console.error('[ci-gate]',error.message);process.exitCode=1;}
}
