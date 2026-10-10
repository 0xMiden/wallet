# Independent Review — Hosted Android virtualization workaround

### Medium

1. [Expert, fixed] Include the host operating system and architecture in this Cargo cache namespace because the cached `~/.cargo/bin` contains compiled host-specific binaries.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:125-136
   namespace=miden-e2e-cargo-v3-${{ runner.os }}-${{ runner.arch }}
   ```

### Low

2. [Expert, fixed] Name Hypervisor.framework as the acceleration layer for this macOS runner so the setup comment points maintainers to the correct VM backend.

   ```yaml
   # .github/workflows/e2e-bridge-in.yml:56-57
   # Hypervisor.framework is what makes the emulator usable rather than
   # merely present on this macOS runner. Without it, the boot fails or stalls.
   ```
