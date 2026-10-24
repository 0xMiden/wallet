/**
 * @jest-environment node
 */
import type { ArcClock } from './usdcx-constants';
import {
  accountHex,
  bareId,
  boundLandedFee,
  burnEvidence,
  burnOutputs,
  deriveUsdcxMintNoteId,
  note,
  nullifier,
  recentNotes,
  runChainEvidence,
  supply,
  waitForUsdcxMint,
  type ChainEvidenceRunner
} from './usdcx-miden';

const RPC = 'https://rpc.testnet.miden.io';
const FAUCET = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
const FAUCET_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const WALLET = 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w';
const BURN_NOTE = '0xa6101e78b77fd80073e0e8b439d26349f3b664e09ef4675301815749acea3c7d';
const MINT_NOTE = '0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93';

/** A runner that records its calls and answers each with the next canned stdout. */
function scripted(...answers: Array<Record<string, unknown> | Error>): {
  run: ChainEvidenceRunner;
  calls: Array<{ args: readonly string[]; stdin?: string }>;
} {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const run: ChainEvidenceRunner = async (args, opts) => {
    calls.push({ args, stdin: opts.stdin });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected oracle call ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return `${JSON.stringify(answer)}\n`;
  };
  return { run, calls };
}

function fakeClock(): ArcClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    }
  };
}

describe('bareId', () => {
  it('cuts a composite id to its bech32 and leaves a bare one alone', () => {
    expect(bareId(WALLET)).toBe('mtst1are0gtx635qs7starjk4m3x49vcm0w2g');
    expect(bareId('mtst1are0gtx635qs7starjk4m3x49vcm0w2g')).toBe('mtst1are0gtx635qs7starjk4m3x49vcm0w2g');
  });
});

