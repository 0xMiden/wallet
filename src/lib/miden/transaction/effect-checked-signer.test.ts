import { SigningInputs } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import {
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  isVerificationBaseFeeKnownAbsent
} from 'lib/miden-chain/native-asset';

import { ProposalEffectRefusedError, ProposalFeeUnknownError } from './constants';
import { withEffectCheckedSigner, type RawSigner } from './effect-checked-signer';
import { ITransaction, ITransactionStatus } from '../db/types';
import { withWasmClientLock } from '../sdk/miden-client';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  SigningInputs: { deserialize: jest.fn() },
  SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 }
}));
// The decoder resolves every id to bech32; `hex:` is the same account spelled the other way, which the account
// comparison has to fold like `canonicalWalletAccountId` does.
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: string | { __faucet: string }) =>
    typeof id === 'string' ? `bech32:${id}` : `bech32:${id.__faucet}`
  ),
  canonicalWalletAccountId: jest.fn((id: string) => id.replace(/^hex:/, ''))
}));
jest.mock('lib/miden/sdk/nft-asset', () => ({ toNft: jest.fn(), nftKey: jest.fn() }));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: jest.fn() }));
// The chain charges a fee in its native asset, USDCX here as on testnet, so the fee note is told apart.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'bech32:usdcx'),
  getVerificationBaseFeeSync: jest.fn(() => 2),
  getVerificationBaseFee: jest.fn(async () => 2),
  isVerificationBaseFeeKnownAbsent: jest.fn(() => false)
}));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: jest.fn() }));
jest.mock('lib/i18n/core', () => ({ getMessage: jest.fn((key: string) => `copy:${key}`) }));

type Asset = { faucetId: () => { __faucet: string }; amount: () => bigint };
type StubNote = {
  assets: () => { fungibleAssets: () => Asset[]; nonFungibleAssets: () => never[] };
  metadata?: () => { tag: () => { asU32: () => number } };
};

const fa = (faucet: string, amount: bigint): Asset => ({
  faucetId: () => ({ __faucet: faucet }),
  amount: () => amount
});
const note = (assets: Asset[]): StubNote => ({
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => [] })
});
const feeNote = (amount: bigint): StubNote => ({
  ...note([fa('usdcx', amount)]),
  metadata: () => ({ tag: () => ({ asU32: () => 0xfee }) })
});

/** A summary of `account`'s transaction; `vault` is read only by the decode. */
const summary = (
  account: string,
  { removed, added, inputs, outputs }: { removed: Asset[]; added: Asset[]; inputs: StubNote[]; outputs: StubNote[] }
) => {
  const vault = jest.fn(() => ({
    removedFungibleAssets: () => removed,
    addedFungibleAssets: () => added,
    numAssets: () => removed.length + added.length
  }));
  return {
    vault,
    accountDelta: () => ({ id: () => account, vault, storage: () => ({ isEmpty: () => true }) }),
    inputNotes: () => ({ numNotes: () => inputs.length, notes: () => inputs.map(input => ({ note: () => input })) }),
    outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs })
  };
};
// Filling a stranger's PSWAP order: its offer (100 fB) comes in, the requested 500 fA leaves as the payback note, and
// the 2 USDCX fee leaves as the kernel's fee note.
const pswapFill = (account: string) =>
  summary(account, {
    removed: [fa('fA', 500n), fa('usdcx', 2n)],
    added: [fa('fB', 100n)],
    inputs: [note([fa('fB', 100n)])],
    outputs: [note([fa('fA', 500n)]), feeNote(2n)]
  });
// A plain claim of 50 fB that pays only its fee.
const tokenPayment = (account: string) =>
  summary(account, {
    removed: [fa('usdcx', 2n)],
    added: [fa('fB', 50n)],
    inputs: [note([fa('fB', 50n)])],
    outputs: [feeNote(2n)]
  });

