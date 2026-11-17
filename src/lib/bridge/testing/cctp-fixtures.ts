import {
  concatHex,
  encodeAbiParameters,
  getEventSelector,
  padHex,
  toHex,
  type Address,
  type Hash,
  type Hex
} from 'viem';

import type { CctpReceipt } from 'lib/bridge/providers/xreserve/cctp-message';
import type { UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { encodeExecutorHookData } from 'lib/usdcx/executor';

import { TEST_CCTP_MESSENGER, TEST_CCTP_TRANSMITTER } from './circle-fixtures';
import { accounts, native } from './fixtures';

export const SOURCE_NONCE = `0x${'0'.repeat(63)}1` satisfies Hex;
export const FORWARD_HASH = `0x${'f'.repeat(64)}` satisfies Hash;
export function cctpSourceMessage(
  source: UsdcxExecutorSource,
  changes: { nonce?: Hex; amount?: bigint; sender?: Address; executed?: number } = {}
): Hex {
  const account: Address = `0x${accounts.evmAddress.slice(2)}`;
  return concatHex([
    toHex(1, { size: 4 }),
    toHex(source.domain, { size: 4 }),
    toHex(source.target.domain, { size: 4 }),
    changes.nonce ?? (changes.executed ? SOURCE_NONCE : toHex(0, { size: 32 })),
    padHex(changes.sender ?? TEST_CCTP_MESSENGER, { size: 32 }),
    padHex(TEST_CCTP_MESSENGER, { size: 32 }),
    padHex(source.target.executor, { size: 32 }),
    toHex(1000, { size: 4 }),
    toHex(changes.executed ?? 0, { size: 4 }),
    toHex(1, { size: 4 }),
    padHex(source.usdc, { size: 32 }),
    padHex(source.target.executor, { size: 32 }),
    toHex(changes.amount ?? 1000001n, { size: 32 }),
    padHex(account, { size: 32 }),
    toHex(0, { size: 32 }),
    toHex(changes.executed ? 1 : 0, { size: 32 }),
    toHex(changes.executed ? 999 : 0, { size: 32 }),
    encodeExecutorHookData(source.target, usdcxRemoteRecipientFor(accounts.midenAccount), account)
  ]);
}
function log(hash: Hash, address: Address, topics: [Hex, ...Hex[]], data: Hex): CctpReceipt['logs'][number] {
  return {
    address,
    topics,
    data,
    blockHash: hash,
    blockNumber: 1n,
    transactionHash: hash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false
  };
}
export function cctpSourceReceipt(hash: Hash, message: Hex): CctpReceipt {
  return {
    transactionHash: hash,
    status: 'success',
    logs: [
      log(
        hash,
        TEST_CCTP_TRANSMITTER,
        [getEventSelector('MessageSent(bytes)')],
        encodeAbiParameters([{ type: 'bytes' }], [message])
      )
    ]
  };
}
export function cctpArcReceipt(
  source: UsdcxExecutorSource,
  changes: { nonce?: Hex; amount?: bigint; depositAmount?: bigint; handler?: Address } = {}
): CctpReceipt {
  const { target } = source;
  const executed = log(
    FORWARD_HASH,
    target.executor,
    [
      getEventSelector('Executed(bytes4,uint8,address,address,uint256,bytes32)'),
      padHex('0x43435450', { size: 32, dir: 'right' }),
      padHex(changes.handler ?? target.handler, { size: 32 }),
      padHex(target.usdc, { size: 32 })
    ],
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'bytes32' }],
      [1, changes.amount ?? 1000001n, changes.nonce ?? SOURCE_NONCE]
    )
  );
  const deposited = log(
    FORWARD_HASH,
    target.xReserve,
    [
      getEventSelector('DepositedToRemote(address,uint256,address,bytes32,uint32,bytes32,uint256,bytes)'),
      padHex(target.usdc, { size: 32 }),
      padHex(target.handler, { size: 32 }),
      usdcxRemoteRecipientFor(accounts.midenAccount)
    ],
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }],
      [changes.depositAmount ?? 1000001n, 10007, usdcxExpectedRemoteTokenFor(native.faucetId), 0n, '0x']
    )
  );
  return { transactionHash: FORWARD_HASH, status: 'success', logs: [executed, deposited] };
}
export function cctpDepositAttestation(source: UsdcxExecutorSource) {
  const payload = concatHex([
    '0x5a2e0acd',
    toHex(1, { size: 4 }),
    toHex(1000001, { size: 32 }),
    toHex(10007, { size: 4 }),
    usdcxExpectedRemoteTokenFor(native.faucetId),
    usdcxRemoteRecipientFor(accounts.midenAccount),
    padHex(source.target.usdc, { size: 32 }),
    padHex(source.target.handler, { size: 32 }),
    toHex(0, { size: 32 }),
    SOURCE_NONCE,
    toHex(0, { size: 4 })
  ]);
  return { attestations: [{ remoteDomain: 10007, payload, messageHash: SOURCE_NONCE, attestation: '0xabcd' }] };
}
