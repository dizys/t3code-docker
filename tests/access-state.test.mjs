import assert from 'node:assert/strict';
import test from 'node:test';
import { runClassic } from '../docker/setup/page.mjs';
const { T3AccessState } = runClassic(['client/access-state.js'], ['T3AccessState']);
const plain = (value) => JSON.parse(JSON.stringify(value));
const status = () => ({ sessions: [{ sessionId: 'phone', setupLabel: 'Old name' }, { sessionId: 'other' }], pairings: [{ id: 'link' }],
  authLists: { session: { available: true, stale: false }, pairing: { available: true, stale: false } } });

test('Access serializes mutations per item and keeps failures retryable', () => {
  const state = T3AccessState.create();
  const rename = state.begin('session', 'phone', 'Saving name…');
  assert.equal(state.begin('session', 'phone', 'Revoking…'), null);
  const other = state.begin('session', 'other', 'Revoking…');
  assert.ok(other);
  state.finish(rename, { error: 'Unavailable' });
  assert.equal(state.pending('session', 'phone'), undefined);
  assert.equal(state.error('session', 'phone'), 'Unavailable');
  const retry = state.begin('session', 'phone', 'Saving name…');
  state.finish(rename, { session: { sessionId: 'phone', setupLabel: 'Late' } });
  assert.equal(state.pending('session', 'phone'), retry, 'an old callback cannot settle a new operation');
  assert.equal(state.error('session', 'phone'), undefined);
});

test('a pre-mutation poll cannot undo a confirmed rename or resurrect a revoked link', () => {
  const state = T3AccessState.create(), before = status(), readRevision = state.revision;
  state.finish(state.begin('session', 'phone', 'Saving'), { session: { sessionId: 'phone', setupLabel: 'New name' } });
  state.finish(state.begin('pairing', 'link', 'Revoking'), { removed: true });
  const late = state.reconcile(before, before, readRevision);
  assert.equal(late.sessions[0].setupLabel, 'New name');
  assert.deepEqual(plain(late.pairings), []);
  assert.equal(before.sessions[0].setupLabel, 'Old name', 'reconciliation does not mutate server data');
  const current = status(); current.sessions[0].setupLabel = 'New name'; current.pairings = [];
  state.reconcile(current, late, state.revision);
  assert.equal(state.busy, false);
  current.sessions[0].setupLabel = 'Renamed from another browser';
  assert.equal(state.reconcile(current, late, state.revision).sessions[0].setupLabel, 'Renamed from another browser');
});

test('cache invalidation preserves other devices and confirmed results until an authoritative read', () => {
  const state = T3AccessState.create(), before = status();
  state.finish(state.begin('session', 'phone', 'Revoking'), { removed: true });
  const unavailable = status(); unavailable.sessions = []; unavailable.authLists.session = { available: false, stale: true };
  const waiting = state.reconcile(unavailable, before, state.revision);
  assert.deepEqual(plain(waiting.sessions), [{ sessionId: 'other' }]);
  assert.equal(state.busy, true);
  const stale = status(); stale.authLists.session.stale = true;
  assert.deepEqual(plain(state.reconcile(stale, waiting, state.revision).sessions), [{ sessionId: 'other' }]);
  const fresh = status(); fresh.sessions = [{ sessionId: 'other' }];
  state.reconcile(fresh, waiting, state.revision);
  assert.equal(state.busy, false);
  fresh.sessions = [];
  assert.deepEqual(plain(state.reconcile(fresh, waiting, state.revision).sessions), [], 'a genuine empty list is allowed');
});

test('a confirmed device remains visible even if a late snapshot lacks its row', () => {
  const state = T3AccessState.create(), old = status(), revision = state.revision;
  old.sessions = [];
  state.finish(state.begin('session', 'phone', 'Saving'), { session: { sessionId:'phone',setupLabel:'Confirmed name' } });
  const kept = state.reconcile(old, null, revision);
  assert.deepEqual(plain(kept.sessions), [{ sessionId:'phone',setupLabel:'Confirmed name' }]);
  assert.deepEqual(plain(state.reconcile(old, kept, state.revision).sessions), [], 'a subsequent authoritative removal still wins');
});
