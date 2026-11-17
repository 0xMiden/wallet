import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const platform of ['android', 'ios']) {
  for (const fail of [false, true]) {
    test(`${platform}: locked build ${fail ? 'failure preserves committed libraries' : 'publishes both fresh slices'}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-test-'));
      try {
        const plugin = path.join(root, 'packages/native-prover');
        fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
        fs.copyFileSync(new URL(`./build-${platform}.sh`, import.meta.url), path.join(plugin, `scripts/build-${platform}.sh`));
        fs.mkdirSync(path.join(plugin, 'android/rust-bridge'), { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@miden-sdk/miden-sdk': '0.18.0' } }));
        const web = path.join(root, 'web');
        fs.mkdirSync(path.join(web, 'crates/mobile-prover'), { recursive: true });
        fs.writeFileSync(path.join(web, 'crates/mobile-prover/Cargo.toml'), '');
        fs.writeFileSync(path.join(web, 'Cargo.toml'), 'version = "0.18.0"\n');
        const outputs = platform === 'android'
          ? ['arm64-v8a', 'x86_64'].map(abi => path.join(plugin, `android/src/main/jniLibs/${abi}/libmiden_native_prover_jni.so`))
          : ['ios-arm64', 'ios-arm64-simulator'].map(slice => path.join(plugin, `ios/MidenMobileProver.xcframework/${slice}/libmiden_mobile_prover.a`));
        for (const output of outputs) {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, 'old');
        }
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        const executable = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
        executable('cargo-ndk', 'exit 0');
        executable('nm', 'echo _miden_prove_transaction');
        executable('cargo', `
if [[ "$*" == metadata* ]]; then echo '{"target_directory":"${web}/target"}'; exit 0; fi
[[ " $* " == *" --locked "* ]] || { echo 'missing --locked' >&2; exit 42; }
if [[ "$1" == ndk ]]; then
  while [[ "$1" != -o ]]; do shift; done
  out="$2"
  ${fail ? 'exit 0' : 'for abi in arm64-v8a x86_64; do mkdir -p "$out/$abi"; echo fresh > "$out/$abi/libmiden_native_prover_jni.so"; done'}
else
  target="\${!#}"
  ${fail ? '[[ "$target" != aarch64-apple-ios-sim ]] || exit 1' : ':'}
  mkdir -p "${web}/target/$target/release"
  echo fresh > "${web}/target/$target/release/libmiden_mobile_prover.a"
fi`);
        const result = spawnSync('bash', [path.join(plugin, `scripts/build-${platform}.sh`), web], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANDROID_NDK_HOME: root }, encoding: 'utf8'
        });
        if (fail) assert.notEqual(result.status, 0, result.stdout + result.stderr);
        else assert.equal(result.status, 0, result.stdout + result.stderr);
        for (const output of outputs) assert.equal(fs.readFileSync(output, 'utf8').trim(), fail ? 'old' : 'fresh');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
