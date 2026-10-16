import fs from 'fs';
import path from 'path';

import { request } from 'lib/miden/front';
import {
  LOCAL_PROVER_FAILED_ERROR,
  PROVER_PROCEDURE_MISMATCH_ERROR,
  REMOTE_PROVER_FAILED_ERROR
} from 'lib/miden/transaction/constants';
import { WalletMessageType } from 'lib/shared/types';

import { beginFlow, classifyError } from './report-flow';
import { __resetRunForTest, RUN_IDLE_ROTATE_MS } from './run';
import { FlowEndedEvent, FlowStartedEvent, TelemetryEvent } from './types';

jest.mock('lib/miden/front', () => ({ request: jest.fn() }));

// The repo-wide manual mock at `__mocks__/nanoid.ts` returns the constant `id`,
// which would make every flow share one identifier and hide the very thing
// `beginFlow` has to get right. A counter keeps the id deterministic while
// still failing if the implementation ever hoists `nanoid()` out of the call.
jest.mock('nanoid', () => {
  let issued = 0;
  return { nanoid: () => `flow-${++issued}` };
});

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

// The run is module state, so it outlives a `describe`. File-level rather than
// scoped to the block that asserts on it: a test elsewhere that mocks the clock
// leaves `lastEventAt` behind, and the next test to care about run ids would
// inherit it.
beforeEach(() => __resetRunForTest());

/**
 * Only telemetry requests, narrowed off the `WalletRequest` union rather than
 * cast, so a change to the message shape fails `yarn ts` here too.
 */
const sentEvents = (): TelemetryEvent[] =>
  jest
    .mocked(request)
    .mock.calls.flatMap(([req]) => (req.type === WalletMessageType.ReportTelemetryEventRequest ? [req.event] : []));

const eventAt = (index: number): FlowStartedEvent | FlowEndedEvent => {
  const event = sentEvents()[index];
  if (event === undefined) throw new Error(`expected a telemetry event at index ${index}`);
  // `beginFlow` only ever emits the two flow phases; a `settled` event here
  // would mean the operation reporter had been wired into this path by mistake.
  if (event.phase === 'settled') throw new Error(`expected a flow event at index ${index}, got a settled operation`);
  return event;
};

const endedEventAt = (index: number): FlowEndedEvent => {
  const event = eventAt(index);
  if (event.phase !== 'ended') throw new Error(`expected the event at index ${index} to have ended`);
  return event;
};

describe('beginFlow', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => jest.resetAllMocks());

  it('emits a started event immediately', () => {
    beginFlow('send');
    const [call] = jest.mocked(request).mock.calls;
    expect(call?.[0].type).toBe(WalletMessageType.ReportTelemetryEventRequest);
    expect(eventAt(0)).toMatchObject({ phase: 'started', flow: 'send' });
  });

  it('emits completed with a duration on complete', () => {
    beginFlow('send').complete();
    expect(endedEventAt(1)).toMatchObject({ phase: 'ended', flow: 'send', result: 'completed' });
    expect(typeof endedEventAt(1).durationMs).toBe('number');
  });

  it('emits cancelled on cancel', () => {
    beginFlow('import').cancel();
    expect(eventAt(1)).toMatchObject({ result: 'cancelled' });
  });

  it('emits errored with the supplied kind on fail', () => {
    beginFlow('recover').fail('rpc');
    expect(eventAt(1)).toMatchObject({ result: 'errored', errorKind: 'rpc' });
  });

  it('omits errorKind on a non-error outcome', () => {
    beginFlow('send').complete();
    expect(endedEventAt(1).errorKind).toBeUndefined();
  });

  it('pairs started and ended by flowId', () => {
    beginFlow('send').complete();
    expect(eventAt(0).flowId).toBe(eventAt(1).flowId);
    expect(eventAt(0).flowId.length).toBeGreaterThan(0);
  });

  it('gives concurrent flows distinct ids', () => {
    beginFlow('send');
    beginFlow('fund');
    expect(eventAt(0).flowId).not.toBe(eventAt(1).flowId);
  });

  it('ignores a second terminal call on the same handle', () => {
    const flow = beginFlow('send');
    flow.complete();
    flow.cancel();
    flow.fail('rpc');
    expect(sentEvents()).toHaveLength(2);
  });

  it('never throws or leaves a rejection unhandled when the intercom request fails', async () => {
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);

    try {
      jest.mocked(request).mockRejectedValue(new Error('port closed'));
      expect(() => beginFlow('send').complete()).not.toThrow();
      await flushMicrotasks();
      expect(jest.mocked(request).mock.calls.length).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  });
});

