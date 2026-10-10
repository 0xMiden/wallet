# Independent Review — Hosted Android virtualization workaround

### Medium

1. [Expert, fixed] Include the host operating system and architecture in this Cargo cache namespace because the cached `~/.cargo/bin` contains compiled host-specific binaries.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:125-136
   namespace=miden-e2e-cargo-v3-${{ runner.os }}-${{ runner.arch }}
   ```

2. [Expert, fixed] Gate Cargo target-cache saving on an explicit safe-to-cache result so a target directory is not snapshotted while a timed-out compiler process may still be writing to it.

   ```yaml
   # .github/actions/install-miden-client-cli/action.yml:446-460
   if: steps.pins.outputs.stable_kernel == '1' && steps.stable_cli_install.outcome != 'skipped' && steps.stable_cli_install.outputs.safe-to-cache == 'true'
   ```

3. [Expert, addressed] Pass `-f platform=android` when dispatching this combined workflow; its manual default is iOS and otherwise the Android job is skipped.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:31-44,299-302
   default: ios
   if: github.event_name == 'workflow_dispatch' && inputs.platform == 'android'
   ```

### Low

4. [Expert, fixed] Route source checkout and Cargo preparation through the process-tree-aware timeout runner so timed-out setup commands cannot race source cleanup.

   ```js
   // scripts/install-pinned-miden-cli.cjs:82-98,316-329
   await run('cargo', ['update', '--workspace'], { cwd: source, stdio: 'inherit', timeoutMs: 180_000 });
   ```

5. [Expert, fixed] Name Hypervisor.framework as the acceleration layer for this macOS runner so the setup comment points maintainers to the correct VM backend.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:56-57
   # Hypervisor.framework is what makes the emulator usable rather than
   # merely present on this macOS runner. Without it, the boot fails or stalls.
   ```