const summaryInputs = (summary: object) => ({ variantType: 0, transactionSummaryPayload: () => summary });
const givenSigning = (inputs: object) => jest.mocked(SigningInputs.deserialize).mockReturnValue(inputs as never);
/** Each call to `deserialize` reads the inputs named by the hex it is handed, so concurrent writes can interleave. */
const givenSigningByHex = (byHex: Record<string, object>) =>
  jest
    .mocked(SigningInputs.deserialize)
    .mockImplementation(bytes => byHex[Buffer.from(bytes).toString('hex')] as never);

const row = (fields: Partial<ITransaction>): ITransaction => ({
  id: 'tx-1',
  type: 'consume',
  accountId: 'bech32:acct-a',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 0,
  displayIcon: 'DEFAULT',
  ...fields
});
// Spelled the other way from the summary's account on purpose.
const claim = row({ id: 'claim', type: 'consume', accountId: 'hex:bech32:acct-a', noteId: 'note-1' });
const execute = row({
  id: 'execute',
  type: 'execute',
  accountId: 'bech32:acct-a',
  requestBytes: new Uint8Array([1]),
  spentAssetTotals: [{ faucetId: 'bech32:fA', amount: 1000n }]
});

const SIGNATURE = new Uint8Array([7]);
const baseSigner = () => jest.fn(async (_publicKey: string, _signingInputs: string) => SIGNATURE);
const refusalOf = (signer: RawSigner, hex: string) => signer('pk', hex).catch((error: unknown) => error);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(SigningInputs.deserialize).mockReset();
  jest.mocked(getVerificationBaseFee).mockReset();
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => 2);
  jest.mocked(getVerificationBaseFeeSync).mockReset();
  jest.mocked(getVerificationBaseFeeSync).mockReturnValue(2);
  jest.mocked(isVerificationBaseFeeKnownAbsent).mockReset();
  jest.mocked(isVerificationBaseFeeKnownAbsent).mockReturnValue(false);
});

afterEach(() => {
  // The inline signer runs inside the write's WASM client lock, so taking it here would deadlock.
  expect(withWasmClientLock).not.toHaveBeenCalled();
});

it('passes the base signer through untouched for an unchecked type', async () => {
  const sign = baseSigner();
  const send = row({ type: 'send', faucetId: 'bech32:fA', amount: 500n });
  const run = jest.fn(async (signer: RawSigner) => signer);
  await expect(withEffectCheckedSigner(send, sign, run)).resolves.toBe(sign);
  expect(getVerificationBaseFee).not.toHaveBeenCalled();
  expect(SigningInputs.deserialize).not.toHaveBeenCalled();
});

it('passes a summary within the approval to the base signer and returns what run returned', async () => {
  const sign = baseSigner();
  givenSigning(summaryInputs(pswapFill('acct-a')));
  const signatures: Uint8Array[] = [];
  const outcome = withEffectCheckedSigner(execute, sign, async signer => {
    signatures.push(await signer('pk', 'aa'));
    return 'done';
  });
  await expect(outcome).resolves.toBe('done');
  expect(signatures).toEqual([SIGNATURE]);
  expect(sign).toHaveBeenCalledWith('pk', 'aa');
  expect(SigningInputs.deserialize).toHaveBeenCalledWith(new Uint8Array([0xaa]));
  expect(getVerificationBaseFee).toHaveBeenCalledTimes(1);
});

it('refuses a summary that moves more than the row allows, and rejects with the same error the signer threw', async () => {
  const sign = baseSigner();
  givenSigning(summaryInputs(pswapFill('acct-a')));
  let thrown: unknown;
  const outcome = withEffectCheckedSigner(claim, sign, async signer => {
    thrown = await refusalOf(signer, 'aa');
    // The SDK forwards only the message, so what reaches the write is another error.
    throw new Error(`Sign callback failed (internal): ${String(thrown)}`);
  });
  const refused = await outcome.catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
  expect(refused).toBe(thrown);
  expect(refused).toMatchObject({
    transactionType: 'consume',
    message: 'Refused to sign this consume transaction: 500 of bech32:fA leaves (approved 0)'
  });
  expect(sign).not.toHaveBeenCalled();
});

