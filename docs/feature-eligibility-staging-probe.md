# Eligibility staging binding probe

This manual tool proves only whether two fresh rate-limit bindings actually refuse synthetic calls in the existing account and whether the isolated Worker is then absent. It does not close #1894, certify production throughput, change financial policy or deploy the eligibility service.

The first live probe must wait for this tooling to merge into reviewed `main`. The existing `feature-eligibility-production` environment and its branch rules remain unchanged. Only `0xMiden/wallet`, a non-fork `workflow_dispatch` event on `refs/heads/main`, and that event's exact `github.sha` can reach the credential job. Inputs never select a source, script name, config, endpoint or threshold. The dedicated staging concurrency group queues overlapping operations rather than cancelling them.

## Run once from trusted main

After the source is reviewed and merged, dispatch exactly once:

```sh
gh workflow run probe-feature-eligibility.yml --repo 0xMiden/wallet --ref main -f operation=probe
```

Identify the new run by its workflow, `workflow_dispatch` event, `main` branch and exact expected source SHA. Record the run ID, attempt and SHA, then immediately monitor it:

```sh
gh run watch <run-id> --repo 0xMiden/wallet --interval 30 --exit-status
```

Inspect terminal status and failed-step logs promptly. Do not blindly retry, redeploy, increase traffic or choose a fallback from a failed run. A successful upload alone proves no refusal behavior.

The fixed exercise makes at most 34 requests: one health request, one invalid-auth request, 16 caller checks and 16 colo checks. It permits one request in flight and starts requests at least 126 ms apart, below the absolute ceilings of 120 requests, four concurrent requests, eight starts per second and 60 seconds. `CALLER_PROBE` is 4/60 seconds and `COLO_PROBE` is 4/10 seconds. Approximate, location-local counters mean this proves actual refusal behavior, not an exact N+1 threshold or production admission capacity.

The standalone Worker reads no wallet inputs or caller IPs, fetches no external service and has no logs, traces, paid lookup, production configuration, routes, custom domains, Durable Objects, KV or migrations. Its rate namespace identifiers are isolated config values, not separately provisioned resources.

Authentication reads only `GET /accounts/{configured_account_id}` and accepts the bounded successful envelope only when `result.id` exactly matches that configured account. This supports user-owned and account-owned credentials without introspection, token-prefix guesses or token-management permissions. Existing Workers Scripts Read/Write permissions suffice for this metadata request; no account-settings permission is added. Success proves only current account read access. Inventory, deployment support and exact-resource cleanup remain separate gates. A failed read stops without fallback, retry or capability inference.

## Interpret the retained evidence

The three-day artifact `eligibility-probe-<run-id>-<attempt>` contains only `manifest.json`, if a valid manifest exists, and a closed `result.json`. The manifest contains the schema, exact run/attempt/source identity, deterministic script name, namespace identifiers, limits, deployment state and source/config/owner hashes. It contains no account, credential, bearer or URL. Raw provider output, configs and secret files are never artifacts. Local credential-bearing files use mode 0600 inside a mode 0700 directory and are unlinked in the controller/evidence cleanup paths.

| Evidence                       | Meaning                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `support: supported`           | Both caller and colo returned actual limited responses, and cleanup proved removal or absence.                        |
| `support: unknown`             | No capability conclusion. Auth, quota, network, malformed readback, runtime failure or missing refusal stays unknown. |
| `cleanup: blocked`             | The exact resource may remain. This blocks completion even if refusal behavior was observed.                          |
| `cleanup: absent` or `removed` | Authenticated exact-script readback proved absence.                                                                   |

Counts and the caller/colo verdicts are separate observations. The controller never automatically emits `unsupported`. Any later unsupported classification requires independent verification that sanitized structured provider status/code corresponds to an explicit binding or plan rejection. It never follows from a generic deployment error. No fallback architecture is selected by this tool.

A normal probe attempts cleanup internally and the workflow always retries the same idempotent, manifest-bound cleanup if the manifest was written. The original probe failure remains a job failure even if cleanup succeeds. Process death, runner loss and a job timeout can prevent cleanup and artifact upload. They can leave exactly `miden-elig-probe-<run-id>-<attempt>` behind; automatic cleanup after runner death is not promised.

## Recover one prior attempt

Use only the original probe's run ID and attempt, while its three-day evidence is available:

```sh
gh workflow run probe-feature-eligibility.yml --repo 0xMiden/wallet --ref main \
  -f operation=cleanup -f cleanup_run_id=<prior-run-id> -f cleanup_attempt=<prior-attempt>
```

Record the new cleanup run ID/source/attempt and monitor it at 30-second intervals as above. Cleanup mode never deploys or exercises.

