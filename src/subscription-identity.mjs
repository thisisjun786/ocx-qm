import {createHash} from 'node:crypto';
export const ACCOUNT_BINDINGS = Symbol('subscription-account-bindings');
const text = value => typeof value === 'string' && value.length > 0 ? value : null;
export function credentialBinding(provider, credential, isKey = false) {
  if (isKey) return text(credential) ? digest(provider,'key',credential) : null;
  const token = text(credential?.accessToken) ?? text(credential?.access_token) ?? text(credential?.token) ?? text(credential?.access);
  if (!token) return null;
  let account = text(credential.accountId) ?? text(credential.account_id);
  if (!account) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      account = text(claims['https://api.openai.com/auth']?.chatgpt_account_id) ?? text(claims.sub);
    } catch { /* Opaque credentials bind conservatively to their exact token. */ }
  }
  return digest(provider,account ? 'account' : 'token',account ?? token);
}
const digest = (provider,kind,value) => createHash('sha256').update(JSON.stringify(['ocx-qm-subscription-v1',provider,kind,value])).digest('hex');
export function addBinding(bindings, provider, account, binding) {
  const key = provider+'\0'+account;
  bindings.set(key,bindings.has(key) && bindings.get(key) !== binding ? null : binding);
}
