# Independent Review — Android Bridge-IN startup

### High

1. [Expert, fixed] Compare the prepared artifact's repository ID to `GITHUB_REPOSITORY_ID`; the GitHub Script `context` has no `repoId` property, which rejected every preparation artifact.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:694-700
   artifact.workflow_run?.head_repository_id === Number(process.env.GITHUB_REPOSITORY_ID)
   ```

2. [Expert, fixed] Bound Android host checks, VM acceleration, and AVD creation, then check the dispatch deadline after each stage so a stuck command cannot consume the live startup budget without a prompt failure.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:855-911
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
   # .github/workflows/e2e-bridge-in.yml:35-40,537-542
   default: ios
   if: github.event_name == 'workflow_dispatch' && inputs.platform == 'android'
   ```

6. [Expert, fixed] Run the x86_64 AVD on the 12-core Intel macOS larger runner and fail before boot if fewer than six host CPUs are available.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:542,855-863
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
   # .github/workflows/e2e-bridge-in.yml:941-1000
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

### Low

11. [Expert, fixed] Run checkout and Cargo preparation through the process-tree-aware timeout helper so timed-out commands cannot race source cleanup.

   ```js
   // scripts/install-pinned-miden-cli.cjs:91-97,318-324
   timeoutMs: 180_000
   ```

12. [Expert, fixed] Name Hypervisor.framework as the macOS acceleration layer in the runner guidance.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:885-890
   # Prove the selected runner exposes Hypervisor.framework before emulator boot.
   ```