it('rejects with the first refusal even when run swallows it, and signs nothing after it', async () => {
  const sign = baseSigner();
  givenSigningByHex({ aa: summaryInputs(pswapFill('acct-a')), bb: summaryInputs(tokenPayment('acct-a')) });
  const thrown: unknown[] = [];
  const outcome = withEffectCheckedSigner(claim, sign, async signer => {
    thrown.push(await refusalOf(signer, 'aa'));
    thrown.push(await refusalOf(signer, 'bb'));
    return 'signed';
  });
  const refused = await outcome.catch((error: unknown) => error);
  expect(thrown[0]).toBeInstanceOf(ProposalEffectRefusedError);
  expect(refused).toBe(thrown[0]);
  expect(thrown[1]).toBe(thrown[0]);
  expect(sign).not.toHaveBeenCalled();
  // The second summary alone signs: the write's earlier refusal is what stopped it.
  await expect(withEffectCheckedSigner(claim, sign, signer => signer('pk', 'bb'))).resolves.toBe(SIGNATURE);
});

it('keeps the refusal that landed first when two signs of one write fail at once', async () => {
  // The non-summary is refused at once, before the over-allowance summary's check settles.
  givenSigningByHex({ aa: summaryInputs(pswapFill('acct-a')), bb: { variantType: 2 } });
  const settled: unknown[] = [];
  const outcome = withEffectCheckedSigner(claim, baseSigner(), async signer => {
    await Promise.all(['aa', 'bb'].map(hex => refusalOf(signer, hex).then(error => settled.push(error))));
    return 'signed';
  });
  const refused = await outcome.catch((error: unknown) => error);
  expect(settled).toHaveLength(2);
  expect(settled[0]).not.toBe(settled[1]);
  expect(settled[0]).toMatchObject({ message: expect.stringContaining('not a transaction summary') });
  expect(refused).toBe(settled[0]);
});

it('refuses a summary within the approval whose check was still running when a sibling sign failed', async () => {
  givenSigningByHex({ aa: summaryInputs(tokenPayment('acct-a')), bb: { variantType: 2 } });
  // The passing summary's check is still awaiting its decode when the non-summary, refused at once, records its
  // refusal.
  const sign = baseSigner();
  const settled: unknown[] = [];
  const outcome = withEffectCheckedSigner(claim, sign, async signer => {
    const passing = refusalOf(signer, 'aa');
    settled.push(await refusalOf(signer, 'bb'));
    settled.push(await passing);
    return 'signed';
  });
  const refused = await outcome.catch((error: unknown) => error);
  expect(settled[0]).toMatchObject({ message: expect.stringContaining('not a transaction summary') });
  expect(settled[1]).toBe(settled[0]);
  expect(refused).toBe(settled[0]);
  expect(sign).not.toHaveBeenCalled();
  expect(getVerificationBaseFee).toHaveBeenCalledTimes(1);
});

it("leaves the base signer's own failure unrecorded, so the write rejects with run's error and signs again", async () => {
  givenSigning(summaryInputs(tokenPayment('acct-a')));
  const locked = Object.assign(new Error('Wallet is locked'), { reason: 'locked' });
  const sign = baseSigner();
  sign.mockRejectedValueOnce(locked);
  // What an inline write rejects with: the SDK's own error, which the lock tags with its hold's sign reason.
  const wrapped = Object.assign(new Error('failed to execute transaction: Sign callback failed (locked)'), {
    reason: 'locked'
  });
  const outcome = withEffectCheckedSigner(claim, sign, async signer => {
    expect(await refusalOf(signer, 'aa')).toBe(locked);
    await expect(signer('pk', 'aa')).resolves.toBe(SIGNATURE);
    throw wrapped;
  });
  await expect(outcome).rejects.toBe(wrapped);
  expect(sign).toHaveBeenCalledTimes(2);
});

