/**
 * Which knowledge the agent decides a question is about — the step just before it spends money.
 *
 * `pickPatch` had no test, and it was scoring raw substring containment: measured 2026-09-07 against a throwaway
 * market, "send me the contract address of the lease we signed last April" bought a Korean ticker table for
 * 0.5 CREDIT, because "me" is inside "pixelplus-de**mo**". Nothing here reaches a network or a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '@ngram/core';
import { matchesAsWord, pickPatch } from '../src/agent.js';

const entry = (o: { id: string; name: string; description?: string; schema?: string; topic?: string; price?: string }): CatalogEntry => ({
  anchor: {
    id: o.id, name: o.name, description: o.description ?? '', author: '0x1', price: o.price ?? '1', currency: 'CREDIT',
    rows: 10, size_bytes: 100, patch_sha256: 'a', parents: [], created_at: 1, topic_path: o.topic ?? 'patches/m',
    model: { id_M: 'M', row_dim: 160, checkpoint_hash: 'h' },
    benchmark: { schema: o.schema ?? 'krx-ticker', queries: 1 },
  },
  status: 'LISTED', superseded_by: [], quorum_ok: true, passed: 1, quorum: 1, downloads: 0, attestations: [], sellable: true,
} as unknown as CatalogEntry);

const CATALOG = [
  entry({ id: 'pixelplus-demo', name: '픽셀플러스 종목코드', description: 'Pixelplus ticker code (single fact)' }),
  entry({ id: 'krx-all-2761', name: 'KRX ticker codes for 2,761 listed companies', schema: 'krx-ticker' }),
];

test('a two-letter fragment of an id is not a reason to buy anything', () => {
  // "me" ⊂ "pixelplus-demo", "we" ⊂ … : the real question that bought the wrong knowledge for real money.
  assert.equal(pickPatch(CATALOG, 'send me the contract address of the lease we signed last April'), null);
  assert.equal(pickPatch(CATALOG, 'how do I cook rice'), null);
  assert.equal(pickPatch(CATALOG, 'quantum chromodynamics lattice'), null);
  assert.equal(pickPatch(CATALOG, 'the weather in Rome tomorrow'), null);
});

test('the questions this agent is FOR still match', () => {
  assert.equal(pickPatch(CATALOG, '픽셀플러스 종목코드 알려줘')?.anchor.id, 'pixelplus-demo');
  assert.equal(pickPatch(CATALOG, 'Pixelplus ticker code')?.anchor.id, 'pixelplus-demo');
  assert.equal(pickPatch(CATALOG, 'KRX ticker codes for listed companies')?.anchor.id, 'krx-all-2761');
  // an explicit id never goes through the scorer at all
  assert.equal(pickPatch(CATALOG, 'anything at all', 'krx-all-2761')?.anchor.id, 'krx-all-2761');
});

test('a word boundary is any non-letter, non-digit, in any script', () => {
  assert.equal(matchesAsWord('pixelplus-demo', 'me'), false);
  assert.equal(matchesAsWord('pixelplus-demo', 'demo'), true, 'a hyphen is a boundary');
  assert.equal(matchesAsWord('krx-all-2761', 'krx'), true);
  assert.equal(matchesAsWord('krx-all-2761', '2761'), true, 'a digit run is a word');
  assert.equal(matchesAsWord('픽셀플러스 종목코드', '종목코드'), true, 'Hangul, which \\b cannot see');
  assert.equal(matchesAsWord('픽셀플러스 종목코드', '종목'), false, 'and it is not a substring match either');
  assert.equal(matchesAsWord('pixelplus ticker code', 'pixel'), false, 'a prefix inside a word is not the word');
  assert.equal(matchesAsWord('anything', ''), false);
  // a question full of regex metacharacters is data, never a pattern
  assert.equal(matchesAsWord('a (b) c', '(b)'), true);
  assert.doesNotThrow(() => matchesAsWord('anything', '[unclosed'));
  assert.equal(matchesAsWord('a.c', 'abc'), false, 'a dot in the word is a dot, not "any character"');
});
