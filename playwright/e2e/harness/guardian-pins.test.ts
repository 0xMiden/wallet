/**
 * @jest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** The `KEY=value` assignments of an env file, comments and blank lines skipped. */
function envFile(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of read(path).split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) entries[match[1]!] = match[2]!;
  }
  return entries;
}

describe('Guardian pins', () => {
  // The local stack runs the Guardian image the client targets, and the DeltaObject.metadata patch is named for the
  // client version it applies to, so a bump that moves one of them without the others fails here.
  it('both Guardian clients, the local Guardian image and the client patch name one version', () => {
    const pkg: { dependencies: Record<string, string> } = JSON.parse(read('package.json'));
    const env = envFile('playwright/e2e/local-stack/versions.env');
    const lock = read('yarn.lock');

    const version = pkg.dependencies['@openzeppelin/miden-multisig-client'];
    expect(pkg.dependencies['@openzeppelin/guardian-client']).toBe(version);
    expect(env.GUARDIAN_IMAGE_TAG).toBe(`v${version}`);
    expect(existsSync(resolve(root, `patches/@openzeppelin+guardian-client+${version}.patch`))).toBe(true);
    expect(lock).toContain(`"@openzeppelin/miden-multisig-client@${version}":`);
  });

  it("guardian-b inherits Guardian A's image unless GUARDIAN_B_IMAGE_TAG is set", () => {
    expect(read('playwright/e2e/local-stack/docker-compose.local.yml')).toContain(
      'guardian:${GUARDIAN_B_IMAGE_TAG:-${GUARDIAN_IMAGE_TAG}}'
    );
  });

  it('the lifecycle workflow validates each image input before compose', () => {
    const workflow = read('.github/workflows/pr-e2e-guardian-lifecycle.yml');
    const start = workflow.indexOf('- name: Bring up both guardians');
    const step = workflow.slice(start, workflow.indexOf('- name: Start note-transport'));
    expect(step).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$');
    expect(step).toContain('GUARDIAN_IMAGE_TAG_INPUT: ${{ inputs.guardian_image_tag }}');
    expect(step).toContain('GUARDIAN_B_IMAGE_TAG_INPUT: ${{ inputs.guardian_b_image_tag }}');
    expect(step).not.toMatch(/run: \|[\s\S]*\$\{\{ inputs\./);
  });

  // Guardian A sits in profile `guardian` and B in `guardian-switch`; a listing under one profile hides the other's
  // image, so a cross-version run could not show which server A ran.
  it('the lifecycle workflow prints the image each Guardian resolves to', () => {
    const workflow = read('.github/workflows/pr-e2e-guardian-lifecycle.yml');
    const start = workflow.indexOf('- name: Bring up both guardians');
    const step = workflow.slice(start, workflow.indexOf('- name: Start note-transport'));
    expect(step).toContain('--profile guardian --profile guardian-switch config --format json');
    expect(step).toContain('select(.key == "guardian" or .key == "guardian-b")');
  });
});
