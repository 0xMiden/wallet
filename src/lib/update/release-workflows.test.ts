import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const workflow = (name: string) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

describe('release update manifest gates', () => {
  it.each([
    ['build-chrome.yml', '--platform chrome'],
    ['build-mobile.yml', '--platform android'],
    ['build-mobile.yml', '--platform ios'],
    ['build-desktop.yml', '--forbid-platform desktop'],
    ['release-notes.yml', 'check:update-manifest']
  ])('%s validates %s before publishing release metadata or artifacts', (file, expected) => {
    expect(workflow(file)).toContain(expected);
  });
});
