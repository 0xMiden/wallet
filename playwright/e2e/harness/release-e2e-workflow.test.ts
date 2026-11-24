/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The release E2E jobs run nightly and on demand instead of on every push (#1714). These pin the dispatch lists to
// the suites, and keep a push trigger from coming back on any E2E workflow.
const DIR = resolve(__dirname, '../../../.github/workflows');
const read = (file: string): string => readFileSync(resolve(DIR, file), 'utf8');
const README = readFileSync(resolve(__dirname, '../../../README.md'), 'utf8');

/** The top-level `on:` block, as its lines. */
const onBlock = (text: string): string[] => {
  const lines = text.split('\n');
  const at = lines.indexOf('on:');
  if (at === -1) throw new Error('no top-level on:');
  const end = lines.findIndex((line, i) => i > at && line !== '' && !line.startsWith(' '));
  return lines.slice(at + 1, end).filter(line => !line.trim().startsWith('#'));
};

/** The `workflow_dispatch` input names of a workflow, read from its `on:` block. */
const dispatchInputs = (text: string): string[] => {
  const block = onBlock(text);
  const at = block.findIndex(line => /^ {2}workflow_dispatch:/.test(line));
  if (at === -1) return [];
  const inputs: string[] = [];
  for (const line of block.slice(at + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const name = /^ {6}(\w+):\s*$/.exec(line)?.[1];
    if (name !== undefined) inputs.push(name);
  }
  return inputs;
};

const RELEASE = read('release-e2e.yml');
const SUITES = /<<'SUITES'\n([\s\S]*?)\n\s*SUITES\n/.exec(RELEASE)?.[1] ?? '';
const listed = SUITES.split('\n')
  .map(line => line.trim())
  .filter(Boolean);

const RELEASE_SUITES = [
  'e2e-android.yml',
  'e2e-blockchain.yml',
  'e2e-bridge.yml',
  'e2e-bridge-in.yml',
  'e2e-dapp.yml',
  'e2e-dapp-browser.yml',
  'e2e-resilience.yml',
  'e2e-telemetry.yml',
  'e2e-upgrade.yml',
  'e2e-usdcx.yml',
  'e2e-usdcx-live.yml',
  'pr-e2e-bridge-guardian.yml',
  'pr-e2e-earn.yml',
  'pr-e2e-guardian-lifecycle.yml',
  'pr-e2e-swap.yml'
];

describe('Release E2E', () => {
  it('runs nightly, by dispatch on a ref that defaults to main, and when a release is published', () => {
    const on = onBlock(RELEASE).join('\n');
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '13 2 \* \* \*'$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}ref:\n[\s\S]*?^ {8}default: main$/m);
    expect(on).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(on).not.toMatch(/^ {2}(push|pull_request\w*):/m);
    expect(RELEASE).toContain("REF: ${{ github.event.release.tag_name || inputs.ref || 'main' }}");
  });

  it('dispatches each of the fifteen release suites once, on the ref, and fails naming one it could not start', () => {
    expect(listed.map(line => line.split(' ')[0])).toEqual(RELEASE_SUITES);
    expect(RELEASE).toContain('gh workflow run "$file" --repo "$GITHUB_REPOSITORY" --ref "$REF" $args');
    expect(RELEASE).toMatch(/::error title=Release E2E::could not dispatch \$\{file\} on \$\{REF\}/);
    expect(RELEASE).toMatch(/if \[ "\$\{#failed\[@\]\}" -gt 0 \]; then[\s\S]*?exit 1/);
  });

  it('passes testnet to every suite that takes a network, and only inputs the suite declares', () => {
    for (const line of listed) {
      const [file = '', ...args] = line.split(' ');
      const flags = args.join(' ').match(/-f (\w+)=(\S+)/g) ?? [];
      const declared = dispatchInputs(read(file));
      expect(onBlock(read(file)).some(l => /^ {2}workflow_dispatch:/.test(l))).toBe(true);
      for (const flag of flags) expect(declared).toContain(/-f (\w+)=/.exec(flag)?.[1]);
      const networkFlags = flags.filter(flag => flag.startsWith('-f network='));
      const expectedNetworkFlags = declared.includes('network') ? ['-f network=testnet'] : [];
      expect(networkFlags).toEqual(expectedNetworkFlags);
    }
  });

  it('starts automatically for a full release only, and says a release candidate is tested by hand', () => {
    expect(RELEASE).toContain("if: github.event_name != 'release' || github.event.release.prerelease == false");
    expect(README).toMatch(/release candidate[^.]*by hand/);
  });

  it('names a commit as the one tested only for a tag; for a branch, the head at dispatch', () => {
    expect(RELEASE).toContain('gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${REF}"');
    expect(RELEASE).toMatch(/Release E2E on tag \\`\$\{REF\}\\` \(\$\{sha:0:9\}\)/);
    expect(RELEASE).toMatch(/Release E2E on branch \\`\$\{REF\}\\`, head \$\{sha:0:9\} at dispatch/);
    expect(RELEASE).toContain('echo "Each suite\'s own run records the commit it tested."');
    expect(README).not.toContain('records that commit');
  });

  it('leaves to their own nightly crons, on schedule only, the two suites that have one', () => {
    expect(RELEASE).toMatch(
      /if \[ "\$EVENT" = schedule \]; then\n\s+case "\$file" in\n\s+e2e-resilience\.yml \| e2e-usdcx-live\.yml\)/
    );
    const crons = RELEASE_SUITES.filter(file => onBlock(read(file)).some(line => /^ {2}schedule:/.test(line)));
    expect(crons).toEqual(['e2e-resilience.yml', 'e2e-usdcx-live.yml']);
  });
});

describe('Next E2E (devnet)', () => {
  const NEXT = read('next-e2e-devnet.yml');

  it('runs nightly and by dispatch, and dispatches the e2e-blockchain.yml on next, on devnet', () => {
    const on = onBlock(NEXT).join('\n');
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '31 1 \* \* \*'$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(on).not.toMatch(/^ {2}(push|pull_request\w*|release):/m);
    expect(NEXT).toContain(
      'gh workflow run e2e-blockchain.yml --repo "$GITHUB_REPOSITORY" --ref next -f network=devnet'
    );
    expect(NEXT).toMatch(/started on \\`next\\`, head \$\{sha:0:9\} at dispatch/);
    expect(NEXT).toContain('echo "The suite\'s own run records the commit it tested."');
  });
});

describe('E2E workflows', () => {
  it('only the Guardian lifecycle suite runs on a push, and only on main: the release suites run from Release E2E, the rest by pull request, dispatch or cron', () => {
    const pushed = readdirSync(DIR)
      .filter(file => /^(pr-)?e2e-.*\.yml$/.test(file))
      .filter(file => onBlock(read(file)).some(line => /^ {2}push:/.test(line)));
    expect(pushed).toEqual(['pr-e2e-guardian-lifecycle.yml']);
  });
});
