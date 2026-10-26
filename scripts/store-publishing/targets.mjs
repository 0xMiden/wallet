export const STORE_TARGETS = Object.freeze([
  Object.freeze({
    id: 'chrome-testnet',
    platform: 'chrome',
    network: 'testnet',
    identity: 'coajhopfooegmaifelglfboehacldcbo'
  }),
  Object.freeze({ id: 'ios-testnet', platform: 'ios', network: 'testnet', identity: 'com.miden.bread' }),
  Object.freeze({ id: 'android-testnet', platform: 'android', network: 'testnet', identity: 'com.miden.wallet' }),
  Object.freeze({
    id: 'chrome-devnet',
    platform: 'chrome',
    network: 'devnet',
    identity: 'eeghndabgeicdpkbcohgglidpfpiafnb'
  })
]);

export function selectStoreTargets(id = 'all') {
  if (id === 'all') return STORE_TARGETS;
  const target = STORE_TARGETS.find(value => value.id === id);
  if (!target) throw new Error('Unknown store target');
  return [target];
}
