/** @jest-environment node */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { MainnetSwapCheckpoint } from '../playwright/e2e/helpers/mainnet-swap-checkpoint';
import {
  MainnetWalletCanaryLedger,
  type CanaryAdmission,
  type CanaryLedgerOptions
} from '../playwright/e2e/helpers/mainnet-wallet-canary-ledger';

const SLOT = 300_000;
const DAY = 86_400_000;
const START = Date.parse('2026-11-23T00:00:00Z');
const ACCOUNT = 'mm1dedicatedaccount';
const OFFER = '0x' + '1'.repeat(30);
const REQUEST = '0x' + '2'.repeat(30);
const iso = (time: number) => new Date(time).toISOString().replace('.000Z', 'Z');

function request(time: number, id: number, changes: Partial<CanaryAdmission> = {}): CanaryAdmission {
  return {
    slotStart: iso(time),
    runId: String(id),
    runAttempt: '1',
    offerFaucetId: OFFER,
    requestFaucetId: REQUEST,
    principalBaseUnits: 1_100_000n,
    principalUsdMicros: 1_100_000n,
    feeReserveBaseUnits: 60n,
    lossReserveUsdMicros: 1_200_000n,
    ...changes
  };
}

function checkpoint(admission: CanaryAdmission): MainnetSwapCheckpoint {
  const offered = {
    faucetId: 'mm1cohortoffered',
    hex: admission.offerFaucetId,
    symbol: 'USDCX',
    decimals: 6,
    balance: '10000000',
    usdMicros: '1000000'
  };
  return {
    version: 1,
    network: 'mainnet',
    account: ACCOUNT,
    sourceRunId: admission.runId,
    authorizationRunId: admission.runId,
    phase: 'forward-authorized',
    createdAt: admission.slotStart,
    pricedAt: admission.slotStart,
    updatedAt: admission.slotStart,
    offer: offered,
    request: {
      ...offered,
      faucetId: 'mm1cohortrequested',
      hex: admission.requestFaucetId,
      symbol: 'ETH',
      decimals: 8
    },
    native: offered,
    baseFee: '1',
    principal: admission.principalBaseUnits.toString(),
    forwardMinimum: '1000000',
    reverseMinimum: '1',
    knownOrderIds: [],
    feeBudget: admission.feeReserveBaseUnits.toString(),
    paidFees: '0',
    lossBudgetUsdMicros: admission.lossReserveUsdMicros.toString()
  };
}

function sendAuthority(state: MainnetSwapCheckpoint): MainnetSwapCheckpoint {
  return {
    ...state,
    forwardOrderId: state.sourceRunId,
    forwardRequestAuthority: {
      nonce: '11111111-1111-4111-8111-' + state.sourceRunId.padStart(12, '0'),
      noteId:
        '0x' +
        createHash('sha256')
          .update('send:' + state.sourceRunId)
          .digest('hex'),
      sha256: 'b'.repeat(64),
      canonicalSha256: 'c'.repeat(64),
      orderId: state.sourceRunId,
      minimumReceive: state.forwardMinimum,
      expiresAt: Date.parse(state.pricedAt) + SLOT
    }
  };
}

function claimAuthority(state: MainnetSwapCheckpoint): MainnetSwapCheckpoint {
  return {
    ...state,
    forwardClaimAuthority: {
      nonce: '22222222-2222-4222-8222-' + state.sourceRunId.padStart(12, '0'),
      noteId:
        '0x' +
        createHash('sha256')
          .update('claim:' + state.sourceRunId)
          .digest('hex'),
      amount: state.forwardMinimum,
      sha256: 'e'.repeat(64),
      canonicalSha256: 'f'.repeat(64),
      requestCanonicalSha256: '0'.repeat(64),
      expiresAt: Date.parse(state.updatedAt) + SLOT
    }
  };
}

function arm(ledger: MainnetWalletCanaryLedger, admission: CanaryAdmission): MainnetSwapCheckpoint {
  const initial = checkpoint(admission);
  ledger.saveCheckpoint(admission.slotStart, initial);
  const authorized = sendAuthority(initial);
  ledger.armSend(admission.slotStart, authorized);
  return authorized;
}