describe('runId', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => jest.resetAllMocks());

  it('is shared by every flow of one run, which is what makes a session a visit', () => {
    // The property the redesign exists for. Sending the per-flow id as the
    // Aptabase session made each session hold one flow and last 0s, so the
    // dashboard could not say that a person opened the wallet and then swapped.
    beginFlow('open').complete();
    beginFlow('swap').complete();

    const runs = new Set(sentEvents().map(event => event.runId));
    expect(runs.size).toBe(1);
  });

  it('is carried by both halves of a flow, so a pair never straddles two runs', () => {
    beginFlow('send').complete();
    expect(eventAt(0).runId).toBe(eventAt(1).runId);
  });

  it('starts over for a new run, since nothing about it is written down', () => {
    beginFlow('open').complete();
    const first = eventAt(0).runId;

    // What a reopened popup or a relaunched app does: the module is evaluated
    // again and the previous id is simply gone. There is no storage to clear.
    __resetRunForTest();
    beginFlow('open').complete();

    expect(eventAt(2).runId).not.toBe(first);
  });

  it('rotates after a long idle, bounding how much activity one id can cover', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // A wallet left open in a background tab overnight. Tomorrow's activity
      // must not be joinable to today's just because the page never reloaded.
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 1);
      beginFlow('open').complete();

      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
    }
  });

  it('does not rotate while the run is still being used', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // Stepping away from a half-finished send and coming back is one visit,
      // so the threshold has to be measured from the last event and not the
      // first — this fails if the rotation is keyed on the run's total age.
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS - 1);
      beginFlow('send').complete();
      now.mockReturnValue(1_000_000 + 2 * RUN_IDLE_ROTATE_MS - 2);
      beginFlow('swap').complete();

      const runs = new Set(sentEvents().map(event => event.runId));
      expect(runs.size).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('rotates after a flow that was itself left open past the idle window', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      // A send left open on a full-page tab overnight and dismissed in the
      // morning. Settling it is activity, but activity that arrives this late
      // must retire the run rather than re-arm it — otherwise one id covers
      // both days, and every subsequent long flow extends it again.
      now.mockReturnValue(1_000_000);
      const overnight = beginFlow('send');
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 1);
      overnight.cancel();

      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 2);
      beginFlow('swap').complete();

      // The stale flow's own two events still pair, since the id is captured up
      // front. It is the morning's flow that has to land somewhere new.
      expect(eventAt(1).runId).toBe(eventAt(0).runId);
      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a long flow in its run when other activity kept that run alive', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      // The counterweight to the test above, and the reason the idle check is
      // measured from the last event of ANY flow rather than from this flow's
      // own start. Someone deliberating on a review screen for half an hour
      // while using the rest of the wallet is one visit; keying the rotation on
      // the open flow's age would shatter it, and every other test here would
      // still pass.
      now.mockReturnValue(1_000_000);
      const deliberating = beginFlow('send');
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS - 60_000);
      beginFlow('open').complete();
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 60_000);
      deliberating.complete();

      // The flow that follows is what makes this load-bearing. Settling the
      // long one emits under the id it captured either way, so the mistake is
      // invisible until something new asks the run which id it is on.
      now.mockReturnValue(1_000_000 + RUN_IDLE_ROTATE_MS + 61_000);
      beginFlow('swap').complete();

      const runs = new Set(sentEvents().map(event => event.runId));
      expect(runs.size).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('rotates when the clock jumps backwards, which would otherwise stall it forever', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      beginFlow('open').complete();

      // An NTP correction. A negative elapsed time is never greater than the
      // threshold, so without an explicit check the run would never rotate
      // again for as long as the page lived.
      now.mockReturnValue(1_000_000 - RUN_IDLE_ROTATE_MS);
      beginFlow('open').complete();

      expect(eventAt(2).runId).not.toBe(eventAt(0).runId);
    } finally {
      now.mockRestore();
    }
  });
});

