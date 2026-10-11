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
