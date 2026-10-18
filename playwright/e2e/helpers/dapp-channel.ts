import { CellDeadlineExceeded, InfrastructureFault, type Deadline } from './dapp-cells';
import { beforeMobileDeadline } from './mobile-store-reads';
import type { DappCommandName, DappInput, DappOutput } from '../test-dapp/protocol';

/**
 * How the driver reaches a test dApp page's `window.testDapp.call` (spec 3.3): `page.evaluate` on the extension
 * (`pageChannel`, test-dapp.ts) and the command server's long-poll on mobile (`commandChannel`,
 * dapp-command-server.ts). `callOn` keeps one set of semantics over both, so a deadline, a re-ask and a fault mean the
 * same on every surface.
 */
export interface DappChannel {
  /** Names the page in every message: `one`, `two`, `react`, or `<device>/<dApp>` on mobile. */
  readonly label: string;
  /**
   * Asks once. `timeoutMs` is what the cell deadline leaves, less `CHANNEL_MARGIN_MS`, or undefined with no deadline; a
   * channel whose transport has no bound of its own ignores it. Rejects with `ChainUnavailable` when the node failed
   * the page, `HarnessFault` when the page itself threw, and on mobile `CellDeadlineExceeded` when the page took the
   * command and never answered or the time left was shorter than the page's gap between polls.
   */
  send(command: string, input: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * The node behind the dApp's own client failed a call, or the chain did not advance: the environment's failure, so a
 * cell that meets it is `blocked (infrastructure)`, never a harness fault or a wallet verdict. It is that cell's alone
 * (`abortsLeg: false`): no INFRA_ABORT, and the next cell runs its own quiesce.
 */
export class ChainUnavailable extends InfrastructureFault {
  constructor(message: string) {
    super(message, { abortsLeg: false });
    this.name = 'ChainUnavailable';
  }
}

// Commands a repeat cannot change the answer of, so callOn asks again after the node failed one. Each makes its node
// call before anything the wallet, the adapter or the dApp's store sees, or repeats harmlessly (see the handlers in
// test-dapp/test-dapp.ts): the chain reads; syncHeight; init, which keeps its first client and listens on the provider
// once; buildCustom and buildCustomScript, which sync before they compile, build or hold anything; makeNoteFile, whose
// getNotesById comes before its import. waitForHeight is not one: the page retries its own syncs until its timeout.
export const REPEATABLE: ReadonlySet<DappCommandName> = new Set([
  'chainNote',
  'chainNullifier',
  'chainAccount',
  'syncHeight',
  'init',
  'buildCustom',
  'buildCustomScript',
  'makeNoteFile'
]);
const NODE_RETRY_MS = 2_000;
/** A channel's own timeout ends this far before the cell deadline, so its verdict, not the deadline race's, is recorded. */
export const CHANNEL_MARGIN_MS = 1_000;

function askOnce<K extends DappCommandName>(
  channel: DappChannel,
  command: K,
  input: DappInput<K>,
  deadline?: Deadline
): Promise<DappOutput<K>> {
  const timeoutMs = deadline === undefined ? undefined : Math.max(1, deadline.remainingMs() - CHANNEL_MARGIN_MS);
  // The page answers with the protocol's output for the command (protocol.ts DappCommands); the channel is untyped
  // because a generic command and input pair is too deep for Playwright's evaluate typing (TS2589).
  return channel.send(command, input, timeoutMs) as Promise<DappOutput<K>>;
}

/**
 * One `window.testDapp` command, raced against `deadline` when one is given. With a deadline, a `REPEATABLE` command
 * the node failed is asked again every 2 s while the time left covers that interval and another attempt as long as the
 * last (spec section 2.4); `once` asks a single time, for a read compared with an earlier one. The last node failure is
 * what it then throws, with the attempt count, also when the deadline cuts the attempt after it.
 */
export async function callOn<K extends DappCommandName>(
  channel: DappChannel,
  command: K,
  input: DappInput<K>,
  deadline?: Deadline,
  options: { once?: boolean } = {}
): Promise<DappOutput<K>> {
  if (deadline === undefined) return askOnce(channel, command, input);
  const repeat = REPEATABLE.has(command) && options.once !== true;
  let failed: ChainUnavailable | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      return await beforeMobileDeadline(deadline, `dApp ${channel.label} ${command}`, () =>
        askOnce(channel, command, input, deadline)
      );
    } catch (error) {
      if (error instanceof CellDeadlineExceeded && failed !== undefined) {
        throw new ChainUnavailable(`${failed.message} (after ${attempt} attempts, the deadline cut the last)`);
      }
      if (!(error instanceof ChainUnavailable) || !repeat) throw error;
      failed = error;
      if (deadline.remainingMs() < NODE_RETRY_MS + (Date.now() - startedAt)) {
        throw attempt === 1 ? error : new ChainUnavailable(`${error.message} (after ${attempt} attempts)`);
      }
      await new Promise(resolve => setTimeout(resolve, NODE_RETRY_MS));
    }
  }
}
