import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { MIN_PASSWORD_LENGTH } from 'app/constants';

const PLAYWRIGHT_DIR = join(__dirname, '..', '..');
const PASSWORD_CONSTANT = /const (\w*PASSWORD) = '([^']*)'/g;
// The mobile suites type the 6-digit passcode, which has its own rules.
const PASSCODE_DIRS = ['e2e/ios/', 'e2e/android/'];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function passwordConstants() {
  return tsFiles(PLAYWRIGHT_DIR).flatMap(file => {
    const rel = relative(PLAYWRIGHT_DIR, file);
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(PASSWORD_CONSTANT)]
      .filter(([, name]) => !(name === 'DEFAULT_PASSWORD' && PASSCODE_DIRS.some(dir => rel.startsWith(dir))))
      .map(([, name, value]) => ({ where: `${rel} ${name}`, length: value.length }));
  });
}

describe('E2E fixture passwords', () => {
  it('every E2E password constant meets MIN_PASSWORD_LENGTH', () => {
    const found = passwordConstants();
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.filter(({ length }) => length < MIN_PASSWORD_LENGTH)).toEqual([]);
  });
});
