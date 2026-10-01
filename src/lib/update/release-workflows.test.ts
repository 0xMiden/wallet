import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const workflow = (name: string) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

describe('native logic test gates', () => {
  // A test no gate runs cannot fail, on either platform.
  it.each([
    ['android', 'testDebugUnitTest'],
    ['ios', '-only-testing:AppTests']
  ])('runs the %s logic tests on every pull request', (_platform, command) => {
    expect(workflow('pr-compile-surfaces.yml')).toContain(command);
  });
});

describe('pull request gate triggers', () => {
  // A base filter on any of these skipped every stacked PR's gates while the command checks above stayed green.
  const gates = fs
    .readdirSync(path.join(ROOT, '.github/workflows'))
    .filter(file => /\.ya?ml$/.test(file) && /^ {2}pull_request:/m.test(workflow(file)));

  it('finds the pull request gates', () => {
    expect(gates).toEqual(expect.arrayContaining(['pr.yml', 'pr-compile-surfaces.yml']));
  });

  it.each(gates)('%s runs on a pull request to any base', file => {
    // The trigger line and everything under it up to the next two-space key, blank and comment lines included.
    const trigger = workflow(file).match(/^ {2}pull_request:.*\n(?:(?: {4}.*|[ \t]*#.*|[ \t]*)\n)*/m);
    expect(trigger?.[0]).not.toMatch(/branches(-ignore)?:/);
  });
});

describe('release update manifest gates', () => {
  it('validates the catalog on every pull request, where a failure is actionable', () => {
    expect(workflow('pr.yml')).toContain('check:update-manifest');
  });

  it.each(['build-chrome.yml', 'build-mobile.yml', 'build-desktop.yml', 'release-notes.yml'])(
    'never blocks the %s release path on presentation metadata',
    file => {
      // Availability comes from the store, and a missing entry only costs the
      // card its summary, so nothing on the release path may fail for want of
      // one. The catalog is validated on every pull request instead, by
      // scripts/validate-update-manifest.test.ts.
      expect(workflow(file)).not.toContain('check:update-manifest');
    }
  );
});
