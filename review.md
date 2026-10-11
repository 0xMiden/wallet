# Independent Review — Android Bridge-IN startup

### High

1. [Expert, fixed] Compare the prepared artifact's repository ID to `GITHUB_REPOSITORY_ID`; the GitHub Script `context` has no `repoId` property, which rejected every preparation artifact.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:720-724
   artifact.workflow_run?.head_repository_id === Number(process.env.GITHUB_REPOSITORY_ID)
   ```

2. [Expert, fixed] Bound Android host checks, VM acceleration, and AVD creation, then check the dispatch deadline after each stage so a stuck command cannot consume the live startup budget without a prompt failure.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:879-935
   - name: Create base AVD
     timeout-minutes: 1
     ...
   - name: Check dispatch-based first-loop deadline
     ... avd_creation
   ```

### Medium

3. [Expert, fixed] Include host operating system and architecture in the Rust Cargo cache namespace because it contains compiled host-specific binaries.

   ```yaml
   # .github/actions/install-miden-client-cli/action.yml:124-125
   cache_key=miden-client-cli-${{ runner.os }}-${{ runner.arch }}-...
   build_cache_prefix=miden-client-target-${{ runner.os }}-${{ runner.arch }}-...
   ```

4. [Expert, fixed] Save Cargo target artifacts only after the installer confirms the timed-out build process is stopped safely.

   ```yaml
   # .github/actions/install-miden-client-cli/action.yml:446-460
   steps.stable_cli_install.outputs.safe-to-cache == 'true'
   ```

5. [Expert, addressed] Dispatch the Android job with `platform=android`; the combined workflow retains iOS as its default input.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:35-40,559-566
   default: ios
   if: github.event_name == 'workflow_dispatch' && inputs.platform == 'android'
   ```

6. [Expert, fixed] Run the x86_64 AVD on the 12-core Intel macOS larger runner and fail before boot if fewer than six host CPUs are available.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:566,879-887
   runs-on: macos-26-large
   if ... host_cores < 6; then exit 1; fi
   ```

7. [Expert, fixed] Relay workflow cancellation to the detached Playwright process group, then escalate if it does not exit.

   ```js
   // scripts/run-android-bridge-in-with-startup-deadline.cjs:141-165
   process.on('SIGINT', handleTermination);
   process.on('SIGTERM', handleTermination);
   ```

8. [Expert, fixed] Write a structured startup result on every ordinary setup exit, including failures before the Playwright watchdog begins.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:965-1024
   if: always()
   uses: actions/github-script@v7
   ```

9. [Expert, fixed] Do not issue recipient fee grants when WalletConnect setup fails; start the grant only after connection succeeds, overlap it with the first deposit, and wait before solver delivery.

   ```ts
   // playwright/e2e/android/tests/bridge-in-deposit.android.spec.ts:363-379,493-510
   await connectResult;
   recipientFeeReserve = ...;
   // await before Miden delivery
   ```

10. [Expert, fixed] Fail the workflow if Playwright exits successfully without recording loop 1; a green test command must not imply that any loop ran.

   ```js
   // scripts/run-android-bridge-in-with-startup-deadline.cjs:246
   process.exitCode = exceededDeadline || !firstLoop ? 1 : code ?? 1;
   ```

11. [Runtime findings, addressed and independently reviewed] Expose the hosted Android SDK tools on `PATH` in every job that invokes them. Preparation run `38111623729` failed at `command -v sdkmanager`; run `38112184176` then showed the redundant license pipeline failed under `pipefail`, so it was removed because setup-android already accepts those licenses. The successful prep run `38112626286` exposed a cross-job boundary: its PATH setup did not carry over to live run `38113670228`, which failed at `command -v sdkmanager` before emulator startup. Add setup-android to the live runner before this check. Key the system-image cache by OS, architecture, and image package, not the full workflow file, so unrelated edits do not invalidate it.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:160-213, 893-913
   - uses: android-actions/setup-android@v3
     with:
       packages: platform-tools
   - uses: actions/cache/save@v4
   sdkmanager --install "system-images;android-34;default;x86_64"
   ```

