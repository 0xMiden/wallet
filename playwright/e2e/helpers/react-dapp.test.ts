import type { BrowserContext, Page } from '@playwright/test';

import { deadlineIn, HarnessFault } from './dapp-cells';
import { latestSnapshot } from './dapp-gates';
import { callReact, connectReact, resetReact, selectReact, waitForReact } from './react-dapp';
import { ChainUnavailable, type DappHandle } from './test-dapp';
import { REACT_DAPP_ORIGIN } from './test-dapp-server';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { ReactPageView, ReactSnapshot, ReactTree } from '../test-dapp/react-protocol';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

const ADAPTER = 'Bread Wallet';
const snapshotOf = (tree: ReactTree, extra: Partial<ReactSnapshot> = {}): ReactSnapshot => ({
  at: 0,
  tree,
  autoConnect: false,
  connected: false,
  connecting: false,
  disconnecting: false,
  address: null,
  publicKeyHex: null,
  selected: null,
  readyStates: ['Installed'],
  requestFunctions: [],
  ...extra
});
const viewOf = (...snapshots: ReactSnapshot[]): ReactPageView => ({
  now: 0,
  adapterName: ADAPTER,
  snapshots,
  events: [],
  providerAddress: null,
  storedNames: { wallet: null, midenfi: ADAPTER },
  pageErrors: []
});
const pageError = (name: string, message: string): Error =>
  new Error(`page.evaluate: ${name}: ${message}\n    at call (http://localhost:4811/react-dapp.js:1:1)`);

// Answers `view` with the next of `views` (the last one once they run out), any other command from `answers`.
function reactAnswering(views: ReactPageView[], answers: Record<string, unknown> = {}) {
  const commands: string[] = [];
  // A call with no argument is resetReact's storage clear, which answers nothing.
  const evaluate = jest.fn(async (_script: unknown, call?: { command: string }) => {
    if (call === undefined) return undefined;
    commands.push(call.command);
    if (call.command === 'view') return views.length > 1 ? views.shift() : views[0];
    const answer = answers[call.command];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const react: DappHandle = {
    // A load publishes testDapp at once.
    page: {
      evaluate,
      waitForTimeout: jest.fn(async () => undefined),
      goto: jest.fn(async () => null),
      waitForFunction: jest.fn(async () => undefined),
      on: jest.fn(),
      off: jest.fn()
    } as unknown as Page,
    label: 'react',
    origin: REACT_DAPP_ORIGIN,
    // No popup ever opens: the wallet answers every connect from its session.
    context: { waitForEvent: () => new Promise(() => undefined) } as unknown as BrowserContext
  };
  return { react, commands };
}
const ctx = () => ({ deadline: deadlineIn(60_000, 'WP1'), evidence: {}, softFail: jest.fn() });

describe('resetReact', () => {
  it('waits past a page at rest whose MidenFi tree has not committed its own selection yet', async () => {
    const unselected = viewOf(snapshotOf('wallet'), snapshotOf('midenfi'));
    const selected = viewOf(snapshotOf('wallet'), snapshotOf('midenfi', { selected: ADAPTER }));
    const { react, commands } = reactAnswering([unselected, unselected, selected]);
    const query = { network: 'testnet', rpcUrl: 'testnet', feeFaucetId: 'mtst1qfee', autoConnect: false };
    const view = await resetReact({} as GuardianAwareWalletPage, react, query, 'keep', ctx());
    expect({ selected: latestSnapshot(view, 'midenfi')?.selected, commands }).toEqual({
      selected: ADAPTER,
      commands: ['view', 'view', 'view']
    });
  });
});

describe('selectReact', () => {
  it('returns only once React committed the selection, so the next command reads the selected context', async () => {
    const { react, commands } = reactAnswering(
      [viewOf(snapshotOf('wallet')), viewOf(snapshotOf('wallet')), viewOf(snapshotOf('wallet', { selected: ADAPTER }))],
      { select: { selected: ADAPTER } }
    );
    await expect(selectReact(react, 'wallet', ctx())).resolves.toMatchObject({ selected: ADAPTER });
    expect(commands).toEqual(['select', 'view', 'view', 'view']);
  });
});

describe('connectReact', () => {
  it('waits past a context still on the account it held before, to the one it was asked for', async () => {
    const before = snapshotOf('wallet', { selected: ADAPTER, connected: true, address: 'mtst1qfirst_qruqqypuyph' });
    const after = snapshotOf('wallet', { selected: ADAPTER, connected: true, address: 'mtst1qsecond_qruqqypuyph' });
    const { react, commands } = reactAnswering([viewOf(before), viewOf(before), viewOf(after)], {
      connect: { ok: true, value: null }
    });
    await expect(connectReact(react, 'wallet', 'mtst1qsecond', ctx())).resolves.toEqual(after);
    expect(commands).toEqual(['connect', 'view', 'view', 'view']);
  });

  it('takes a connected context whose key is not a Word as connected, and keeps why as evidence', async () => {
    const connected = snapshotOf('wallet', {
      selected: ADAPTER,
      connected: true,
      address: 'mtst1qfirst_qruqqypuyph',
      publicKeyError: 'Error: invalid word length'
    });
    const { react, commands } = reactAnswering([viewOf(connected)], { connect: { ok: true, value: null } });
    const context = ctx();
    await expect(connectReact(react, 'wallet', 'mtst1qfirst', context)).resolves.toEqual(connected);
    expect({ commands, evidence: context.evidence }).toEqual({
      commands: ['connect', 'view'],
      evidence: { reactPublicKeyError: 'Error: invalid word length' }
    });
  });
});

describe('waitForReact', () => {
  it('ends at a page error instead of waiting out its time, and names whose fault it is', async () => {
    const stalled = viewOf(snapshotOf('wallet'));
    const failures = await Promise.all(
      ['probe wallet: TypeError: boom', 'unhandledrejection: TypeError: boom'].map(async thrown => {
        const { react, commands } = reactAnswering([stalled, { ...stalled, pageErrors: [thrown] }]);
        const failure = await waitForReact(
          react,
          view => latestSnapshot(view, 'wallet')?.connected === true,
          1_000,
          ctx()
        ).catch((error: unknown) => error);
        return {
          harness: failure instanceof HarnessFault,
          message: failure instanceof Error ? failure.message : 'no error',
          commands
        };
      })
    );
    expect(failures).toEqual([
      {
        harness: true,
        message: 'the React dApp threw while the driver waited: probe wallet: TypeError: boom',
        commands: ['view', 'view']
      },
      {
        harness: false,
        message: 'the React dApp threw while the driver waited: unhandledrejection: TypeError: boom',
        commands: ['view', 'view']
      }
    ]);
  });
});

describe('callReact', () => {
  it("maps the node's failure in the page to ChainUnavailable and the page's own fault to HarnessFault", async () => {
    const { react } = reactAnswering([viewOf()], {
      signerSync: pageError('ChainUnavailableError', 'syncState: TypeError: Failed to fetch'),
      createAccount: pageError('HarnessCheckError', 'MidenFiSignerProvider offers no createAccount')
    });
    await expect(callReact(react, 'signerSync', {}, deadlineIn(60_000, 'MF3'))).rejects.toBeInstanceOf(
      ChainUnavailable
    );
    await expect(callReact(react, 'createAccount', {}, deadlineIn(60_000, 'MF2'))).rejects.toBeInstanceOf(HarnessFault);
  });
});