it("passes run's own rejection through unchanged when no check failed", async () => {
  givenSigning(summaryInputs(tokenPayment('acct-a')));
  const own = new Error('the node rejected the transaction');
  const sign = baseSigner();
  const outcome = withEffectCheckedSigner(claim, sign, async signer => {
    await signer('pk', 'aa');
    throw own;
  });
  await expect(outcome).rejects.toBe(own);
  expect(sign).toHaveBeenCalledTimes(1);
});

it('frees the deserialized inputs and summary once each sign is judged, after the decode read them', async () => {
  const freeable = <T extends object>(stub: T) => Object.assign(stub, { free: jest.fn() });
  const within = freeable(tokenPayment('acct-a'));
  const beyond = freeable(pswapFill('acct-a'));
  const inputs = {
    aa: freeable(summaryInputs(within)),
    bb: freeable(summaryInputs(beyond)),
    cc: freeable({ variantType: 1 })
  };
  givenSigningByHex(inputs);
  await expect(withEffectCheckedSigner(claim, baseSigner(), signer => signer('pk', 'aa'))).resolves.toBe(SIGNATURE);
  await expect(withEffectCheckedSigner(claim, baseSigner(), signer => signer('pk', 'bb'))).rejects.toBeInstanceOf(
    ProposalEffectRefusedError
  );
  await expect(withEffectCheckedSigner(claim, baseSigner(), signer => signer('pk', 'cc'))).rejects.toBeInstanceOf(
    ProposalEffectRefusedError
  );
  for (const freed of [within, beyond, inputs.aa, inputs.bb, inputs.cc]) expect(freed.free).toHaveBeenCalledTimes(1);
  for (const summary of [within, beyond]) {
    expect(summary.free.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...summary.vault.mock.invocationCallOrder)
    );
  }
});

it.each([
  [
    'a signature over anything but a transaction summary',
    { variantType: 1 },
    'the signature asked for is not a transaction summary'
  ],
  ['a summary of another account', summaryInputs(tokenPayment('acct-b')), 'the summary is for another account']
])('refuses %s', async (_case, inputs, detail) => {
  const sign = baseSigner();
  givenSigning(inputs);
  const outcome = withEffectCheckedSigner(execute, sign, signer => signer('pk', 'aa'));
  await expect(outcome).rejects.toThrow(`Refused to sign this execute transaction: ${detail}`);
  await expect(outcome).rejects.toBeInstanceOf(ProposalEffectRefusedError);
  expect(sign).not.toHaveBeenCalled();
});

it.each([
  [
    'deserialize',
    (trap: WebAssembly.RuntimeError) => {
      jest.mocked(SigningInputs.deserialize).mockImplementation(() => {
        throw trap;
      });
    }
  ],
  [
    'a summary read the view decode touches',
    (trap: WebAssembly.RuntimeError) => {
      const payload = tokenPayment('acct-a');
      payload.vault.mockImplementation(() => {
        throw trap;
      });
      const freeing = (value: object): object =>
        Object.assign(value, {
          free: () => {
            throw new Error('free replaced the trap');
          }
        });
      givenSigning(freeing(summaryInputs(payload)));
      freeing(payload);
    }
  ]
])('rethrows a WebAssembly.RuntimeError from %s as that same error', async (_case, arrange) => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  arrange(trap);
  const sign = baseSigner();
  const refused = await withEffectCheckedSigner(execute, sign, signer => signer('pk', 'aa')).catch(
    (error: unknown) => error
  );
  expect(refused).toBe(trap);
  expect(sign).not.toHaveBeenCalled();
});

const unreadable = new Error('unexpected end of input');

