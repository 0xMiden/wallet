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
  // A base filter here skipped every stacked PR's gates while the command checks above stayed green.
  it.each(['pr.yml', 'pr-compile-surfaces.yml'])('%s runs on a pull request to any base', file => {
    const trigger = workflow(file).match(/^ {2}pull_request:\n((?: {4}.*\n)*)/m);
    expect(trigger).not.toBeNull();
    expect(trigger?.[1]).not.toMatch(/^ {4}branches(-ignore)?:/m);
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
