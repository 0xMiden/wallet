# Synthetic native recovery UI proof

This proof uses a fresh CI simulator or emulator and an E2E-only build. It injects a synthetic unavailable state and a rejecting recovery action into the frontend test store, then uses native screen taps and native screenshots. It does not create a wallet, delete user data, submit a transaction, authenticate, or exercise real backend recovery. Captures use the existing native screenshot helper, which immediately caps PNGs at 1800 pixels and records dimensions.

The proof is separate from real storage recovery, authentication, file sharing, and device acceptance. All setup and CI runs are disposable and use no signing credentials.
