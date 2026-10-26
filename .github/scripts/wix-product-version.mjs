import { readFileSync, writeFileSync } from 'node:fs';

// WiX product versions are major.minor.patch.build, all numeric, and the build
// field tops out at 65535. Tauri 2.11 uses bundle.windows.wix.version for the
// MSI when it is set. Otherwise it derives one from the app version and rejects
// an rc.N prerelease. NSIS already drops that prerelease on its own.
// A stable X.Y.Z needs nothing here: Tauri's own derivation accepts it.

export function wixProductVersion(appVersion) {
  if (/^\d+\.\d+\.\d+$/.test(appVersion)) return null;
  const rc = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/.exec(appVersion);
  if (!rc) {
    throw new Error(`No WiX product version for app version ${appVersion}`);
  }
  const build = Number(rc[4]);
  if (!Number.isInteger(build) || build > 65535) {
    throw new Error(`rc number ${rc[4]} is outside the WiX build range 0-65535`);
  }
  return `${rc[1]}.${rc[2]}.${rc[3]}.${build}`;
}

export function applyWixProductVersion(tauriConfText, appVersion) {
  const product = wixProductVersion(appVersion);
  if (product === null) return tauriConfText;
  const conf = JSON.parse(tauriConfText);
  conf.bundle ??= {};
  conf.bundle.windows ??= {};
  conf.bundle.windows.wix ??= {};
  conf.bundle.windows.wix.version = product;
  return `${JSON.stringify(conf, null, 2)}\n`;
}

function applyWorkingTree() {
  const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const path = 'src-tauri/tauri.conf.json';
  const next = applyWixProductVersion(readFileSync(path, 'utf8'), appVersion);
  writeFileSync(path, next);
  const written = JSON.parse(next).bundle?.windows?.wix?.version ?? 'derived by Tauri';
  console.log(`WiX product version: ${written} (app ${appVersion})`);
}

if (process.argv.includes('--apply')) {
  applyWorkingTree();
}