Before Cloudflare credentials enter cleanup, the helper verifies GitHub metadata for the exact completed original run and attempt: same repository and non-fork head, manual event on main, exact workflow path/ID, source SHA, and one unexpired attempt-named artifact with matching run/repository/head/source metadata. It retrieves the standalone Worker bytes at that exact prior SHA. The download action receives only that verified artifact ID and original run ID.

The credential step validates every deterministic manifest field against those prior bytes and that verified identity, preserves the current trusted-main GitHub context, then invokes the existing controller's authenticated account access, remote source, marker, binding and content checks. An artifact alone never authorizes deletion. Changed source bytes, marker, namespace, resource type, missing metadata, missing artifact or ambiguous provenance blocks deletion. A recovery receipt refers to the original identity; it is not a new probe that can itself become a recovery target.

If the artifact is missing, expired or rejected, stop with cleanup blocked. Do not delete by prefix, account inventory, guessed name or a freshly generated replacement manifest. A privileged operator must recover the original exact manifest from trusted retained job state, bind its repository/workflow/run/attempt/source to independently fetched GitHub metadata, retrieve the exact prior Worker bytes and compare all deterministic hashes/namespace IDs. For this one manifest, confirm the exact script `miden-elig-probe-<run-id>-<attempt>` has the matching standalone content, `PROBE_SOURCE`, `PROBE_CONFIG_SHA`, `PROBE_OWNER`, exactly the two expected ratelimit bindings and the expected secret bindings, with previews/logging disabled. Reuse the controller's manifest-bound cleanup only after a separately reviewed provenance verifier supplies that exact prior identity and source. It must authenticate and prove exact-script absence after deletion with the documented not-found code. If any evidence is unavailable or differs, leave it blocked for operator investigation; no broad cleanup is authorized.

## Closed ownership diagnostics during cleanup

A failed manifest-bound cleanup may retain `ownershipCheck: { gate, form }` in the existing result artifact. `gate` names the first existing ownership predicate that refused the resource; it never comes from a provider-supplied binding name. `form` is only `missing`, `null`, `wrong_type`, `different_value`, `additional_fields` or `unavailable`. No observed value, metadata, URL, namespace, account, content or credential is retained. The original probe preflight remains independent from a later cleanup observation.

This adds evidence, not authorization: every comparison, short-circuit, source/provenance check, content hash and deletion/absence guard stays unchanged. Missing authoritative logging fields and additional rate-limit fields still refuse cleanup. If an API/read fails before a predicate is evaluated, no failed ownership predicate is invented. If later evidence is unavailable, the earlier probe's failure does not become a successful cleanup.

Use only the reviewed exact-original-manifest recovery described above. Its receipt describes that recovery's first failed check, not necessarily the original verification failure or any later unexamined gate. It never authorizes normalization, a guessed deletion, a new deployment, more exercise traffic or a support conclusion.

## Remaining #1894 acceptance

Account-binding proof is the first phase only. Native-Origin witness and supported-shell verification, production topology, load/cache/budget/lease tests, production shedding changes and any production deployment remain separate deliverables. This workflow implies no customer load test, Paid/domain decision or financial-policy change.

## Early failure evidence

Failed current-run results may retain a closed preflight receipt bound to the workflow's repository, source, run and attempt. It records the finite stage and original reason, whether a manifest was registered, and whether deployment was attempted. It never includes credential values, provider response bodies or account settings.

If the trusted receipt proves deployment was not attempted and no manifest is present, missing cleanup output no longer replaces the original reason. Cleanup remains `blocked`, not `absent`: no external resource-absence claim follows from a missing manifest. Missing, malformed, other-run or attempted-deployment evidence remains fail-closed. Prior-run recovery still requires its exact manifest, artifact and authenticated ownership checks.

### Authoritative observability readback

Ownership reads `/settings` for bindings, compatibility and existing configuration/identity checks, then independently reads the exact manifest script's canonical `/script-settings` endpoint. The latter must explicitly report `false` for `observability.enabled`, `observability.logs.enabled`, `observability.logs.invocation_logs` and `observability.traces.enabled`. Optional or missing fields never mean disabled. Missing version-level observability can defer only to that independent explicit-false readback; present enabled, null, malformed or conflicting version-level values still refuse. Existing Logpush and tail-consumer checks remain; explicit conflicting script-level counterparts also refuse. Content, subdomain, source/owner, delete and absence checks remain mandatory.

Closed authority gates are `script_observability`, `script_observability_logs`, `script_observability_invocations`, `script_observability_traces`, `script_logpush` and `script_tail_consumers`, with the existing fixed form vocabulary. No provider metadata is retained. API, parsing or ambiguous readback failure blocks cleanup; this does not promise that a live response contains enough evidence. This source follows Cloudflare's [script-level settings contract](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/) without treating configuration defaults as effective state.