12. [Expert, addressed after independent review] Bind the API 34 image and pinned emulator to the preparation provenance and live restore. A shared cache key made the image fallback capable of restoring stale emulator package metadata. Keep the large image fallback separate, preserve the clean hosted package.xml before any legacy restore, and require a dedicated exact-version emulator cache in the live job.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:180-202, 281-304, 881-885, 961-993
   key: bridge-in-android-system-image-v1-${{ runner.os }}-${{ runner.arch }}-android-34-default-x86_64
   key: bridge-in-android-emulator-v1-${{ runner.os }}-${{ runner.arch }}-37.2.12-build-16428233
   ```

13. [Expert, addressed and independently reviewed with no findings] Resolve repository artifact paths from `GITHUB_WORKSPACE` when CI loads the emulator helper through `node -e`. In that eval context, `__dirname` is the checkout working directory, so walking four levels upward placed emulator logs at `/Users/test-results-android/emulator-logs` and failed before boot. Keep the module-relative fallback for direct local execution.

   ```ts
   // playwright/e2e/android/helpers/emulator-control.ts:47-54
   const ROOT_DIR = process.env.GITHUB_WORKSPACE
     ? path.resolve(process.env.GITHUB_WORKSPACE)
     : path.resolve(__dirname, '../../../..');
   ```

14. [Expert, package.xml/cache correction independently re-reviewed with no blockers; hosted validation pending] Do not use the macOS image's preinstalled Android emulator in the live job. Run `38116228586` used image version `37.1.11.0`, which stalled its QEMU threads before ADB became available. The first repair requested the unversioned SDK Manager `emulator` package and only failed closed on version drift; independent review correctly found that this did not fetch the selected build. Download official macOS Intel archive build `16428233`, verify its published SHA-256, set the SDK package revision to `37.2.12`, and bind the version, build, checksum, and cache keys into exact-SHA APK provenance. Live run `38117915382` then showed that ElementTree serialization of the host `package.xml` made it invalid to Android SDK tools: `avdmanager` reported `emulator` was not installed, and no loop started. The revision edit now preserves the existing XML serialization. A second independent review caught that an old combined cache fallback could still restore the invalid XML, so preserve the clean runner package metadata before cache restoration, reinstall from that clean copy on emulator-cache miss, and separate the large image fallback from the exact emulator cache. Independent review confirms that this cache boundary and both prep/live provenance checks now prevent the stale metadata from being republished.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:47-50, 180-302, 313-347, 877-887, 925-939, 964-983, 1017-1043
   ANDROID_EMULATOR_VERSION: '37.2.12'
   ANDROID_EMULATOR_ARCHIVE_BUILD: '16428233'
   echo "$ANDROID_EMULATOR_ARCHIVE_SHA256  $archive" | shasum -a 256 --check
   key: bridge-in-android-system-image-v1-${{ runner.os }}-${{ runner.arch }}-android-34-default-x86_64
   key: bridge-in-android-emulator-v1-${{ runner.os }}-${{ runner.arch }}-37.2.12-build-16428233
   ```

### Low

15. [Expert, fixed] Run checkout and Cargo preparation through the process-tree-aware timeout helper so timed-out commands cannot race source cleanup.

   ```js
   // scripts/install-pinned-miden-cli.cjs:91-97,318-324
   timeoutMs: 180_000
   ```

16. [Expert, fixed] Name Hypervisor.framework as the macOS acceleration layer in the runner guidance.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:909-917
   # Prove the selected runner exposes Hypervisor.framework before emulator boot.
   ```

17. [Independent review, P3 fixed] Keep the wrong-architecture diagnostic aligned with the selected live runner label after moving Android startup to macOS 15.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:1025
   echo "::error::macos-15-large must provide an x86_64 host for the Android image"
   ```

## Independent re-review — warm AVD startup

### High

18. [Expert, fixed] Require guest-memory proof on every restore. A named snapshot present in the cache and a `-snapshot` process argument prove availability and request, not that the live guest loaded it. Save an unpredictable `debug.*` property inside the guest before snapshot creation, verify it on both preparation restores and the live runner, and stop if it is absent.

   ```js
   // scripts/android-warm-avd.cjs:171-194
   await adbRun(['-s', SERIAL, 'shell', 'setprop', SNAPSHOT_PROOF_PROPERTY, snapshotProof]);
   await assertSnapshotProof(snapshotProof);
   ```

   ```ts
   // playwright/e2e/android/helpers/emulator-control.ts:36-51, 870-884
   return launchedAt + WARM_AVD_STARTUP_TIMEOUT_MS;
   await assertWarmAvdSnapshotProof(serial, startupDeadlineAt);
   ```

19. [Expert, fixed] Anchor the 45-second warm-start allowance to the launch receipt and carry its remaining duration through reservation, device discovery, AVD checks, boot completion, boot-animation and Play Services polling, and each subprocess timeout. `ensureBooted()` previously retained a separate 300-second budget after reservation returned an online device.

   ```ts
   // playwright/e2e/android/helpers/emulator-control.ts:220-231, 254-297, 700-779
   const startupDeadlineAt = warmAvdStartupDeadline(serial, BASE_AVD);
   const deadlineAt = startupDeadlineAt ?? start + BOOT_TIMEOUT_MS;
   ```

