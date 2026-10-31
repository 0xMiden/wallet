import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../../..');

function lockedVersion(file: string, pattern: RegExp): string {
  const match = fs.readFileSync(path.join(ROOT, file), 'utf8').match(pattern);
  if (!match?.[1]) throw new Error(`no locked version in ${file}`);
  return match[1];
}

const majorMinor = (version: string) => version.split('.').slice(0, 2).join('.');

// `tauri build` refuses to bundle when the crate and the npm package differ in major or minor version
// ("Found version mismatched Tauri packages"), and only the release workflow runs it, so a lockfile bump
// that moves one side alone would otherwise first fail while a release is publishing its desktop apps.
it('locks the tauri crate and @tauri-apps/api on the same major and minor version', () => {
  const crate = lockedVersion('src-tauri/Cargo.lock', /\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/);
  const npm = lockedVersion('yarn.lock', /^"?@tauri-apps\/api@[^\n]*:\n {2}version "([^"]+)"/m);
  expect({ npm: majorMinor(npm) }).toEqual({ npm: majorMinor(crate) });
});
