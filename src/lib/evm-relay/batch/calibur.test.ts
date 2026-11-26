/**
 * @jest-environment node
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  zeroHash,
  type Address,
  type Hex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  CALIBUR_ABI,
  batchDigest,
  batchTypedData,
  buildSignedBatch,
  caliburDelegationCode,
  encodeExecution,
  isCaliburDelegation,
  recoverBatchSigner,
  type BatchCall
} from './calibur';
import { PROTOTYPE_BUY_ENVELOPE, SEPOLIA_CALIBUR_PIN, TEST_ERC20, TEST_TARGET, prototypeNonceKey } from './testing';

// The golden digests that the prototype's backend test (`backend/src/chain-testnet/calibur.test.ts`) and wallet test
// (`src/lib/onramp/buy-batch.test.ts`) assert, on branch `utkarsh/feat/onramp-offramp-integration`.
const PROTOTYPE_BUY_DIGEST = '0x53ced547f87f74297962f3bd574f25ca7a8f3392fea412b02e942b8ffcea29d2';
const PROTOTYPE_SELL_DIGEST = '0xf51b1837c41f5128f295dcc17b811a4d7905ae66d6be235b9327df25a055a96d';

// The two calls of the prototype's buy vector, written out here: this module builds no calls of a bridge. The batch
// approves a contract for 10^18 of a token and then calls that contract.
const PROTOTYPE_BUY_ABI = parseAbi(['function bridgeAsset(uint32, address, uint256, address, bool, bytes) payable']);
const PROTOTYPE_BUY_DESTINATION: Address = `0x00000000${'0a'.repeat(15)}00`;

const prototypeBuyCalls = (): BatchCall[] => [
  {
    to: TEST_ERC20,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEST_TARGET, 10n ** 18n] })
  },
  {
    to: TEST_TARGET,
    value: 0n,
    data: encodeFunctionData({
      abi: PROTOTYPE_BUY_ABI,
      functionName: 'bridgeAsset',
      args: [73, PROTOTYPE_BUY_DESTINATION, 10n ** 18n, TEST_ERC20, true, '0x']
    })
  }
];

describe('Calibur batch', () => {
  it('hashes the prototype buy vector to its golden digest', () => {
    expect(batchDigest(SEPOLIA_CALIBUR_PIN, PROTOTYPE_BUY_ENVELOPE, prototypeBuyCalls())).toBe(PROTOTYPE_BUY_DIGEST);
  });

  it('hashes the prototype sell vector to its golden digest', () => {
    const token = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const calls: BatchCall[] = [
      {
        to: token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: ['0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4', 1_000_000n]
        })
      }
    ];
    const envelope = { ...PROTOTYPE_BUY_ENVELOPE, batchNonce: prototypeNonceKey('miden.offramp') << 64n };
    expect(batchDigest(SEPOLIA_CALIBUR_PIN, envelope, calls)).toBe(PROTOTYPE_SELL_DIGEST);
  });

  it('builds the domain from the pin and the envelope', () => {
    const typedData = batchTypedData(
      { ...SEPOLIA_CALIBUR_PIN, domainName: 'Other', domainVersion: '2.0.0' },
      { ...PROTOTYPE_BUY_ENVELOPE, chainId: 1 },
      []
    );
    expect(typedData.domain).toEqual({
      name: 'Other',
      version: '2.0.0',
      chainId: 1,
      verifyingContract: PROTOTYPE_BUY_ENVELOPE.evmAddress,
      salt: PROTOTYPE_BUY_ENVELOPE.salt
    });
    expect(typedData.primaryType).toBe('SignedBatchedCall');
  });

  it('signs with the root key and reverts on any failed call', () => {
    const calls = prototypeBuyCalls();
    expect(buildSignedBatch(PROTOTYPE_BUY_ENVELOPE, calls)).toEqual({
      batchedCall: { calls, revertOnFailure: true },
      nonce: PROTOTYPE_BUY_ENVELOPE.batchNonce,
      keyHash: zeroHash,
      executor: PROTOTYPE_BUY_ENVELOPE.executor,
      deadline: PROTOTYPE_BUY_ENVELOPE.deadline
    });
  });

  it('encodes execute with the batch and the wrapped signature', () => {
    const calls = prototypeBuyCalls();
    const signature: Hex = `0x${'11'.repeat(65)}`;
    const decoded = decodeFunctionData({
      abi: CALIBUR_ABI,
      data: encodeExecution(PROTOTYPE_BUY_ENVELOPE, calls, signature)
    });
    if (decoded.functionName !== 'execute') throw new Error(`Decoded ${decoded.functionName}, not execute`);
    const [batch, wrapped] = decoded.args;
    expect(batch.nonce).toBe(PROTOTYPE_BUY_ENVELOPE.batchNonce);
    expect(batch.keyHash).toBe(zeroHash);
    expect(batch.batchedCall.revertOnFailure).toBe(true);
    expect(batch.batchedCall.calls.map(call => call.data)).toEqual(calls.map(call => call.data));
    expect(decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], wrapped)).toEqual([signature, '0x']);
  });

  it('recovers the address of the account that signed the batch', async () => {
    const account = privateKeyToAccount(`0x${'ab'.repeat(32)}`);
    const envelope = { ...PROTOTYPE_BUY_ENVELOPE, evmAddress: account.address };
    const calls = prototypeBuyCalls();
    const signature = await account.signTypedData(batchTypedData(SEPOLIA_CALIBUR_PIN, envelope, calls));
    await expect(recoverBatchSigner(SEPOLIA_CALIBUR_PIN, envelope, calls, signature)).resolves.toBe(account.address);
    const otherEnvelope = { ...envelope, deadline: envelope.deadline + 1n };
    await expect(recoverBatchSigner(SEPOLIA_CALIBUR_PIN, otherEnvelope, calls, signature)).resolves.not.toBe(
      account.address
    );
  });
});

describe('Calibur delegation', () => {
  it('is 0xef0100 and the lower-case Calibur address', () => {
    expect(caliburDelegationCode(SEPOLIA_CALIBUR_PIN)).toBe('0xef010000000cabfc76478c1537dd418ab00967cbbe4ae6');
  });

  it('matches the delegation code in any case and refuses other code', () => {
    const code = caliburDelegationCode(SEPOLIA_CALIBUR_PIN);
    expect(isCaliburDelegation(code, SEPOLIA_CALIBUR_PIN)).toBe(true);
    expect(
      isCaliburDelegation(`0xEF0100${getAddress(SEPOLIA_CALIBUR_PIN.address).slice(2)}`, SEPOLIA_CALIBUR_PIN)
    ).toBe(true);
    expect(isCaliburDelegation('0x', SEPOLIA_CALIBUR_PIN)).toBe(false);
    expect(isCaliburDelegation(`0xef0100${'44'.repeat(20)}`, SEPOLIA_CALIBUR_PIN)).toBe(false);
  });
});