it.each([
  [
    'the signing inputs do not deserialize',
    () =>
      jest.mocked(SigningInputs.deserialize).mockImplementation(() => {
        throw unreadable;
      })
  ],
  [
    "the summary's account cannot be read",
    () =>
      givenSigning(
        summaryInputs({
          accountDelta: () => {
            throw unreadable;
          }
        })
      )
  ]
])('refuses when %s', async (_case, arrange) => {
  arrange();
  const sign = baseSigner();
  const refused = await withEffectCheckedSigner(execute, sign, signer => signer('pk', 'aa')).catch(
    (error: unknown) => error
  );
  expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
  expect(refused).toMatchObject({
    message: 'Refused to sign this execute transaction: the transaction summary could not be read',
    cause: unreadable
  });
  expect(sign).not.toHaveBeenCalled();
});

it('rejects an unknown fee with ProposalFeeUnknownError and run is not called', async () => {
  const sign = baseSigner();
  const fill = pswapFill('acct-a');
  givenSigning(summaryInputs(fill));
  jest.mocked(getVerificationBaseFee).mockResolvedValue(null);
  const run = jest.fn(async (signer: RawSigner) => signer('pk', 'aa'));
  const refused = await withEffectCheckedSigner(execute, sign, run).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ProposalFeeUnknownError);
  expect(refused).toMatchObject({ displayMessage: 'copy:chainFeeUnknown' });
  expect(run).not.toHaveBeenCalled();
  expect(fill.vault).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  expect(SigningInputs.deserialize).not.toHaveBeenCalled();
});

it('propagates a fee lookup rejection before the write runs', async () => {
  const failure = new Error('node down');
  jest.mocked(getVerificationBaseFee).mockRejectedValue(failure);
  const run = jest.fn();
  await expect(withEffectCheckedSigner(execute, baseSigner(), run)).rejects.toBe(failure);
  expect(run).not.toHaveBeenCalled();
});

it('rejects from the signer when the cached fee is unknown, without decoding the summary', async () => {
  const fill = pswapFill('acct-a');
  givenSigning(summaryInputs(fill));
  jest.mocked(getVerificationBaseFeeSync).mockReturnValue(null);
  const sign = baseSigner();
  const run = jest.fn(async (signer: RawSigner) => signer('pk', 'aa'));
  const refused = await withEffectCheckedSigner(execute, sign, run).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ProposalFeeUnknownError);
  expect(run).toHaveBeenCalledTimes(1);
  expect(fill.vault).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  expect(getVerificationBaseFee).toHaveBeenCalledTimes(1);
});

it('looks the chain fee up once, before the write runs', async () => {
  const order: string[] = [];
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => {
    order.push('fee');
    return 2;
  });
  givenSigning(summaryInputs(pswapFill('acct-a')));
  await withEffectCheckedSigner(execute, baseSigner(), async signer => {
    order.push('run');
    return signer('pk', 'aa');
  });
  expect(order).toEqual(['fee', 'run']);
  expect(getVerificationBaseFee).toHaveBeenCalledTimes(1);
});

it('checks each write of one account against its own row while both run', async () => {
  const sign = baseSigner();
  givenSigningByHex({ aa: summaryInputs(pswapFill('acct-a')) });
  // Both writes are open before either signs: the execute allows the 500 fA, the claim allows none.
  let release: () => void = () => undefined;
  const bothOpen = new Promise<void>(resolve => {
    release = resolve;
  });
  const opened: string[] = [];
  const write = (transaction: ITransaction) =>
    withEffectCheckedSigner(transaction, sign, async signer => {
      opened.push(transaction.id);
      if (opened.length === 2) release();
      await bothOpen;
      return signer('pk', 'aa');
    });
  const [executed, claimed] = await Promise.allSettled([write(execute), write(claim)]);
  expect(opened).toEqual(['execute', 'claim']);
  expect(executed).toEqual({ status: 'fulfilled', value: SIGNATURE });
  expect(claimed).toMatchObject({
    status: 'rejected',
    reason: { message: 'Refused to sign this consume transaction: 500 of bech32:fA leaves (approved 0)' }
  });
  expect(sign).toHaveBeenCalledTimes(1);
});
