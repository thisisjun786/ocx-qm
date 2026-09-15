import {readFile} from 'node:fs/promises';
import {openSubscriptions, DEFAULT_CATALOG, validateCatalog} from '../src/subscriptions.mjs';
const args = process.argv.slice(2);
const validateOnly=args[0]==='--validate';
if (validateOnly) args.shift();
if (args.length > 1) {console.error('Usage: npm run import:subscriptions -- [catalog.json]');process.exitCode=1;}
else {
  let store;
  try {
    const catalogPath=args[0] ?? process.env.QUOTA_SUBSCRIPTION_CATALOG ?? DEFAULT_CATALOG;
    if (validateOnly) {
      const catalog=validateCatalog(JSON.parse(await readFile(catalogPath,'utf8')));
      console.log(JSON.stringify({status:'valid',plans:catalog.plans.length}));
    } else {
    store=await openSubscriptions({dataDir:process.env.QUOTA_DATA_DIR,catalogPath});
    const result=await store.importFile(catalogPath);
    console.log(JSON.stringify(result));
    if (result.status==='catalog-unavailable') process.exitCode=1;
    }
  } catch {console.error('Subscription catalog import failed; existing settings were retained.');process.exitCode=1;}
  finally {store?.close();}
}
