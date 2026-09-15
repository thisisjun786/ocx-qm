import {createHmac, randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir, chmod, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ACCOUNT_BINDINGS} from './subscription-identity.mjs';
export const DEFAULT_CATALOG = new URL('./subscription-catalog.json',import.meta.url);
const DAY = 86400000;
const providers = new Map([
  ['openai',['help.openai.com','openai.com']], ['anthropic',['claude.com','support.claude.com']],
  ['cursor',['cursor.com']], ['ollama-cloud',['ollama.com']], ['xai',['x.ai','grok.com']], ['opencode-go',['opencode.ai']],
]);
const cleanText = (s,max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const instant = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const error = status => Object.assign(new Error('Subscription request rejected'),{status});
const empty = basis => ({planId:null,label:null,monthlyUsd:null,basis,sourceUrl:null,checkedAt:null});
export function validateCatalog(input, now = Date.now()) {
  if (!input || input.schemaVersion !== 1 || !instant(input.revision) || Date.parse(input.revision) > now+60000 ||
    !Array.isArray(input.plans) || input.plans.length > 500 || Object.keys(input).some(k=>!['schemaVersion','revision','plans'].includes(k))) throw error(400);
  const ids = new Set();
  const plans = input.plans.map(p => {
    if (!p || !providers.has(p.provider) || !cleanText(p.id,100) || !p.id.startsWith(p.provider+':') ||
      !/^[a-z0-9:-]+$/.test(p.id) || ids.has(p.id) || !cleanText(p.label,100) || !p.label.trim() ||
      !cleanText(p.note,400) || p.currency !== 'USD' || p.billingPeriod !== 'monthly' ||
      !['official','unverified'].includes(p.status) || !instant(p.checkedAt) || Date.parse(p.checkedAt)>Date.parse(input.revision) ||
      (p.status === 'official' ? !(typeof p.monthlyUsd === 'number' && Number.isFinite(p.monthlyUsd) && p.monthlyUsd>=0 && p.monthlyUsd<=100000 && Math.abs(p.monthlyUsd*100-Math.round(p.monthlyUsd*100))<1e-7) : p.monthlyUsd !== null) ||
      Object.keys(p).some(k=>!['id','provider','label','monthlyUsd','currency','billingPeriod','sourceUrl','checkedAt','status','note'].includes(k))) throw error(400);
    let url; try {url = new URL(p.sourceUrl);} catch {throw error(400);}
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !providers.get(p.provider).includes(url.hostname)) throw error(400);
    ids.add(p.id);
    return {id:p.id,provider:p.provider,label:p.label,monthlyUsd:p.monthlyUsd,currency:'USD',billingPeriod:'monthly',sourceUrl:url.href,checkedAt:p.checkedAt,status:p.status,note:p.note};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  return {schemaVersion:1,revision:input.revision,plans};
}
export async function openSubscriptions({dataDir = join(process.env.XDG_STATE_HOME ?? join(homedir(),'.local/state'),'quota-monitor'), catalogPath = DEFAULT_CATALOG, now = Date.now} = {}) {
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const file = join(dataDir,'subscriptions.sqlite'), db = new DatabaseSync(file);
  await chmod(file,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS subscription_catalog(id TEXT PRIMARY KEY,provider TEXT NOT NULL,json TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS subscription_selections(provider TEXT NOT NULL,account TEXT NOT NULL,binding TEXT NOT NULL,plan_id TEXT NOT NULL,PRIMARY KEY(provider,account,binding));
    CREATE TABLE IF NOT EXISTS subscription_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  let diagnostic = null;
  const contextKey=randomBytes(32);
  const context=(provider,account,binding)=>createHmac('sha256',contextKey).update(JSON.stringify([provider,account,binding??null])).digest('hex');
  const effective = row => {
    const p = JSON.parse(row.json);
    const basis = row.retired ? 'retired' : p.status !== 'official' ? 'unverified' : now()-Date.parse(p.checkedAt)>30*DAY ? 'stale' : 'official-list';
    return {...p,planId:p.id,retired:!!row.retired,basis,lastQuotedUsd:p.monthlyUsd,monthlyUsd:basis==='official-list'?p.monthlyUsd:null};
  };
  const store = {
    importCatalog(input) {
      const catalog = validateCatalog(input,now()), serialized = JSON.stringify(catalog);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare("SELECT value FROM subscription_meta WHERE key='catalog'").get()?.value;
        if (previous) {
          const old = JSON.parse(previous);
          if (catalog.revision < old.revision) {db.exec('COMMIT'); return {status:'older-ignored'};}
          if (catalog.revision === old.revision) {
            if (serialized !== previous) throw error(400);
            db.exec('COMMIT'); diagnostic=null; return {status:'unchanged'};
          }
        }
        for (const p of catalog.plans) {
          const old = db.prepare('SELECT json FROM subscription_catalog WHERE id=?').get(p.id);
          if (old && JSON.parse(old.json).checkedAt > p.checkedAt) throw error(400);
        }
        db.exec('UPDATE subscription_catalog SET retired=1');
        const put = db.prepare('INSERT INTO subscription_catalog VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,json=excluded.json,retired=0');
        for (const p of catalog.plans) put.run(p.id,p.provider,JSON.stringify(p));
        db.prepare("INSERT INTO subscription_meta VALUES('catalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(serialized);
        db.exec('COMMIT'); diagnostic=null; return {status:'imported',plans:catalog.plans.length};
      } catch(e) {db.exec('ROLLBACK'); throw e;}
    },
    async importFile(path) {
      try {const result=store.importCatalog(JSON.parse(await readFile(path,'utf8'))); diagnostic=null; return result;}
      catch {diagnostic='catalog-unavailable';return {status:diagnostic};}
    },
    forAccount(provider,account,binding) {
      const decorate=sub=>({...sub,selectionContext:context(provider,account,binding)});
      if (!binding) return decorate(empty('unbound'));
      const selected = db.prepare('SELECT plan_id FROM subscription_selections WHERE provider=? AND account=? AND binding=?').get(provider,account,binding);
      if (!selected) return decorate(empty(db.prepare('SELECT 1 FROM subscription_selections WHERE provider=? AND account=?').get(provider,account) ? 'unbound' : 'unselected'));
      if (selected.plan_id === '') return decorate(empty('unselected'));
      const row = db.prepare('SELECT * FROM subscription_catalog WHERE id=?').get(selected.plan_id);
      return decorate(row ? effective(row) : empty('retired'));
    },
    list(snapshot) {
      const selections=[];
      for (const p of snapshot.providers) for (const a of p.accounts) {
        const sub=store.forAccount(p.id,a.id,snapshot[ACCOUNT_BINDINGS]?.get(p.id+'\0'+a.id));
        if (sub.planId) selections.push({provider:p.id,account:a.id,planId:sub.planId});
      }
      return {plans:db.prepare('SELECT * FROM subscription_catalog ORDER BY id').all().map(effective),selections,diagnostics:diagnostic};
    },
    select(input,snapshot) {
      if (!input || Array.isArray(input) || Object.keys(input).sort().join(',')!=='account,planId,provider,selectionContext' || !cleanText(input.provider,100) || !cleanText(input.account,200) || !input.provider || !input.account || !(input.planId===null || cleanText(input.planId,100))) throw error(400);
      const {provider,account,planId}=input;
      if (!snapshot.providers.some(p=>p.id===provider && p.accounts.some(a=>a.id===account))) throw error(404);
      const binding=snapshot[ACCOUNT_BINDINGS]?.get(provider+'\0'+account);
      if (!binding) throw error(422);
      if (input.selectionContext !== context(provider,account,binding)) throw error(409);
      db.exec('BEGIN IMMEDIATE');
      try {
      if (planId!==null) {
        const plan=db.prepare('SELECT provider,retired FROM subscription_catalog WHERE id=?').get(planId);
        if (!plan || plan.provider!==provider || plan.retired) throw error(422);
        db.prepare('INSERT INTO subscription_selections VALUES(?,?,?,?) ON CONFLICT(provider,account,binding) DO UPDATE SET plan_id=excluded.plan_id').run(provider,account,binding,planId);
      } else db.prepare("INSERT INTO subscription_selections VALUES(?,?,?,'') ON CONFLICT(provider,account,binding) DO UPDATE SET plan_id=''").run(provider,account,binding);
      const result=store.forAccount(provider,account,binding);
      db.exec('COMMIT'); return result;
      } catch(e) {db.exec('ROLLBACK');throw e;}
    },
    close() {db.close();},
  };
  await store.importFile(catalogPath);
  return store;
}
