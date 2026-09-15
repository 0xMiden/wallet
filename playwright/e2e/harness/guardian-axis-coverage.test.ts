import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { waitForPendingNoteTotal } from '../helpers/balance-truth';
import { guardianAxis, runMultiAccountJourney, type AccountAxis } from '../helpers/money-path';

jest.mock('@playwright/test', () => {
  const jestExpect = (globalThis as typeof globalThis & { expect: typeof expect }).expect;
  const playwrightExpect = Object.assign((actual: unknown) => jestExpect(actual), {
    poll: (sample: () => unknown | Promise<unknown>, options: { timeout?: number } = {}) => ({
      toBe: async (expected: unknown) => {
        const deadline = Date.now() + (options.timeout ?? 5_000);
        let actual: unknown;
        do {
          actual = await sample();
          if (Object.is(actual, expected)) return;
          await new Promise(resolve => setTimeout(resolve, 1));
        } while (Date.now() < deadline);
        jestExpect(actual).toBe(expected);
      }
    })
  });
  return { expect: playwrightExpect };
});

jest.mock('../helpers/balance-truth', () => ({
  toBaseUnits: jest.fn(),
  waitForPendingNoteTotal: jest.fn(),
  waitForVaultBalance: jest.fn(),
  waitForVaultDebit: jest.fn()
}));

const repoRoot = resolve(__dirname, '../../..');
const playwright = resolve(repoRoot, 'node_modules/.bin/playwright');
const guardianUrl = 'http://guardian.test:3000';

type GuardianAxisOptions = { endpointTimeoutMs: number };
type ConfigurableGuardianAxis = (url: string, options: GuardianAxisOptions) => AccountAxis;

const stepBlock = (source: string, name: string): string => {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const indent = lines[start]?.match(/^\s*/)?.[0] ?? '';
  const end = lines.findIndex((line, index) => {
    if (index <= start || !line.trim()) return false;
    return (line.match(/^\s*/)?.[0].length ?? 0) <= indent.length;
  });
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
};

