import assert from 'node:assert/strict';
import test from 'node:test';

let targets = {};
try {
  targets = await import('./targets.mjs');
} catch {}

const expected = [
  { id: 'chrome-testnet', platform: 'chrome', network: 'testnet', identity: 'coajhopfooegmaifelglfboehacldcbo' },
  { id: 'ios-testnet', platform: 'ios', network: 'testnet', identity: 'com.miden.bread' },
  { id: 'android-testnet', platform: 'android', network: 'testnet', identity: 'com.miden.wallet' },
  { id: 'chrome-devnet', platform: 'chrome', network: 'devnet', identity: 'eeghndabgeicdpkbcohgglidpfpiafnb' }
];

test('the standard target set includes official Chrome Devnet after all production stores', () => {
  assert.deepEqual(targets.STORE_TARGETS, expected);
  assert.deepEqual(targets.selectStoreTargets(), expected);
  assert.deepEqual(targets.selectStoreTargets('all'), expected);
});

test('individual targets retain their exact fixed identity and network', () => {
  assert.equal(typeof targets.selectStoreTargets, 'function');
  for (const target of expected) assert.deepEqual(targets.selectStoreTargets(target.id), [target]);
  for (const invalid of ['ios-devnet', 'chrome-mainnet', 'android', '', null])
    assert.throws(() => targets.selectStoreTargets(invalid), /target/i);
});

test('callers cannot mutate the standard registry or its entries', () => {
  assert.equal(typeof targets.selectStoreTargets, 'function');
  assert.equal(Object.isFrozen(targets.STORE_TARGETS), true);
  for (const target of targets.STORE_TARGETS) {
    assert.equal(Object.isFrozen(target), true);
    assert.throws(() => {
      target.network = 'mainnet';
    }, TypeError);
  }
});