20. [Expert, fixed] Use hardware graphics for the warm snapshot and disable Vulkan. Android documents snapshots as unreliable with software rendering; require the matching `host`/Vulkan-disabled profile in both preparation and live process checks.

   ```js
   // scripts/android-emulator-launch.cjs:10-29
   '-gpu', BRIDGE_IN_GPU,
   '-feature', '-Vulkan',
   ```

### Medium

21. [Expert, fixed] Hash the installed APK on the guest with a 30-second limit instead of copying the full APK over ADB on the five-minute startup path.

   ```ts
   // playwright/e2e/android/helpers/emulator-control.ts:362-370
   ['-s', serial, 'shell', 'sha256sum', installedPaths[0]!],
   ADB_APK_HASH_TIMEOUT_MS
   ```

22. [Expert, resolved by existing first-run assertion] `pm clear` preserves package installation history, but the route requires clean wallet data and explicitly drives first-run onboarding. Keep the onboarding welcome selector as the precondition to `createNewWallet()` so the warm-installed package cannot silently reuse a wallet.

   ```ts
   // playwright/e2e/android/helpers/android-wallet-page.ts:247-251
   await this.pollForSelector('[data-testid="onboarding-welcome"]', 30_000);
   ```

23. [Hosted prep test, fixed] The APK mismatch test's fake `sha256sum` output and expected hash were both 64 zeroes, so it described a matching installed APK and Jest correctly resolved the promise. Make the expected hash differ from the mocked digest.

   ```ts
   // playwright/e2e/android/helpers/emulator-control.test.ts:261-262
   await expect(new EmulatorControl().assertInstalledApkSha256(SERIAL, PACKAGE, '1'.repeat(64)))
     .rejects.toThrow(/SHA-256 mismatch/);
   ```

24. [Independent review, fixed] A cold warm-AVD boot failure skipped the later success-only APK artifact upload, so its emulator process log was lost and the timeout could not distinguish host QEMU, guest initialization, or ADB failure. Capture bounded process/ADB/log-tail details before cleanup and upload prep diagnostics with `if: always()`.

   ```js
   // scripts/android-warm-avd.cjs:71-87,149-183,234-260
   await captureWarmAvdFailure('cold boot and snapshot creation', coldBoot.pid, error);
   ```

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:319-329
   - name: Upload warm AVD preparation diagnostics
     if: always()
   ```

25. [Independent review, fixed] Preserve the original boot or snapshot error when diagnostic writing or emulator shutdown also fails. Report those secondary failures on the original exception; surface cleanup as the primary failure only when preparation itself succeeded.

   ```js
   // scripts/android-warm-avd.cjs:185-200,246-260,273-287
   if (primaryError) reportSecondaryFailure(primaryError, 'Warm AVD cleanup failed', cleanupError);
   else throw cleanupError;
   ```

26. [Independent review, fixed] Fail promptly if the emulator launcher process exits before ADB becomes ready. The prep watcher previously waited the full four-minute boot budget even though the recorded PID was already gone; include the exit code/signal and retain the emulator's known crash database when present.

   ```js
   // scripts/android-warm-avd.cjs:75-108,200-205
   if (processExit) throw new Error(`Visible ${AVD_NAME} stopped before ADB boot readiness: ${processExit}.`);
   ```

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:319-339
   crash_database="/tmp/android-runner/emu-crash-${ANDROID_EMULATOR_VERSION}.db"
   ```

27. [Independent review, fixed] Make the preparation's intended cold boot explicit with `-no-snapshot-load`. The prior launch omitted snapshot flags and the exact log shows a lookup for the absent `default_boot` snapshot; skip that lookup while keeping explicit snapshot saving available. The warning was not established as the process-exit cause.

   ```js
   // scripts/android-emulator-launch.cjs:36-41
   } else if (snapshotName === null) {
     args.push('-no-snapshot-load');
   }
   ```

### Low

28. [Independent review, fixed] Bound emulator-log collection by reading at most 128 KiB before retaining the last 250 non-empty lines; do not load and split an arbitrarily large process log during failure handling.

   ```js
   // scripts/android-warm-avd.cjs:193-199
   const { stdout } = await run('tail', ['-c', '131072', preparationLogPath()], 5_000);
   ```

29. [Expert, deferred P2] This final candidate supersedes item 20's hardware-renderer recommendation with an explicit software-renderer trial. Keep the cold-boot, snapshot-save, and two named-restore checks as hard pre-dispatch gates. Add a rendered-frame assertion during both restores before publishing the manifest so the gate proves the software renderer produced a usable image as well as a booted guest and restored proof.

   ```js
   // scripts/android-warm-avd.cjs:331-340
   await assertInstalledApk(apkPath, apkSha256);
   await assertSnapshotProof(snapshotProof);
   restoreMs.push(elapsedMs);
   ```
