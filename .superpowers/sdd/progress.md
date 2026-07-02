# Local E2E CI — SDD progress ledger
Branch: feat/local-e2e-ci · PR #305 · ALL GREEN

TIER-1 (node + prover + note-transport, 8 core specs):
- Tasks 1-6: complete + CI-green (run 28580843677, 8/8).
- CI fixes: nc->readiness gate; xvfb; CLI-preinstall; cache-key; timeout 45m;
  warm-cache CLI skip; coverage 95% (getGuardianOptionsForNetwork + safe-network tests).

TIER-2 (local guardian + guardian-send-consume, in same PR per user):
- Guardian service (ghcr.io/openzeppelin/guardian:v0.15.0) + postgres, `guardian` profile,
  network_mode:host (hardcoded localhost:57291 RPC), HTTP :3000.
- localnet guardian preset (constants.ts http://localhost:3000) so ChooseGuardian has a pick.
- ROOT CAUSE of send failure: guardian txns delegate proving to the localnet prover; the
  host-net guardian binds host :50051 (hardcoded gRPC), colliding with the prover. Fix: move
  prover to host :50052 + point wallet localnet proving (constants.ts) at :50052.
- CI-GREEN (run 28590475288): 8 core + 1 guardian spec pass. Full multisig co-sign path works.

Task 7 (burn-in + flip required): pending [maintainer].
