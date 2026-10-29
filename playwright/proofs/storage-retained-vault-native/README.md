# Retained Vault native loss proof

This CI-only fixture uses the actual normal wallet client, Vault, Passworder, storage provider and recovery path. It does not replace the SDK or Vault. Both cases run ST/main, one browser worker, no retries, 240 seconds per case, on a fresh disposable origin.

The pre-loss setup derives from the accepted authenticated-note fixture. It creates an actual guarded private account and private note using MockChain, verifies canonical authentication and Merkle inclusion, and exports a bounded initial SDK store image. This image is used only before establishing the wallet recovery journal. No SDK image, account or chain state is installed after loss.

The account-only case inserts the genuine account through the normal client before baseline. The private-primary case establishes the pre-loss native store from the supported SDK export/import API, then verifies the real native authenticated note and encrypts the actual required recovery baseline. This is initial fixture preparation, not proof of Expected discovery through a normal-node sync.

A real password protector wraps a non-extractable Vault key. The real Vault stores logical Guardian identity, matching disposable cold custody and the independent encrypted recovery journal. Only the endpoint-derived SDK database is deleted, after orderly client disposal and explicit origin/name guards. The same profile then reloads and calls actual continuity detection and Vault.recoverStorage. Account state is not pre-repaired after deletion.

The local Guardian route requires the real wallet authentication headers and serves the genuine serialized private account. Header presence is observed; this fixture does not claim independent server-side signature verification. The exact-pinned producer creates generated node responses and verifies account-tree/MMR bindings. The actual SDK RpcClient generates every request image before the map is sealed. Recovery only receives exact learned request bytes. No protobuf or proof is hand-built; only gRPC-web framing is reused from the exact SDK fixture.

The producer binary must match CI40524043320, source77dfdc67577e1be2f7e18a7efed3a589f2d64d71, SHA2565e1c774ff287212325b666b27a3b4cffcb427f07b296e5965eebacbbf99da703. Its graph is the exact fd52477d SDK lock and native9a9b58a. It is executed only in CI, with two Rayon workers and a 60-second bound. Private intermediate files are mode0600 in a fresh temporary directory, removed after use, and never artifacts.

The positive private-primary assertion is intentional. If a fresh native store leaves a retained proof Unverified and the real recovery path refuses healthy resume, the test must fail at its actual closed phase. Do not seed chain state after deletion, relax authentication, or report preservation alone as successful recovery.

Still separate: normal-node Expected discovery and durable canonical promotion, submission/pending-row preservation, post-recovery second restart, cross-realm extension recovery, MT/classic packaging and the full20/performance gate. No execution or passing claim accompanies this source packet.
