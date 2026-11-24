/**
 * @jest-environment node
 */
import { encodeFunctionData, formatUnits, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import { DEPOSIT_UNITS, L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import { executorDepositRequests, type SignedRequest } from './usdcx-executor-requests';
import { buildDepositForBurnWithHookAndFeesArgs, buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const { address: DEPOSITOR } = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const RECIPIENT = midenAccountHexToXReserveRecipient('0xf2f42cda8d010f417d1cad5dc4d52b');
const OTHER_RECIPIENT = midenAccountHexToXReserveRecipient('0x0a0b0c0d0e0f101112131415161718');
/** Circle's sandbox fee for a 0.001 USDC forwarded burn from Base Sepolia on 2026-10-16. */
const FEE = 22_404n;
const APPROVE_HASH: Hash = `0x${'a1'.repeat(32)}`;
const BURN_HASH: Hash = `0x${'b2'.repeat(32)}`;
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

function l2On(chainId: number): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId);
  if (!found) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  return found;
}
const l2 = l2On(84532);
const EXPECTED = {
  l2,
  units: DEPOSIT_UNITS,
  recipient: RECIPIENT,
  depositor: DEPOSITOR,
  recordedFee: FEE,
  allowanceBefore: 0n
};
const intentFor = (recipient: Hex) =>
  buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), l2.source, recipient, DEPOSITOR);

/** What the counterparty logs for a transaction the app asked for, in the address case the app sends. */
const sendTx = (to: Address, data: Hex, hash: Hash, chainId = 'eip155:84532'): SignedRequest => ({
  method: 'eth_sendTransaction',
  chainId,
  params: [{ from: DEPOSITOR.toLowerCase(), to: to.toLowerCase(), data, value: '0x0' }],
  result: hash
});
const approveTx = (value = DEPOSIT_UNITS + 2n * FEE) =>
  sendTx(
    l2.source.usdc,
    encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [l2.source.tokenMessengerWithFees, value] }),
    APPROVE_HASH
  );
const burnTx = (opts: { recipient?: Hex; refund?: Address; chainId?: string } = {}) =>
  sendTx(
    l2.source.tokenMessengerWithFees,
    encodeFunctionData({
      abi: TOKEN_MESSENGER_WITH_FEES_ABI,
      functionName: 'depositForBurnWithHookAndFees',
      args: buildDepositForBurnWithHookAndFeesArgs(
        l2.source,
        intentFor(opts.recipient ?? RECIPIENT),
        { signedQuote: '0x0102', feeTotalAmount: FEE },
        opts.refund ?? DEPOSITOR
      )
    }),
    BURN_HASH,
    opts.chainId
  );

describe('executorDepositRequests', () => {
  it('accepts the approve and the forwarded burn runUsdcxExecutorDeposit asks for', () => {
    expect(executorDepositRequests([approveTx(), burnTx()], EXPECTED)).toEqual({
      approve: { hash: APPROVE_HASH, value: DEPOSIT_UNITS + 2n * FEE },
      burn: { hash: BURN_HASH, hookData: intentFor(RECIPIENT).hookData }
    });
  });

  it('accepts a burn alone when the allowance before the deposit covered the amount and the fee', () => {
    expect(executorDepositRequests([burnTx()], { ...EXPECTED, allowanceBefore: DEPOSIT_UNITS + FEE })).toEqual({
      burn: { hash: BURN_HASH, hookData: intentFor(RECIPIENT).hookData }
    });
  });

  it('refuses a burn alone when the allowance before the deposit did not cover it', () => {
    expect(() => executorDepositRequests([burnTx()], EXPECTED)).toThrow(
      'no approve, but the allowance before the deposit, 0, does not cover the amount and the fee 22404'
    );
  });

  it('refuses an approve the product would not have sent', () => {
    expect(() =>
      executorDepositRequests([approveTx(), burnTx()], { ...EXPECTED, allowanceBefore: DEPOSIT_UNITS + FEE })
    ).toThrow('covered the amount and the first fee 22404');
  });

  it('names every burn argument that differs from the one rebuilt with the product', () => {
    expect(() =>
      executorDepositRequests([approveTx(), burnTx({ recipient: OTHER_RECIPIENT, refund: DEAD })], EXPECTED)
    ).toThrow(/hookData[\s\S]*refundAddress/);
  });

  it('refuses another chain, a message to sign and an approve that is not the amount plus twice a fee', () => {
    const requests: SignedRequest[] = [
      approveTx(DEPOSIT_UNITS + 2n * FEE + 1n),
      burnTx({ chainId: 'eip155:5042002' }),
      { method: 'personal_sign', chainId: 'eip155:84532', params: [] }
    ];
    expect(() => executorDepositRequests(requests, EXPECTED)).toThrow(
      /not on eip155:84532[\s\S]*transactions only[\s\S]*not the amount 1000 plus twice a quoted fee/
    );
  });

  it('refuses two burns and an approve after the burn', () => {
    expect(() => executorDepositRequests([burnTx(), approveTx(), burnTx()], EXPECTED)).toThrow(
      /2 forwarded burns, expected exactly 1[\s\S]*the approve came after the burn/
    );
  });

  // The executor spec runs these gates on every source chain: each has its own chain id and USDC.
  it("accepts Ethereum Sepolia's requests on its own chain and contracts, and refuses Base Sepolia's there", () => {
    const sepolia = l2On(11155111);
    const intent = buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), sepolia.source, RECIPIENT, DEPOSITOR);
    const onSepolia = (to: Address, data: Hex, hash: Hash) => sendTx(to, data, hash, 'eip155:11155111');
    const requests: SignedRequest[] = [
      onSepolia(
        sepolia.source.usdc,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [sepolia.source.tokenMessengerWithFees, DEPOSIT_UNITS + 2n * FEE]
        }),
        APPROVE_HASH
      ),
      onSepolia(
        sepolia.source.tokenMessengerWithFees,
        encodeFunctionData({
          abi: TOKEN_MESSENGER_WITH_FEES_ABI,
          functionName: 'depositForBurnWithHookAndFees',
          args: buildDepositForBurnWithHookAndFeesArgs(
            sepolia.source,
            intent,
            { signedQuote: '0x0102', feeTotalAmount: FEE },
            DEPOSITOR
          )
        }),
        BURN_HASH
      )
    ];

    expect(executorDepositRequests(requests, { ...EXPECTED, l2: sepolia })).toEqual({
      approve: { hash: APPROVE_HASH, value: DEPOSIT_UNITS + 2n * FEE },
      burn: { hash: BURN_HASH, hookData: intent.hookData }
    });
    expect(() => executorDepositRequests([approveTx(), burnTx()], { ...EXPECTED, l2: sepolia })).toThrow(
      'not on eip155:11155111'
    );
  });
});