describe('durable one-direction wallet canary admissions', () => {
  let directory: string;
  let now: number;
  let handoff: CanaryLedgerOptions;
  let ledger: MainnetWalletCanaryLedger;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wallet-canary-slots-'));
    now = START;
    handoff = {
      directory,
      account: ACCOUNT,
      activationSlot: iso(START),
      dailyFeeBaseUnits: 10_000n,
      dailyLossUsdMicros: 50_000_000n,
      maxPrincipalUsdMicros: 2_000_000n,
      now: () => now
    };
    ledger = new MainnetWalletCanaryLedger({ ...handoff, initialize: true });
  });

  afterEach(() => {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function restart(): void {
    ledger.close();
    ledger = new MainnetWalletCanaryLedger(handoff);
  }

  it('admits exactly twelve independent frozen orders during a healthy hour', () => {
    const submissions = [];
    for (let slot = 0; slot < 12; slot++) {
      now = START + slot * SLOT;
      const admission = request(now, 123 + slot);
      expect(ledger.admit(admission).kind).toBe('admitted');
      const authorized = arm(ledger, admission);
      submissions.push(admission.slotStart);
      ledger.recordObservation(admission.slotStart, 'authorization_released');
      ledger.recordSubmission(admission.slotStart);
      ledger.saveCheckpoint(admission.slotStart, claimAuthority(authorized));
      ledger.recordObservation(admission.slotStart, 'payback');
      ledger.recordObservation(admission.slotStart, 'claim');
      ledger.finishReceipt(admission.slotStart, { feeBaseUnits: 20n, lossUsdMicros: 1_000n });
    }
    expect(submissions).toHaveLength(12);
    expect(new Set(submissions).size).toBe(12);
    expect(new Set(ledger.slots().map(slot => slot.lineageId)).size).toBe(12);
    expect(ledger.slots().every(slot => slot.status === 'usable_receipt')).toBe(true);
  });

  it('materializes a mixed 288-slot day through overlap, recovery and missed triggers', () => {
    const first = request(now, 123);
    expect(ledger.admit(first).kind).toBe('admitted');
    const firstAuthority = arm(ledger, first);
    expect(ledger.active()?.status).toBe('unknown');
    restart();

    now += SLOT;
    const busy = ledger.recordRunnerBusy(iso(now), '124', '1');
    expect(busy).toMatchObject({ status: 'blocked', reason: 'busy_wallet', runId: '124' });
    expect(busy?.lineageId).toMatch(/^[a-f0-9]{32}$/);
    expect(ledger.recordRunnerBusy(iso(now), '125', '1')).toBeUndefined();
    ledger.recordObservation(first.slotStart, 'inclusion');
    ledger.recordSubmission(first.slotStart);
    ledger.saveCheckpoint(first.slotStart, claimAuthority(firstAuthority));
    ledger.recordObservation(first.slotStart, 'payback');
    ledger.recordObservation(first.slotStart, 'claim');
    ledger.finishReceipt(first.slotStart, { feeBaseUnits: 15n, lossUsdMicros: 15n });

    now = START + 3 * SLOT;
    const noQuote = request(now, 126);
    expect(ledger.admit(noQuote).kind).toBe('admitted');
    ledger.abortBeforeSend(noQuote.slotStart, 'quote_unavailable');

    now = START + 4 * SLOT;
    const second = request(now, 127);
    expect(ledger.admit(second).kind).toBe('admitted');
    const secondAuthority = arm(ledger, second);
    ledger.recordSubmission(second.slotStart);
    ledger.saveCheckpoint(second.slotStart, claimAuthority(secondAuthority));
    ledger.recordObservation(second.slotStart, 'payback');
    ledger.recordObservation(second.slotStart, 'claim');
    ledger.finishReceipt(second.slotStart, { feeBaseUnits: 16n, lossUsdMicros: 16n });

    now = START + 5 * SLOT;
    expect(
      ledger.admit(request(now, 128, { principalUsdMicros: 2_100_000n, lossReserveUsdMicros: 2_200_000n })).kind
    ).toBe('budget_exhausted');

    now = START + 6 * SLOT;
    const preflight = request(now, 129);
    expect(ledger.recordPreflightBlock({ ...preflight, reason: 'preflight_failed' })).toMatchObject({
      status: 'blocked',
      reason: 'preflight_failed',
      feeReserveBaseUnits: 0n,
      lossReserveUsdMicros: 0n
    });

    now = START + DAY;
    ledger.advance();
    const slots = ledger.slots();
    expect(slots).toHaveLength(288);
    expect(slots.filter(slot => slot.submittedAt)).toHaveLength(2);
    expect(slots.filter(slot => slot.status === 'usable_receipt')).toHaveLength(2);
    expect(slots.filter(slot => slot.status === 'blocked')).toHaveLength(4);
    expect(slots.filter(slot => slot.status === 'missed')).toHaveLength(282);
    expect(slots[0]).toMatchObject({ slotStart: iso(START), runId: '123', submittedAt: iso(START + SLOT) });
  });

  it('lets only the admitting process bind authority, including across fresh database connections', () => {
    const first = request(now, 123);
    const other = new MainnetWalletCanaryLedger(handoff);
    try {
      expect(ledger.admit(first).kind).toBe('admitted');
      const prepared = checkpoint(first);
      ledger.saveCheckpoint(first.slotStart, prepared);
      expect(other.admit(request(now, 124, { offerFaucetId: REQUEST, requestFaucetId: OFFER })).kind).toBe('duplicate');
      expect(other.recordRunnerBusy(first.slotStart, '124', '1')).toBeUndefined();
      expect(() => other.armSend(first.slotStart, sendAuthority(prepared))).toThrow(/unused authority/);
      ledger.armSend(first.slotStart, sendAuthority(prepared));
      expect(() => ledger.armSend(first.slotStart, sendAuthority(prepared))).toThrow(/unused authority/);
    } finally {
      other.close();
    }
  });

  it('records current preflight blocks once and preserves an older open authorization', () => {
    const first = request(now, 123);
    expect(ledger.recordPreflightBlock({ ...first, reason: 'budget_exhausted' })).toMatchObject({
      status: 'blocked',
      reason: 'budget_exhausted',
      runId: first.runId,
      lineageId: expect.stringMatching(/^[a-f0-9]{32}$/)
    });
    expect(ledger.recordPreflightBlock({ ...first, reason: 'quote_unavailable' })).toBeUndefined();
    expect(ledger.admit(request(now, 124)).kind).toBe('duplicate');

    now += SLOT;
    const second = request(now, 125);
    expect(ledger.admit(second).kind).toBe('admitted');
    const authorized = arm(ledger, second);
    now += SLOT;
    expect(ledger.recordPreflightBlock({ ...request(now, 126), reason: 'quote_unavailable' })).toMatchObject({
      status: 'blocked',
      reason: 'busy_wallet'
    });
    expect(ledger.recordPreflightBlock({ ...second, reason: 'quote_unavailable' })).toBeUndefined();
    expect(ledger.active()).toMatchObject({ slotStart: second.slotStart, status: 'unknown', checkpoint: authorized });
  });

  it('admits one concurrent process and retains its exact authority after abrupt death', async () => {
    const program = `
      const { MainnetWalletCanaryLedger } = require(process.argv[1]);
      const directory = process.argv[2];
      const now = Number(process.argv[3]);
      const shortIso = new Date(now).toISOString().replace('.000Z', 'Z');
      const ledger = new MainnetWalletCanaryLedger({
        directory, account: 'mm1dedicatedaccount', now: () => now, activationSlot: shortIso,
        dailyFeeBaseUnits: 10000n, dailyLossUsdMicros: 50000000n, maxPrincipalUsdMicros: 2000000n
      });
      const direction = process.argv[4] === '123';
      const result = ledger.admit({
        slotStart: shortIso, runId: process.argv[4], runAttempt: '1',
        offerFaucetId: '0x' + (direction ? '1' : '2').repeat(30),
        requestFaucetId: '0x' + (direction ? '2' : '1').repeat(30),
        principalBaseUnits: 1100000n, principalUsdMicros: 1100000n,
        feeReserveBaseUnits: 60n, lossReserveUsdMicros: 1200000n
      });
      if (result.kind === 'admitted') {
        ledger.saveCheckpoint(shortIso, JSON.parse(process.argv[5]));
        ledger.armSend(shortIso, JSON.parse(process.argv[6]));
        process.kill(process.pid, 'SIGKILL');
      }
      process.stdout.write(result.kind);
      ledger.close();
    `;
    const exec = promisify(execFile);
    const helper = join(__dirname, '../playwright/e2e/helpers/mainnet-wallet-canary-ledger.ts');
    const module = require.resolve('ts-node/register/transpile-only');
    const fixtures = [
      checkpoint(request(now, 123)),
      checkpoint(request(now, 124, { offerFaucetId: REQUEST, requestFaucetId: OFFER }))
    ];
    const output = await Promise.allSettled(
      fixtures.map(state => {
        const args = [
          helper,
          directory,
          String(now),
          state.sourceRunId,
          JSON.stringify(state),
          JSON.stringify(sendAuthority(state))
        ];
        return exec(process.execPath, ['--require', module, '-e', program, ...args], {
          env: { ...process.env, TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}' }
        });
      })
    );
    expect(output).toContainEqual(
      expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ stdout: 'duplicate' }) })
    );
    expect(output).toContainEqual(
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ signal: 'SIGKILL' }) })
    );
    restart();
    expect(ledger.slots()).toHaveLength(1);
    const stored = ledger.active();
    expect(stored?.status).toBe('unknown');
    const winner = fixtures.find(state => state.sourceRunId === stored?.runId);
    if (!winner) throw new Error('No active authority from either process');
    const authority = sendAuthority(winner);
    expect(stored?.checkpoint).toEqual(authority);
    expect(() => ledger.armSend(winner.createdAt, authority)).toThrow(/unused authority/);
  }, 15_000);

  it('keeps an interrupted release unknown and forbids reopening the send after restart', () => {
    const admission = request(now, 123);
    expect(ledger.admit(admission).kind).toBe('admitted');
    const authorized = arm(ledger, admission);
    ledger.recordObservation(admission.slotStart, 'authorization_released');
    restart();
    expect(ledger.get(admission.slotStart)).toMatchObject({
      status: 'unknown',
      reason: 'submission_unconfirmed',
      checkpoint: authorized,
      observed: { authorization_released: admission.slotStart }
    });
    expect(ledger.get(admission.slotStart)?.submittedAt).toBeUndefined();
    expect(ledger.admit(request(now, 124)).kind).toBe('duplicate');
    expect(() => ledger.armSend(admission.slotStart, authorized)).toThrow(/unused authority/);
    expect(() => ledger.abortBeforeSend(admission.slotStart, 'confirmed_not_submitted')).toThrow(/send intent/);
    expect(() => ledger.finishReceipt(admission.slotStart, { feeBaseUnits: 5n, lossUsdMicros: 5n })).toThrow(
      /lacks submission/
    );
  });

  it('fails closed on custody mismatch, authority replacement and overspending', () => {
    const admission = request(now, 123);
    ledger.admit(admission);
    expect(() => ledger.saveCheckpoint(admission.slotStart, { ...checkpoint(admission), account: 'mm1other' })).toThrow(
      /original one-way/
    );
    const authorized = arm(ledger, admission);
    expect(() =>
      ledger.saveCheckpoint(admission.slotStart, {
        ...authorized,
        forwardOrderId: undefined,
        forwardRequestAuthority: undefined
      })
    ).toThrow(/forward send authority/);

    ledger.recordSubmission(admission.slotStart);
    const claimed = claimAuthority(authorized);
    ledger.saveCheckpoint(admission.slotStart, claimed);
    expect(() => ledger.saveCheckpoint(admission.slotStart, { ...claimed, forwardClaimAuthority: undefined })).toThrow(
      /original forward claim authority/
    );
    expect(() => ledger.finishReceipt(admission.slotStart, { feeBaseUnits: 61n, lossUsdMicros: 0n })).toThrow(
      /exceeds its original reservation/
    );
    expect(() => ledger.finishReceipt(admission.slotStart, { feeBaseUnits: 1n, lossUsdMicros: 0n })).toThrow(
      /needs the exact observed payback and claim/
    );
    expect(ledger.active()?.status).toBe('submitted');
  });

  it('cannot bind an already used on-chain order note to another slot', () => {
    const first = request(now, 123);
    ledger.admit(first);
    const authority = arm(ledger, first).forwardRequestAuthority;
    if (!authority) throw new Error('Invalid test fixture');
    ledger.recordSubmission(first.slotStart);
    ledger.finishCancellation(first.slotStart, { feeBaseUnits: 15n, lossUsdMicros: 0n });
    now += SLOT;
    const second = request(now, 124);
    ledger.admit(second);
    const prepared = checkpoint(second);
    ledger.saveCheckpoint(second.slotStart, prepared);
    const replacement = sendAuthority(prepared);
    if (!replacement.forwardRequestAuthority) throw new Error('Invalid test fixture');
    replacement.forwardRequestAuthority.noteId = authority.noteId;
    expect(() => ledger.armSend(second.slotStart, replacement)).toThrow(/UNIQUE/);
    expect(ledger.active()).toMatchObject({ status: 'admitted' });
  });

  it('charges an order to both UTC budget days and never backfills an elapsed order', () => {
    ledger.close();
    rmSync(join(directory, 'one-way-slots.sqlite'));
    now = START + DAY - SLOT;
    handoff = { ...handoff, activationSlot: iso(now), dailyFeeBaseUnits: 100n };
    ledger = new MainnetWalletCanaryLedger({ ...handoff, initialize: true });
    const original = request(now, 123);
    ledger.admit(original);
    arm(ledger, original);
    now = START + DAY;
    ledger.recordSubmission(original.slotStart);
    ledger.finishCancellation(original.slotStart, { feeBaseUnits: 60n, lossUsdMicros: 0n }, 'reclaimed');
    expect(ledger.get(original.slotStart)).toMatchObject({ status: 'cancelled', observed: { reclaimed: iso(now) } });
    expect(ledger.admit(request(now, 124)).kind).toBe('budget_exhausted');
    expect(ledger.admit(original).kind).toBe('elapsed_slot');
    now += DAY;
    expect(ledger.admit(request(now, 125)).kind).toBe('admitted');
  });

  it('requires explicit provisioning, a private file and consistent operator caps', () => {
    expect(lstatSync(join(directory, 'one-way-slots.sqlite')).mode & 0o777).toBe(0o600);
    expect(() => new MainnetWalletCanaryLedger({ ...handoff, directory: join(directory, 'lost-volume') })).toThrow();
    expect(() => new MainnetWalletCanaryLedger({ ...handoff, account: 'mm1other' })).toThrow(/different wallet/);
    expect(() => new MainnetWalletCanaryLedger({ ...handoff, dailyFeeBaseUnits: 1n })).toThrow(/different wallet/);
    chmodSync(join(directory, 'one-way-slots.sqlite'), 0o644);
    expect(() => new MainnetWalletCanaryLedger(handoff)).toThrow(/private/);
  });

  it('rejects a one-dollar or ambiguously timed order before taking an admission', () => {
    expect(() => ledger.admit(request(now, 123, { principalUsdMicros: 1_000_000n }))).toThrow(/amount/);
    expect(() => ledger.admit(request(now, 123, { runAttempt: '2' }))).toThrow(/run/);
    expect(() => ledger.admit(request(now, 123, { slotStart: new Date(now).toISOString() }))).toThrow(/slot start/);
    expect(ledger.slots()).toEqual([]);
  });
});
