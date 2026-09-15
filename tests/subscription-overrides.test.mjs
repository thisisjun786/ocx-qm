import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistory } from '../src/history.mjs';
import { enrichSnapshot } from '../src/analytics.mjs';
import * as pricing from '../src/pricing.mjs';
import { attributeUsage } from '../src/identity.mjs';

test('OAuth and key provider suffixes remain in provider totals without guessing account identity', () => {
  const identities = { labels: new Map([['cursor\0oabcdef', 'known-oauth']]) };
  assert.deepEqual(attributeUsage({ provider: 'cursor-oabcdef' }, identities), { provider: 'cursor', account: 'known-oauth' });
  assert.deepEqual(attributeUsage({ provider: 'ollama-cloud-kabcdef' }, identities), { provider: 'ollama-cloud', account: null });
});

test('fresh installations never select a subscription from a detected tier', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-subscription-test-'));
  const store = await openHistory(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.now(); store.set('usageReadAt', now);
  const amounts = { openai: [4, 200], anthropic: [2, 200], xai: [1, 300], cursor: [1, 200], 'ollama-cloud': [1, 100], 'opencode-go': [1, 10] };
  const snapshot = { schemaVersion: 1, providers: Object.entries(amounts).map(([id, [count]]) => ({
    id, accounts: Array.from({ length: count }, (_, i) => ({ id: 'synthetic-' + i, plan: id === 'openai' ? 'pro' : null, status: 'ok', windows: [] })),
  })) };
  const result = enrichSnapshot(snapshot, store, { plans: new Map() }, pricing, now);
  assert.equal(result.analytics.subscriptionMonthlyUsd, null);
  for (const p of result.providers) {
    assert.equal(p.analytics.subscriptionMonthlyUsd, null);
    for (const a of p.accounts) {
      assert.equal(a.analytics.subscription.monthlyUsd, null);
      assert.equal(a.analytics.subscription.basis, 'unselected');
      assert.equal(a.analytics.monthlyValueRatio, null);
    }
  }
});
