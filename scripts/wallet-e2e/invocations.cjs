'use strict';

/** @type {[string, string, string, string][]} */
const DEFINITIONS = [
  ['swap-recovery-grant', 'authorize_recovery_return', 'solver', 'swap-loop'],
  ['swap-recover', 'recover', 'solver', 'swap-loop'],
  ['swap-recovered-return', 'reverse', 'solver', 'swap-loop'],
  ['epoch-recover', 'recover', 'epoch', 'epoch-loop'],
  ['near-recover', 'recover', 'near', '1click-loop'],
  ['swap-prepare', 'prepare', 'solver', 'swap-loop'],
  ['swap-forward', 'forward', 'solver', 'swap-loop'],
  ['swap-reverse', 'reverse', 'solver', 'swap-loop'],
  ['epoch-prepare', 'prepare', 'epoch', 'epoch-loop'],
  ['epoch-forward', 'forward', 'epoch', 'epoch-loop'],
  ['epoch-reverse', 'reverse', 'epoch', 'epoch-loop'],
  ['near-prepare', 'prepare', 'near', '1click-loop'],
  ['near-forward', 'forward', 'near', '1click-loop'],
  ['near-reverse', 'reverse', 'near', '1click-loop'],
  ['native-round-trip', 'round_trip', 'native', 'round-trip'],
  ['usdcx-round-trip', 'round_trip', 'usdcx', 'bridge-loop'],
  ['agglayer-round-trip', 'round_trip', 'agglayer', 'agglayer-loop']
];

const INVOCATIONS = new Map(
  DEFINITIONS.map(([id, mode, suite, basename]) => [
    id,
    {
      id,
      mode,
      suite,
      spec: 'mainnet-' + basename + '.spec.ts',
      jobKey: suite === 'agglayer' ? 'agglayer' : 'mainnet'
    }
  ])
);

const TITLES = new Map([
  ['solver', ['real Guardian mainnet solver swaps out and back with recycled principal']],
  ['epoch', ['mainnet Epoch staged round trip']],
  ['near', ['mainnet NEAR staged round trip']],
  [
    'native',
    ['register the two long-lived mainnet accounts', 'plain and guardian exchange one base unit of the native asset']
  ],
  ['usdcx', ['loops the minimum on every mainnet USDCx route']],
  ['agglayer', ['loops ETH from Ethereum to Miden and back over AggLayer']]
]);

const STAGE_TIMEOUTS = new Map([
  ['swap-recover', 31 * 60_000],
  ['swap-recovered-return', 31 * 60_000],
  ['swap-forward', 31 * 60_000],
  ['swap-reverse', 31 * 60_000],
  ['epoch-recover', 21 * 60_000],
  ['epoch-forward', 21 * 60_000],
  ['epoch-reverse', 21 * 60_000],
  ['near-recover', 21 * 60_000],
  ['near-forward', 21 * 60_000],
  ['near-reverse', 21 * 60_000]
]);

const STATUS = new Map([
  ['passed', 'passed'],
  ['failed', 'failed'],
  ['timedOut', 'timed_out'],
  ['skipped', 'skipped'],
  ['interrupted', 'interrupted']
]);

module.exports = { INVOCATIONS, TITLES, STAGE_TIMEOUTS, STATUS };
