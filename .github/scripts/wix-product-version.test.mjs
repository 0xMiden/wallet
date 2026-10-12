import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWixProductVersion, wixProductVersion } from './wix-product-version.mjs';

test('an rc.N prerelease becomes the WiX build field', () => {
  assert.equal(wixProductVersion('1.17.0-rc.0'), '1.17.0.0');
  assert.equal(wixProductVersion('1.17.0-rc.12'), '1.17.0.12');
});

test('a stable version is left for Tauri to derive', () => {
  assert.equal(wixProductVersion('1.17.0'), null);
});

test('anything else is refused', () => {
  assert.throws(() => wixProductVersion('1.17.0-alpha'), /No WiX product version/);
  assert.throws(() => wixProductVersion('1.17.0-rc.65536'), /65535/);
});

test('the app version stays, and an existing windows key stays', () => {
  const input = `${JSON.stringify(
    {
      version: '1.17.0-rc.0',
      bundle: { windows: { webviewInstallMode: { type: 'downloadBootstrapper' } } }
    },
    null,
    2
  )}\n`;
  const out = JSON.parse(applyWixProductVersion(input, '1.17.0-rc.0'));
  assert.equal(out.version, '1.17.0-rc.0');
  assert.equal(out.bundle.windows.wix.version, '1.17.0.0');
  assert.equal(out.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
});