const assertEarnGuardianLifecycle = (source: string): void => {
  const bringUp = stepBlock(source, 'Bring up guardian');
  const wait = stepBlock(source, 'Wait for guardian');
  const run = stepBlock(source, 'Run earn specs');
  const logs = stepBlock(source, 'Dump stack logs on failure');
  const teardown = stepBlock(source, 'Tear down');

  expect(bringUp).toMatch(/--profile\s+guardian\s+up\s+-d\s+guardian(?:\s|$)/);
  expect(bringUp).not.toMatch(/\bguardian-postgres\b/);
  expect(wait).toMatch(/curl[^\n]+http:\/\/127\.0\.0\.1:3000\//);
  expect(source.indexOf(wait)).toBeLessThan(source.indexOf(run));
  expect(logs).toMatch(/^\s*if:\s+failure\(\)\s*$/m);
  expect(logs).toMatch(/--profile\s+guardian[^\n]+logs\s+--no-color/);
  expect(teardown).toMatch(/^\s*if:\s+always\(\)\s*$/m);
  expect(teardown).toMatch(/--profile\s+guardian[^\n]+down\s+-v/);
};

const replaceStep = (source: string, name: string, replacement: (step: string) => string): string => {
  const step = stepBlock(source, name);
  return source.replace(step, replacement(step));
};

const listTests = (config: string): string => {
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_NETWORK: 'localhost' };
  delete env.JEST_WORKER_ID;
  return execFileSync(playwright, ['test', '--list', '--config', config], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
};

describe('production Guardian account E2E coverage', () => {
  let coreTests: string;
  let earnTests: string;
  let guardianTests: string;

  beforeAll(() => {
    coreTests = listTests('playwright.e2e.config.ts');
    earnTests = listTests('playwright.earn.config.ts');
    guardianTests = listTests('playwright.guardian.config.ts');
  });

  it('selects both account axes for earn deposits', () => {
    expect(earnTests).toContain('earn: deposit happy path - offchain account');
    expect(earnTests).toContain('earn: deposit happy path - guardian account');
  });

  it('selects both account axes for earn withdrawals', () => {
    expect(earnTests).toContain('earn: withdrawal recovery - offchain account');
    expect(earnTests).toContain('earn: withdrawal recovery - guardian account');
  });

  it('keeps mint and balance on the core axis and selects its Guardian twin', () => {
    expect(coreTests).toContain('mint-and-balance.spec.ts');
    expect(coreTests).not.toContain('guardian-mint-and-balance.spec.ts');
    expect(guardianTests).toContain('guardian-mint-and-balance.spec.ts');
  });

  it('keeps multi-account on the core axis and selects its Guardian twin', () => {
    expect(coreTests).toContain('multi-account.spec.ts');
    expect(coreTests).not.toContain('guardian-multi-account.spec.ts');
    expect(guardianTests).toContain('guardian-multi-account.spec.ts');
  });
});

describe('Guardian account journey invariants', () => {
  const configurableGuardianAxis = guardianAxis as ConfigurableGuardianAxis;

  it('waits through delayed endpoint hydration after Guardian creation', async () => {
    const order: string[] = [];
    const wallet = {
      createGuardianWallet: jest.fn(async () => {
        order.push('create');
        return { address: 'mdev1guardian', seedPhrase: [] };
      }),
      currentGuardianEndpoint: jest.fn(async () => {
        order.push('endpoint');
        return order.filter(event => event === 'endpoint').length === 1 ? '' : guardianUrl;
      })
    };

    await expect(
      configurableGuardianAxis(guardianUrl, { endpointTimeoutMs: 250 }).create(wallet as never)
    ).resolves.toEqual(expect.objectContaining({ address: 'mdev1guardian' }));
    expect(order).toEqual(['create', 'endpoint', 'endpoint']);
  });

  it('rejects a stable Guardian endpoint mismatch', async () => {
    const wallet = {
      createGuardianWallet: jest.fn().mockResolvedValue({ address: 'mdev1guardian', seedPhrase: [] }),
      currentGuardianEndpoint: jest.fn().mockResolvedValue('http://wrong.test:3000')
    };

    await expect(
      configurableGuardianAxis(guardianUrl, { endpointTimeoutMs: 10 }).create(wallet as never)
    ).rejects.toThrow();
  });

  it('creates, selects, funds, and rechecks two Guardian accounts in one wallet', async () => {
    const firstAddress = 'mdev1first';
    const secondAddress = 'mdev1second';
    const page = {
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({ textContent: jest.fn().mockResolvedValue('') })
    };
    const walletA = {
      page,
      extensionId: 'wallet-a',
      navigateTo: jest.fn().mockResolvedValue(undefined),
      triggerSync: jest.fn().mockResolvedValue(undefined),
      createAdditionalAccount: jest.fn().mockResolvedValue({ address: secondAddress }),
      selectAccount: jest.fn().mockResolvedValue(undefined)
    };
    const assertCurrentAccount = jest.fn().mockResolvedValue(undefined);
    const axis = {
      label: 'guardian',
      walletType: 'guardian',
      create: jest.fn(async (wallet: unknown) => {
        await assertCurrentAccount(wallet);
        return { address: firstAddress };
      }),
      assertCurrentAccount
    };
    const midenCli = {
      init: jest.fn().mockResolvedValue(undefined),
      createFaucet: jest.fn().mockResolvedValue('faucet'),
      mint: jest.fn().mockResolvedValue({ txId: 'tx', noteId: 'note' }),
      sync: jest.fn().mockResolvedValue(undefined)
    };
    const steps = { step: jest.fn(async (_name: string, action: () => Promise<void>) => action()) };
    const timeline = { emit: jest.fn() };

    await runMultiAccountJourney({ walletA, midenCli, steps, timeline, axis } as never);

    expect(axis.create).toHaveBeenCalledTimes(1);
    expect(walletA.createAdditionalAccount).toHaveBeenCalledWith('guardian');
    expect(walletA.selectAccount.mock.calls.map(call => call[0])).toEqual([secondAddress, firstAddress, secondAddress]);
    expect(assertCurrentAccount).toHaveBeenCalledTimes(4);
    expect(midenCli.mint.mock.calls.map(call => [call[1], call[2]])).toEqual([
      [firstAddress, 100_000_000_000],
      [secondAddress, 200_000_000_000]
    ]);
    expect(jest.mocked(waitForPendingNoteTotal).mock.calls.map(call => call[2])).toEqual([
      100_000_000_000n,
      200_000_000_000n,
      100_000_000_000n,
      200_000_000_000n
    ]);
  });
});

describe('earn workflow Guardian lifecycle', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/pr-e2e-earn.yml'), 'utf8');

  it('owns service startup, readiness, failure logs, and teardown in named steps', () => {
    expect(() => assertEarnGuardianLifecycle(workflow)).not.toThrow();
  });

  it.each([
    ['Dump stack logs on failure', 'failure()', 'success()'],
    ['Tear down', 'always()', 'success()']
  ])('rejects a sibling condition when the %s condition is changed', (name, condition, replacement) => {
    const mutated = replaceStep(workflow, name, step => step.replace(`if: ${condition}`, `if: ${replacement}`));
    expect(() => assertEarnGuardianLifecycle(mutated)).toThrow();
  });

  it('rejects Guardian readiness moved after the Earn specs', () => {
    const wait = stepBlock(workflow, 'Wait for guardian');
    const run = stepBlock(workflow, 'Run earn specs');
    const mutated = workflow.replace(wait, '').replace(run, `${run}\n${wait}`);
    expect(() => assertEarnGuardianLifecycle(mutated)).toThrow();
  });
});
