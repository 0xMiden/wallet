import type { BrowserContext, Page } from '@playwright/test';

import { deadlineIn, HarnessFault, InfrastructureFault } from './dapp-cells';
import { callDapp, ChainUnavailable, type DappHandle } from './test-dapp';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

// What page.evaluate rejects with when the page throws: Playwright carries the page error's stack, which opens with
// the error's name.
const pageError = (name: string, message: string): Error =>
  new Error(`page.evaluate: ${name}: ${message}\n    at call (http://localhost:4810/test-dapp.js:1:1)`);

function dappAnswering(answers: unknown[]): { dapp: DappHandle; calls: () => number } {
  const evaluate = jest.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const dapp: DappHandle = {
    page: { evaluate } as unknown as Page,
    label: 'one',
    origin: 'http://localhost:4810',
    context: {} as unknown as BrowserContext
  };
  return { dapp, calls: () => evaluate.mock.calls.length };
}

describe('callDapp', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks a chain read again after the node failed it, until it answers', async () => {
    const node = pageError('ChainUnavailableError', 'getNotesById: TypeError: Failed to fetch');
    const { dapp, calls } = dappAnswering([node, node, { found: true, blockNum: 7 }]);
    const read = callDapp(dapp, 'chainNote', { noteId: '0x01' }, deadlineIn(60_000, 'W1'));
    await jest.advanceTimersByTimeAsync(4_000);
    await expect(read).resolves.toEqual({ found: true, blockNum: 7 });
    expect(calls()).toBe(3);
  });

  it('reports a node that fails every read until the deadline as infrastructure, with its last error', async () => {
    const failures = Array.from({ length: 10 }, (_, i) =>
      pageError('ChainUnavailableError', `getAccountDetails: attempt ${i + 1} refused`)
    );
    const { dapp, calls } = dappAnswering(failures);
    const read = callDapp(dapp, 'chainAccount', { accountId: '0x02' }, deadlineIn(7_000, 'W1')).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(7_000);
    const error = await read;
    expect(error).toBeInstanceOf(ChainUnavailable);
    expect(error).toBeInstanceOf(InfrastructureFault);
    expect(error).toMatchObject({ message: expect.stringContaining('attempt 4 refused') });
    expect(error).toMatchObject({ message: expect.stringContaining('4 attempts') });
    expect(calls()).toBe(4);
  });

  it("never asks again after the page's own fault, which stays a harness fault", async () => {
    const { dapp, calls } = dappAnswering([pageError('HarnessCheckError', 'init has not run')]);
    const read = callDapp(dapp, 'chainNote', { noteId: '0x01' }, deadlineIn(60_000, 'W1'));
    await expect(read).rejects.toBeInstanceOf(HarnessFault);
    expect(calls()).toBe(1);
  });

  it('asks a command whose answer depends on when it is read only once, and still names the node', async () => {
    const { dapp, calls } = dappAnswering([
      pageError('ChainUnavailableError', 'syncChain: TypeError: Failed to fetch')
    ]);
    const read = callDapp(dapp, 'syncHeight', {}, deadlineIn(60_000, 'W1'));
    await expect(read).rejects.toBeInstanceOf(ChainUnavailable);
    expect(calls()).toBe(1);
  });
});
