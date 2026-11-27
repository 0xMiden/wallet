# Miden Command AI Worker

Standalone, stateless Cloudflare Worker that compiles privacy-redacted wallet prompts into structured command intents via Groq (`POST /v1/compile`). It holds no database bindings and no user authentication secrets.

## Endpoints

- `GET /healthz` — returns `{ ok: true, revision }` with `Cache-Control: private, no-store`.
- `POST /v1/compile` validates `{ redactedText, snapshot? }` for existing commands, or `{ redactedText, helpContext }` to enable help. The help context is null or the previous public topic ID. Help requests cannot include a snapshot. Both use the existing Groq structured output and share the same rate limit.

## Help answers

With a help context, the model picks up to two card ids and the Worker replies with the chosen card's checked answer. A topic button is answered without a provider call. Model-written help text is never forwarded. When no card fits, the answer says so and points to support.miden.xyz. Help is English only. A request without a help context compiles commands only.

The cards are in `src/help-cards.json`:

| Field                            | Contents                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `forbid`                         | Patterns that no fact or answer may match                                                                                      |
| `buttons`                        | For each of the 14 topics, its button card and every title that reaches it                                                     |
| `facts`                          | One claim each, with its conditions, under an id, with public sources in `src` (a URL, `repo@sha:path` or `owner:wallet#2359`) |
| `cards[].id`, `pick`             | The id the router returns and its router line, at most 40 characters                                                           |
| `cards[].topic`, `kind`          | The reply topic the app shows, and `explain` or `problem`                                                                      |
| `cards[].mode`, `urgent`         | `fixed` wins even as the second pick, and `urgent` beats other fixed cards. `checked` and `write` have no precedence           |
| `cards[].lead`, `facts`, `limit` | Fact ids: the safe first step, the body, and the limits that close the answer                                                  |
| `cards[].required`, `forbid`     | Facts the answer must keep, and extra forbidden patterns                                                                       |
| `cards[].answer`                 | The text served: at most 600 characters, 750 if urgent                                                                         |

### Adding or changing a card

1. Edit `src/help-cards.json`. Check every fact against its source.
2. For a new card, add its row to the expected table and counts in `scripts/command-ai-eval/help-cards.test.ts`, put it in a group in `help-eval.test.ts`, and add at least two cases to `help-eval.json` that accept it, one of them in a `dev` cluster. A cluster is one intent: one class and a card every case in it accepts. A P0 case lists its forbidden cards. A case has a `split` of `regression` when the first 32 bits of the SHA-256 of its `cluster`, modulo 100, are under 15, and `dev` otherwise.
3. Run `yarn jest scripts/command-ai-eval/help-cards.test.ts scripts/command-ai-eval/help-eval.test.ts`.
4. After any change to a card or to the router prompt, run the selection suite again.

## Evaluation

Offline checks, which CI runs without a provider key:

```bash
node --test scripts/command-ai-eval/offline.test.mjs
node scripts/command-ai-eval/run-eval.mjs --offline --questions
```

Live runs spend provider quota. Dispatch the **Command AI service** workflow with a `suite`. Its live job runs only on a manual dispatch, in the `command-ai-eval` environment with the `GROQ_API_KEY_EVAL` secret, whose quota must be separate from production. It paces itself on the provider's rate-limit headers and uploads a JSON summary.

| Suite           | What it checks                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`      | Each case in `cases.json` three times. With `scripts/command-ai-eval/baseline.json` committed (the summary of an earlier run), it fails on a case that passed 3 of 3 there, or is not in it, and now fails twice unless marked `intendedChange`, a help question that becomes a send or plan, and a command or clarification reply answered as help |
| `selection-dev` | Each case in `help-eval.json` three times, scored by cluster. For tuning                                                                                                                                                                                                                                                                            |
| `selection`     | The same plus `help-holdout.json`, the merge gate. Before any model call it refuses a missing holdout, a bad case, or fewer than 80 answerable, 30 near-miss or 30 out-of-scope holdout clusters                                                                                                                                                    |
| `measure`       | Not implemented; the job fails                                                                                                                                                                                                                                                                                                                      |

The selection run needs an accepted card for 95% of answered dev clusters and 90% of holdout clusters, 80% of answerable clusters answered, 90% of out-of-scope clusters refused and, on a holdout, 85% of near misses refused. It also fails on a forbidden card on a P0 case, an urgent card on a benign how-to, a help question that becomes a send or plan, a prompt over 3,600 tokens or a request that errored. Answer rate and refusals are measured on the holdout when there is one, otherwise on dev. A holdout used for tuning must be replaced.

## Bindings & Configuration

| Name                    | Kind               | Purpose                                                     |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| `GROQ_API_KEY`          | Worker secret      | Server-side Groq API key used by `POST /v1/compile`         |
| `ALLOWED_ORIGINS`       | Worker variable    | JSON array of exact allowed wallet origins (no wildcards)   |
| `DEPLOYMENT_REVISION`   | Worker variable    | Deployed commit SHA exposed on `/healthz`                   |
| `COMMAND_AI_RATE_LIMIT` | Rate limit binding | Namespace `189405` (30 requests / 60 seconds per caller IP) |

## Deployment

Before it deploys, the workflow asks the questions in `scripts/command-ai-eval/questions.json` with the production provider key. A missed question is asked twice more and needs two passes of three. The deploy stops if a control fails, a help question becomes a send or plan, a P0 question gets a forbidden card, a reply fails the app parser or a forbidden pattern, or fewer than 90% of help questions get an accepted card. The 30-minute job timeout and 20-minute retry budget are provisional until the key's rate limits are measured.

To roll back, run `npx wrangler rollback --config services/command-ai/wrangler.jsonc` (or use the Cloudflare dashboard), which runs no evaluation. Then check that `/healthz` shows the expected revision.

Live Worker URL: `https://miden-command-ai.wiktor-s-e3d.workers.dev`

`.github/workflows/deploy-command-ai.yml` deploys from the `command-ai-production` GitHub environment using:

- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Account Settings: Read), `CLOUDFLARE_ACCOUNT_ID`, `GROQ_API_KEY`
- Variables: `COMMAND_AI_PROXY_URL`, `COMMAND_AI_ALLOWED_ORIGINS`
