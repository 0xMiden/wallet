import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every workflow that stands up the hermetic localnet must start the node through
 * `.github/actions/run-local-node`, and must never bring it up from
 * `docker-compose.local.yml`.
 *
 * On 0.16 the node, prover and note-transport moved OUT of that compose file —
 * everything left in it is profile-gated guardian services (see its header). A
 * workflow still running `docker compose … up --wait` with no `--profile` selects
 * nothing, starts nothing, and then fails its `127.0.0.1:57291` probe: the suite
 * never executes a single spec, and the only signal is a red job. `e2e-resilience`
 * (push to main + nightly) and `e2e-stress` (the nightly balance-conservation
 * anchor) were both missed when the five per-PR workflows were converted; this
 * makes the next miss fail here instead of in CI.
 */
const workflowsDir = resolve(__dirname, '../../../.github/workflows');

const read = (file: string) => readFileSync(resolve(workflowsDir, file), 'utf8');

/** Workflows that run against the localnet stack, i.e. the ones that need a node. */
const localnetWorkflows = readdirSync(workflowsDir)
  .filter(file => file.endsWith('.yml'))
  .filter(file => read(file).includes('E2E_NETWORK: localhost'));

/** Shell line continuations joined, so a wrapped `docker compose … \` reads as one command. */
const commands = (yaml: string) =>
  yaml
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter(line => line.includes('docker compose') && / up\b/.test(line));

describe('localnet workflows start the node the way the 0.16 stack requires', () => {
  it('finds the localnet workflows (a rename must not silently empty this suite)', () => {
    expect(localnetWorkflows).toEqual(expect.arrayContaining(['e2e-resilience.yml', 'e2e-stress.yml']));
  });

  it.each(localnetWorkflows)('%s starts the node via the run-local-node action', file => {
    expect(read(file)).toContain('uses: ./.github/actions/run-local-node');
  });

  it.each(localnetWorkflows)('%s only ever brings compose up behind a --profile', file => {
    // The compose file's only remaining services are the guardians, both
    // profile-gated; a profile-less `up` is the dead node bring-up.
    for (const command of commands(read(file))) {
      expect(command).toContain('--profile');
    }
  });
});
