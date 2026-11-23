'use strict';

/** @type {[id: string, mode: string, suite: string, spec: string, timeoutMinutes?: number][]} */
const DEFINITIONS = [
  ['swap-recovery-grant', 'authorize_recovery_return', 'solver', 'swap-loop'],
  ['swap-recover', 'recover', 'solver', 'swap-loop', 31],
  ['swap-recovered-return', 'reverse', 'solver', 'swap-loop', 31],
  ['epoch-recover', 'recover', 'epoch', 'epoch-loop', 21],
  ['near-recover', 'recover', 'near', '1click-loop', 21],
  ['swap-prepare', 'prepare', 'solver', 'swap-loop'],
  ['swap-forward', 'forward', 'solver', 'swap-loop', 31],
  ['swap-reverse', 'reverse', 'solver', 'swap-loop', 31],
  ['epoch-prepare', 'prepare', 'epoch', 'epoch-loop'],
  ['epoch-forward', 'forward', 'epoch', 'epoch-loop', 21],
  ['epoch-reverse', 'reverse', 'epoch', 'epoch-loop', 21],
  ['near-prepare', 'prepare', 'near', '1click-loop'],
  ['near-forward', 'forward', 'near', '1click-loop', 21],
  ['near-reverse', 'reverse', 'near', '1click-loop', 21],
  ['native-round-trip', 'round_trip', 'native', 'round-trip'],
  ['usdcx-round-trip', 'round_trip', 'usdcx', 'bridge-loop'],
  ['agglayer-round-trip', 'round_trip', 'agglayer', 'agglayer-loop']
];

const INVOCATIONS = new Map(
  DEFINITIONS.map(([id, mode, suite, basename, timeoutMinutes]) => [
    id,
    {
      id,
      mode,
      suite,
      spec: 'mainnet-' + basename + '.spec.ts',
      jobKey: suite === 'agglayer' ? 'agglayer' : 'mainnet',
      timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000
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

const STATUS = new Map([
  ['passed', 'passed'],
  ['failed', 'failed'],
  ['timedOut', 'timed_out'],
  ['timedout', 'timed_out'],
  ['skipped', 'skipped'],
  ['interrupted', 'interrupted']
]);

module.exports = { INVOCATIONS, TITLES, STATUS };
