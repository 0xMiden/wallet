import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const playwright = resolve(repoRoot, 'node_modules/.bin/playwright');

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

describe('earn workflow Guardian lifecycle', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/pr-e2e-earn.yml'), 'utf8');

  it('starts the Guardian and its database through the Guardian profile', () => {
    expect(workflow).toMatch(/--profile\s+guardian\s+up\s+-d\s+guardian\s+guardian-postgres/);
  });

  it('waits for an HTTP response from the Guardian before running specs', () => {
    expect(workflow).toMatch(/curl[^\n]+http:\/\/127\.0\.0\.1:3000\//);
  });

  it('captures Guardian logs on failure and removes Guardian state during teardown', () => {
    expect(workflow).toMatch(/if:\s+failure\(\)[\s\S]+--profile\s+guardian[^\n]+logs\s+--no-color/);
    expect(workflow).toMatch(/if:\s+always\(\)[\s\S]+--profile\s+guardian[^\n]+down\s+-v/);
  });

  it('does not claim that earn transactions need no co-signing', () => {
    expect(workflow).not.toContain('earn needs no co-signing');
  });
});