describe('the oracle wrappers', () => {
  it('accountHex hands the oracle the bare id and checks the hex it gets back', async () => {
    const { run, calls } = scripted({ hex: '0xf2f42cda8d010f417d1cad5dc4d52b' }, { hex: '0x12' });
    await expect(accountHex(WALLET, run)).resolves.toBe('0xf2f42cda8d010f417d1cad5dc4d52b');
    expect(calls[0]?.args).toEqual(['account-hex', 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g']);
    await expect(accountHex(WALLET, run)).rejects.toThrow('0x12 is not an account id');
  });

  it('supply reads the decimal supply as a bigint', async () => {
    const { run, calls } = scripted({ supply: '1000002912999999' });
    await expect(supply(RPC, FAUCET, run)).resolves.toBe(1000002912999999n);
    expect(calls[0]?.args).toEqual(['supply', RPC, 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0']);
  });

  it('burnEvidence passes the expected burn and types every field it gets back', async () => {
    // The 2026-10-10 spike burn, as the oracle printed it against testnet.
    const { run, calls } = scripted({
      noteId: BURN_NOTE,
      amount: '10000000',
      tag: 1112887886,
      scriptRoot: '0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af',
      senderHex: '0xee64b3343b2bf28138b0a8731f52d6',
      domain: 26,
      recipient: '0xfec2b02f01b3f46f25d604d0451d2a6876b12d7e',
      sponsorshipUnits: '119',
      status: 'NullifierCommitted',
      nullifierCommitted: true,
      consumeBlock: 113796,
      consumeTimestampSec: 1791638693,
      attemptCount: 0
    });
    const evidence = await burnEvidence(
      RPC,
      {
        faucetBech32: FAUCET,
        noteId: BURN_NOTE,
        senderBech32: 'mtst1arhxfve58v4l9qfckz58x86j6c59evpr_qr7qqq9wr6w',
        domain: 26,
        recipient: '0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E',
        amount: 10_000_000n
      },
      run
    );
    expect(calls[0]?.args).toEqual([
      'burn-evidence',
      RPC,
      'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0',
      BURN_NOTE,
      'mtst1arhxfve58v4l9qfckz58x86j6c59evpr',
      '26',
      '0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E',
      '10000000'
    ]);
    expect(evidence).toEqual({
      noteId: BURN_NOTE,
      amount: 10_000_000n,
      tag: 0x4255524e,
      scriptRoot: '0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af',
      senderHex: '0xee64b3343b2bf28138b0a8731f52d6',
      domain: 26,
      recipient: '0xfec2b02f01b3f46f25d604d0451d2a6876b12d7e',
      sponsorshipUnits: 119n,
      status: 'NullifierCommitted',
      nullifierCommitted: true,
      consumeBlock: 113796,
      consumeTimestampSec: 1791638693,
      attemptCount: 0
    });
  });

  it('burnEvidence refuses an answer that lost a field', async () => {
    const { run } = scripted({ noteId: BURN_NOTE });
    await expect(
      burnEvidence(
        RPC,
        {
          faucetBech32: FAUCET,
          noteId: BURN_NOTE,
          senderBech32: WALLET,
          domain: 26,
          recipient: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
          amount: 1n
        },
        run
      )
    ).rejects.toThrow('no recipient');
  });

  it('burnOutputs sends the result bytes on stdin and reads the three roles', async () => {
    const { run, calls } = scripted({
      burn: { noteId: BURN_NOTE, amount: '10000000' },
      sponsorship: { noteId: '0x4ba32cfe831e2a265838cddfcbb2258ff995cf2c269f095b59ec2fbda07d31cf', amount: '119' },
      fee: { noteId: '0x01', amount: '133' }
    });
    await expect(
      burnOutputs({ resultBytesBase64: 'AAEC', burnNoteId: BURN_NOTE, faucetBech32: FAUCET }, run)
    ).resolves.toEqual({
      burn: { noteId: BURN_NOTE, amount: 10_000_000n },
      sponsorship: { noteId: '0x4ba32cfe831e2a265838cddfcbb2258ff995cf2c269f095b59ec2fbda07d31cf', amount: 119n },
      fee: { noteId: '0x01', amount: 133n }
    });
    expect(calls[0]).toEqual({
      args: ['burn-outputs', 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0', BURN_NOTE],
      stdin: 'AAEC'
    });
  });

  it('note reads a minted note and a missing one', async () => {
    const { run } = scripted(
      {
        noteId: MINT_NOTE,
        found: true,
        committed: true,
        senderHex: FAUCET_HEX,
        tag: 2376597504,
        assets: [{ faucetHex: FAUCET_HEX, amount: '2000000000' }]
      },
      { noteId: MINT_NOTE, found: false, committed: false, assets: [] }
    );
    await expect(note(RPC, MINT_NOTE, run)).resolves.toEqual({
      noteId: MINT_NOTE,
      found: true,
      committed: true,
      senderHex: FAUCET_HEX,
      tag: 2376597504,
      assets: [{ faucetHex: FAUCET_HEX, amount: 2_000_000_000n }]
    });
    await expect(note(RPC, MINT_NOTE, run)).resolves.toEqual({
      noteId: MINT_NOTE,
      found: false,
      committed: false,
      senderHex: undefined,
      tag: undefined,
      assets: []
    });
  });

  it('nullifier reads the commit block when there is one', async () => {
    const { run } = scripted({ committed: true, blockNum: 81204 }, { committed: false });
    await expect(nullifier(RPC, MINT_NOTE, run)).resolves.toEqual({ committed: true, blockNum: 81204 });
    await expect(nullifier(RPC, MINT_NOTE, run)).resolves.toEqual({ committed: false, blockNum: undefined });
  });

  it('recentNotes is best-effort: [] when the oracle fails', async () => {
    const { run } = scripted(new Error('node unreachable'));
    await expect(
      recentNotes(RPC, { faucetBech32: FAUCET, accountBech32: WALLET, sinceBlock: 1 }, run)
    ).resolves.toEqual([]);
  });
});

describe('waitForUsdcxMint', () => {
  const args = {
    mintNoteId: MINT_NOTE,
    depositHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
    nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
    faucetBech32: FAUCET,
    accountBech32: WALLET,
    sinceBlock: 81100,
    timeoutMs: 9_000,
    pollMs: 3_000
  } as const;
  const missing = { noteId: MINT_NOTE, found: false, committed: false, assets: [] };

  it('returns the note once the node has it', async () => {
    const clock = fakeClock();
    const found = { ...missing, found: true, committed: true, senderHex: FAUCET_HEX, tag: 1, assets: [] };
    const { run } = scripted(missing, found);
    await expect(waitForUsdcxMint(RPC, args, { run, clock })).resolves.toMatchObject({ found: true });
    expect(clock.slept).toEqual([3_000]);
  });

  it("times out naming Circle's relayer, the USDCx faucet, the deposit, the nonce, the id and the faucet's notes", async () => {
    const clock = fakeClock();
    const { run } = scripted(missing, missing, missing, missing, { noteIds: ['0xbe16', '0x0563'] });
    await expect(waitForUsdcxMint(RPC, args, { run, clock })).rejects.toThrow(
      [
        `Circle's relayer has not minted deposit ${args.depositHash} through the USDCx faucet mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0 within 9000 ms.`,
        `  nonce: ${args.nonce}`,
        `  derived mint note id: ${MINT_NOTE}`,
        "  the faucet's notes to mtst1are0gtx635qs7starjk4m3x49vcm0w2g since block 81100: 0xbe16, 0x0563"
      ].join('\n')
    );
  });
});

describe('boundLandedFee', () => {
  it('derives the fee from the vault delta and holds it under baseFee x FEE_RESERVE_MULTIPLE', () => {
    // A landed burn: V1 - V2 = N + f1 + s with N 1 USDCx, s 119, f1 133, base fee 7 (the small-burn probe's vault).
    expect(boundLandedFee({ vaultDelta: 1_000_252n, knownTerms: 1_000_119n, baseFee: 7 })).toEqual({
      fee: 133n,
      ceiling: 210n
    });
    // A landed consume of M = 0.001 USDCx: V2 - V3 = f2 - M.
    expect(boundLandedFee({ vaultDelta: 133n - 1_000n, knownTerms: -1_000n, baseFee: 7 }).fee).toBe(133n);
    expect(boundLandedFee({ vaultDelta: 210n, knownTerms: 0n, baseFee: 7 }).fee).toBe(210n);
  });

  it('refuses a fee of zero or one above the ceiling', () => {
    expect(() => boundLandedFee({ vaultDelta: 1_000_119n, knownTerms: 1_000_119n, baseFee: 7 })).toThrow(
      'landed-path fee 0'
    );
    expect(() => boundLandedFee({ vaultDelta: 211n, knownTerms: 0n, baseFee: 7 })).toThrow('outside (0, 210]');
  });
});

// The real oracle on the installed SDK. These subcommands read no network.
describe('usdcx-chain-evidence.mjs', () => {
  jest.setTimeout(60_000);

  it.each([
    {
      deposit: 'Circle-attested 0x370bf19a (NEGATIVE vector), minted at block 81129',
      recipientHex: '0x8da911727d5b53916f2c221c00c091',
      units: 2_000_000_000n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      minted: '0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93'
    },
    {
      deposit: 'the 2026-10-10 spike deposit back 0x9bed24c5, consumed by its wallet',
      recipientHex: '0xf2f42cda8d010f417d1cad5dc4d52b',
      units: 1_000_000n,
      nonce: '0x6ff37d71883632f16af4b01d811e26a8141517663bca88e5cfc23d7fcbe0a3b4',
      minted: '0xbedb2cea0b47a01b8ebc6c10e428d0ff3bb782406e2784b4380ab171757b301e'
    },
    {
      deposit: 'the 2026-10-11 min-deposit probe 0x0fe5eced, 1000 units, claimed by its CLI account',
      recipientHex: '0xcd66b826c325f2011c5aaf6790043f',
      units: 1_000n,
      nonce: '0xf356b45ab7e473dc72893884904c97a9e5048c4d37293389ae8164852f003b03',
      minted: '0x5770ac9fa73326171c22360a099f985baa353f007d67ac1110db1e52c22a6c85'
    }
  ] as const)('derives the note miden-usdcx minted for $deposit', async ({ recipientHex, units, nonce, minted }) => {
    await expect(deriveUsdcxMintNoteId({ faucetHex: FAUCET_HEX, recipientHex, units, nonce })).resolves.toBe(minted);
  });

  it('reads the account id of a bech32 address', async () => {
    await expect(accountHex(FAUCET)).resolves.toBe(FAUCET_HEX);
    await expect(accountHex('mtst1azx6jytj04d48yt09s3pcqxqjyal7kas')).resolves.toBe('0x8da911727d5b53916f2c221c00c091');
  });

  it('fails an unknown subcommand with its usage line', async () => {
    await expect(runChainEvidence(['frobnicate'], { timeoutMs: 30_000 })).rejects.toThrow(
      'usdcx-chain-evidence frobnicate: AssertionError [ERR_ASSERTION]: usage: usdcx-chain-evidence.mjs <supply|'
    );
  });

  // A caller of the removed positional form (an RPC URL first) must fail loudly, never read its URL as a subcommand's
  // argument.
  it('refuses the removed positional form, an RPC URL first, with its usage line', async () => {
    await expect(
      runChainEvidence([RPC, 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0'], { timeoutMs: 30_000 })
    ).rejects.toThrow(
      `usdcx-chain-evidence ${RPC}: AssertionError [ERR_ASSERTION]: usage: usdcx-chain-evidence.mjs <supply|`
    );
  });
});
