import type { Page } from '@playwright/test';

import { expectVerifiedPreview } from './dapp-assertions';
import { deadlineIn, type CellContext } from './dapp-cells';

interface Recorded {
  target: string;
  matcher: string;
  args: unknown[];
}
const mockRecorded: Recorded[] = [];

// Each Playwright assertion is recorded against the locator chain it was made on: the test reads what
// expectVerifiedPreview asks of the popup, and the live runs prove the locators match the real one.
jest.mock('@playwright/test', () => ({
  expect: (target: { chain: string }) =>
    Object.fromEntries(
      ['toBeVisible', 'toHaveCount', 'toHaveText', 'toHaveAttribute'].map(matcher => [
        matcher,
        async (...args: unknown[]) => {
          mockRecorded.push({ target: target.chain, matcher, args });
        }
      ])
    )
}));

interface FakeLocator {
  chain: string;
  or(other: FakeLocator): FakeLocator;
  filter(options: { hasText: RegExp }): FakeLocator;
  getByText(text: string, options: { exact: boolean }): FakeLocator;
  locator(selector: string): FakeLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
}

const fakePopup = (verifiedCount: number): Page => {
  const fake = (chain: string): FakeLocator => ({
    chain,
    or: other => fake(`${chain}.or(${other.chain})`),
    filter: ({ hasText }) => fake(`${chain}.filter(${String(hasText)})`),
    getByText: (text, { exact }) => fake(`${chain}.getByText(${text}, exact ${exact})`),
    locator: selector => fake(`${chain} ${selector}`),
    count: async () => verifiedCount,
    isVisible: async () => true
  });
  return {
    locator: (selector: string) => fake(selector),
    getByTestId: (id: string) => fake(`testid=${id}`)
  } as unknown as Page;
};

const shown = (target: string, matcher: string, ...args: unknown[]): Recorded => ({ target, matcher, args });
const VERIFIED = '[data-testid="tx-asset-view"][data-mode="verified"]';
const OUTCOME = shown(`${VERIFIED}.or(testid=tx-simulation-failed)`, 'toBeVisible', { timeout: 60_000 });
const ctxWith = (softFail: CellContext['softFail']): CellContext => ({
  deadline: deadlineIn(60_000, 'X8c'),
  evidence: {},
  softFail
});

describe('expectVerifiedPreview', () => {
  beforeEach(() => {
    mockRecorded.length = 0;
  });

  it('checks a fee-only preview: no asset heading or row, no output notes, the storage value it names', async () => {
    await expectVerifiedPreview(
      fakePopup(1),
      { amount: null, outputNotes: 0, storageChanged: false },
      ctxWith(jest.fn())
    );
    expect(mockRecorded).toEqual([
      OUTCOME,
      shown(`${VERIFIED}.getByText(Asset changes, exact true)`, 'toHaveCount', 0),
      shown(`${VERIFIED} [data-verified="true"]`, 'toHaveCount', 0),
      shown('testid=tx-output-notes-created', 'toHaveText', '0'),
      shown('testid=tx-storage-changed', 'toHaveAttribute', 'data-changed', 'false'),
      shown('testid=tx-storage-changed', 'toHaveText', 'No'),
      shown('testid=tx-simulation-failed', 'toHaveCount', 0)
    ]);
  });

  it('checks a payment preview: one heading, one row with the amount, a storage row of either value', async () => {
    await expectVerifiedPreview(fakePopup(1), { amount: /^2 TST$/, outputNotes: 1 }, ctxWith(jest.fn()));
    expect(mockRecorded).toEqual([
      OUTCOME,
      shown(`${VERIFIED}.getByText(Asset changes, exact true)`, 'toHaveCount', 1),
      shown(`${VERIFIED} [data-verified="true"].filter(/^2 TST$/)`, 'toHaveCount', 1),
      shown('testid=tx-output-notes-created', 'toHaveText', '1'),
      shown('testid=tx-storage-changed', 'toHaveAttribute', 'data-changed', /^(true|false)$/),
      shown('testid=tx-storage-changed', 'toHaveText', /^(Yes|No)$/),
      shown('testid=tx-simulation-failed', 'toHaveCount', 0)
    ]);
  });

  it('records a declared view as soft evidence for the cell, and asserts nothing more', async () => {
    const softFail = jest.fn();
    await expectVerifiedPreview(
      fakePopup(0),
      { amount: null, outputNotes: 0, storageChanged: false },
      ctxWith(softFail)
    );
    expect(mockRecorded).toEqual([OUTCOME]);
    expect(softFail).toHaveBeenCalledWith('preview-verified', 'declared view, simulation failed shown: true', {
      previewSimulationFailed: true
    });
  });
});