describe('classifyError', () => {
  // Every alternative in every `||` is listed, so no operand can rot unnoticed
  // behind a sibling that short-circuits first.
  it.each([
    ['Failed to fetch', 'network'],
    ['network unreachable', 'network'],
    ['network request timed out', 'timeout'],
    ['request timeout exceeded', 'timeout'],
    ['rpc error: invalid response', 'rpc'],
    ['proving failed after fallback', 'proving'],
    ['QuotaExceededError writing to disk', 'storage'],
    ['object store not found', 'storage'],
    ['IndexedDB is unavailable', 'storage'],
    ['invalid password', 'auth'],
    ['unauthorized', 'auth'],
    ['biometric prompt dismissed', 'auth'],
    ['invalid recipient address', 'validation'],
    ['amount must be positive', 'validation'],
    ['recipient is required', 'validation'],
    ['something nobody predicted', 'unknown']
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  // Approval and provider failures share the letters `prov` with proving, and an
  // EVM deposit refusal labelled `proving` sends triage after a prover that never ran.
  it.each([
    ['The connected WalletConnect session did not approve Base Sepolia (eip155:84532).', 'unknown'],
    ['Aprove a rede na carteira conectada.', 'unknown'],
    ['The connected EVM wallet provider is unavailable.', 'unknown'],
    ['Guardian account acc not found in provider', 'unknown'],
    ['Account not found. Please provide an account.', 'unknown'],
    ['Some of the parameters you provided are invalid', 'validation'],
    ['the fee of the second quote is more than the approval covers', 'unknown'],
    ['number of approvers cannot be greater than 255', 'unknown'],
    ['account provisioning failed', 'unknown']
  ])('does not read %j as a proving failure', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  const localesDir = path.join(__dirname, '../../../public/_locales');
  it.each(fs.readdirSync(localesDir))('does not read the %s chain-approval refusal as a proving failure', locale => {
    // The deposit screen stores this localized copy on the failed row, and the reporter classifies it.
    const copy = JSON.parse(fs.readFileSync(path.join(localesDir, locale, `${locale}.json`), 'utf8'));
    expect(classifyError(copy.evmChainNotApproved.replace('$network$', 'Ethereum Sepolia'))).not.toBe('proving');
  });

  // As the wallet, the SDK and the native prover word them.
  it.each([
    'Offscreen prove failed: worker crashed',
    'Offscreen prover returned no response (doc may have been closed or reaped)',
    'Local prove failed in the prove worker (crashed)',
    LOCAL_PROVER_FAILED_ERROR,
    REMOTE_PROVER_FAILED_ERROR,
    PROVER_PROCEDURE_MISMATCH_ERROR,
    'proveInWorker called in a realm with no local prove transport',
    'operation abandoned before the send remote re-prove',
    'operation abandoned after the send prove',
    'worker prove refused: no live hold',
    'buildNativeProverCallback called outside a mobile context',
    'unsupported prover descriptor',
    'failed to prove transaction: transaction proving failed',
    'callback prover promise rejected: MidenNativeProver: prover rejected the transaction',
    'Remote prover requires an endpoint'
  ])('classifies the proving failure %j as proving', message => {
    expect(classifyError(new Error(message))).toBe('proving');
  });

  // Copied from where each is thrown or stored. A letter before `store` puts it
  // inside keystore or restore, and labelling these `storage` sends triage after
  // a database that never failed.
  it.each([
    ['no sign callback installed in this realm - see installRealmKeystore', 'unknown'],
    ['Transaction tx-1 was restored from a backup and cannot be resubmitted', 'unknown'],
    ['Swap tx-1 was restored from a backup, so this wallet cannot reclaim it', 'unknown'],
    ['Restored from a backup \u2014 delivery could not be verified.', 'unknown'],
    ['Restored from a backup - this withdrawal could not be verified.', 'unknown'],
    ['Wallet has no accounts an encrypted file can restore', 'unknown'],
    ['Failed to restore imported account secret', 'unknown']
  ])('does not read %j as a storage failure', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  // As IndexedDB, the browser and Dexie word them.
  it.each([
    'QuotaExceededError',
    'object store not found',
    "Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.",
    "Failed to execute 'get' on 'IDBObjectStore': The transaction has finished.",
    'store is closed',
    'KeyPath id on object store transactions is not indexed'
  ])('classifies the storage failure %j as storage', message => {
    expect(classifyError(new Error(message))).toBe('storage');
  });

  it.each(['restoreAccountLookupFailed', 'createAccountLookupFailed'])(
    'classifies the %s restore abort by its reason, not by its own copy',
    key => {
      // Onboarding reports these by classifying the displayed text, so their
      // fixed copy must stay neutral and leave the category to the raw reason.
      const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/_locales/en/en.json'), 'utf8'));
      const withReason = (reason: string) => en[key].replace('$reason$', reason);
      expect(classifyError(new Error(withReason('something nobody predicted')))).toBe('unknown');
      expect(classifyError(new Error(withReason('quota exceeded')))).toBe('storage');
    }
  );

  it('classifies a bare string, which is how the transaction pipeline stores a failure', () => {
    // A row records its reason as text and is classified much later, by which
    // point the `Error` it came from is gone. Before this, every transaction
    // failure classified as `unknown` — the field was present and useless.
    expect(classifyError('Remote prover timed out')).toBe('timeout');
    expect(classifyError('failed to fetch')).toBe('network');
  });

  it('classifies anything that is neither an Error nor a string as unknown', () => {
    // Not coerced with `String(value)`: stringifying an arbitrary throw is
    // exactly how free-form text would get somewhere near the wire, and the
    // classifier is the last place that should be improvising.
    expect(classifyError({ message: 'invalid recipient mtst1abc' })).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
    expect(classifyError(4200)).toBe('unknown');
  });

  it('never returns the original message', () => {
    const kind = classifyError(new Error('account mtst1secret balance 4200'));
    expect(kind).not.toContain('mtst1');
    expect(kind).not.toContain('4200');
  });
});

describe('step', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => jest.resetAllMocks());

  it('rides out on `ended` rather than emitting an event of its own', async () => {
    const flow = beginFlow('send');
    flow.step('select_amount');
    flow.step('review');
    flow.cancel();
    await flushMicrotasks();

    // Two events for the whole flow, not four: progress is free.
    expect(sentEvents()).toHaveLength(2);
    expect(endedEventAt(1).step).toBe('review');
  });

  it('is absent when the flow never reported one, rather than guessing a default', async () => {
    beginFlow('unlock').complete();
    await flushMicrotasks();

    expect(endedEventAt(1)).not.toHaveProperty('step');
  });

  it('keeps the last step reported, so going back a screen does not erase having reached review', async () => {
    const flow = beginFlow('swap');
    flow.step('review');
    // The user navigates back to the amounts screen and gives up there. What
    // matters for drop-off is that they had already got as far as review.
    flow.step('swap_amounts');
    flow.cancel();
    await flushMicrotasks();

    expect(endedEventAt(1).step).toBe('swap_amounts');
  });

  it('ignores a step recorded after the flow settled', async () => {
    const flow = beginFlow('earn');
    flow.step('review');
    flow.complete();
    // A screen unmounting after its flow completed must not rewrite history.
    flow.step('select_amount');
    await flushMicrotasks();

    expect(sentEvents()).toHaveLength(2);
    expect(endedEventAt(1).step).toBe('review');
  });
});
