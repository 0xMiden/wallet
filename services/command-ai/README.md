# Miden Command AI Worker

Standalone, stateless Cloudflare Worker that compiles privacy-redacted wallet prompts into structured command intents via Groq (`POST /v1/compile`). It holds no database bindings and no user authentication secrets.

## Endpoints

- `GET /healthz` — returns `{ ok: true, revision }` with `Cache-Control: private, no-store`.
- A request with a `snapshot`, the follow-up to a clarification question, also tells the model to wrap its reply in `result` and to list every patch key; without that the provider refuses its replies.
- App 1.18.2 keeps the old token or bridge route when a follow-up patch changes it, so such a reply is never returned: the Worker answers `unsupported` (log `compile_declined`) for a `patch_slots` that changes the action, a bridge's assets or chains, or a send or swap token that had a value (a `<TOKEN_n>` typed in that reply excepted), and for one that leaves out a token the reply names. The app shows an error and keeps the question it asked. `follow-up.ts` holds the rule; `scripts/command-ai-eval/follow-up.test.ts` runs it against the client files frozen in `app-1.18.2/`. A symbol that is neither in the redactor's ticker list nor a token the wallet holds is not recognised as a named token. Do not relax the rule while a release with that client is in use.
- A request without a `snapshot` whose reply the provider refuses to fit to the schema (HTTP 400 `json_validate_failed`) answers `unsupported` with an empty reason, and logs `compile_refused`. The app sends a typed clarification reply without its snapshot first, so a short word like "public" then still reaches the follow-up request. Every other provider failure is a 502, as is this one on a request with a snapshot.
- A help pick for a typed reply (`isTypedReply`: a redacted literal or a choice such as "public" or a provider name, with at most a few edit words and no question mark) also answers `unsupported`, because the app stops at a help card and would not send the follow-up. A new token symbol, network or provider needs a line in that vocabulary.
- `POST /v1/compile` validates `{ redactedText, snapshot? }` for existing commands, or `{ redactedText, helpContext }` to enable help. The help context is null or the previous public topic ID. Help requests cannot include a snapshot. Both use the existing Groq structured output and share the same rate limit.

## Help answers

With a help context, the router model picks up to two card ids. A topic button is answered without a provider call. The router's own help text is never forwarded. When no card fits, the answer says so and points to support.miden.xyz. Help is English only. A request without a help context compiles commands only.

The reply is the chosen card's checked answer, unless that card is listed in `writing.cards`. Then:

1. A writer model gets the facts of the picked listed cards, and returns sentences with the fact ids behind each, or says it cannot answer.
2. Code gates (`src/help-write.ts`) check the draft: schema, length and the app's parser, cited ids, printable ASCII, no number, number word, name or domain that the supplied text lacks, no sentence that names a phrase, words, key, password, passcode or wallet file, or that mentions resetting, removing, signing out or repeating a payment, unless it is a supplied sentence or opens with a warning against its only action (a backstop, not a meaning check), the forbidden patterns and the sharing-advice filter.
3. A checker model, in a separate call, says whether the final answer is supported by the facts and answers the question.

The server adds the lead and limit sentences of every card the writer was given, whatever it cites. A draft with no sentence cites nothing, so it gets the unknown reply. Written text is shown only after every gate and the checker pass.

| Event                                                                             | Reply                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------- |
| The writer cannot answer, a content gate fails, or the checker refuses            | `not_covered`, or `cannot_diagnose` for a problem |
| A format gate fails, or the checker has a technical failure                       | The checked answer of the card the draft drew on  |
| The writer has a technical failure (429, error, timeout, bad reply, no time left) | The first card's checked answer                   |

Writer and checker calls are never retried and end within 9 seconds of the request's start. A writing failure never returns an error status. Nothing is written while either writing model is the router model in use, so writing cannot use up the quota every command needs.

### The writing switch

`writing` in `src/help-cards.json` names the `writer` and `checker` models and lists the cards that may be written. **`cards: []`, the committed value, turns writing off, and is the kill switch.** Only `write` cards are ever written: the safety, emergency and who-can-see cards are `fixed` or `checked`, so they are served word for word. A card is listed only from the allowlist that the `writing-score` suite prints, in a commit that names the graded run ids and updates the pin in `help-cards.test.ts`.

The cards are in `src/help-cards.json`:

| Field                            | Contents                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `writing`                        | The writer and checker models, and the cards that may be written                                                               |
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

Live runs spend provider quota. Dispatch the **Command AI service** workflow with a `suite`. Its live job runs only on a manual dispatch, in the `command-ai-eval` environment, with the production `GROQ_API_KEY` secret, so a run shares the live rate limit. It uploads a JSON summary, and `grading.json` for the written-answer suites. Both hold only synthetic questions and model text.

To leave production its quota, every suite but `measure` waits between requests while a model has under half of its tokens a minute left. It waits out a writer's or checker's 429, and stops after 3 runs in a row stay technical failures, or when a model asks for more than 5 minutes. It also stops with no verdict when under half of a model's requests a day are left, or when a model allows 8,000 tokens a minute or fewer, or 1,000 requests a day or fewer. The headers do not show a daily token budget: before a suite larger than `measure`, check both models' daily limits in the provider console and that the run fits in half of them.

| Suite                    | What it checks                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure`                | One router, writer and checker call (schemas accepted, tokens, latency, limit headers, router prompt at most 3,600 tokens), then proof that a batch of writer calls, sized from the token limits and latency (5 to 40), moves neither the router's daily requests nor its tokens. Without the proof, no card may be listed                                                                           |
| `commands`               | Each case in `cases.json` three times. With `scripts/command-ai-eval/baseline.json` committed (the summary of an earlier run), it fails on a case that passed 3 of 3 there, or is not in it, or is marked `intendedChange`, and now fails twice. It also fails on a failed request in either run, a help question that becomes a send or plan, and a command or clarification reply answered as help |
| `selection-dev`          | Each case in `help-eval.json` three times, scored by cluster, with writing off. For tuning                                                                                                                                                                                                                                                                                                           |
| `selection`              | The same plus `help-holdout.json`, the merge gate. Before any model call it refuses a missing holdout, a bad case, or fewer than 80 answerable, 30 near-miss or 30 out-of-scope holdout clusters                                                                                                                                                                                                     |
| `writing-checker-dev`    | Each fixed draft in `writer-checks.json` through the gates, and through the checker three times                                                                                                                                                                                                                                                                                                      |
| `writing-checker`        | The same over `writer-checks-frozen.json`: no P0 bad draft accepted, at most 2% of bad drafts pass gates and checker, at most 15% of faithful drafts rejected                                                                                                                                                                                                                                        |
| `writing-dev`, `writing` | Each dev question, or each question of both holdouts, three times with every write card on                                                                                                                                                                                                                                                                                                           |
| `writing-knockout`       | Answerable holdout questions with their accepted cards removed from the router's index                                                                                                                                                                                                                                                                                                               |
| `writing-score`          | No model calls. Scores the committed results of `selection`, `writing-checker`, `writing` and `writing-knockout`                                                                                                                                                                                                                                                                                     |

The selection run needs an accepted card for 95% of answered dev clusters and 90% of holdout clusters, 80% of answerable dev clusters answered and, with a holdout, 80% of its answerable clusters, 90% of out-of-scope clusters refused and, on a holdout, 85% of near misses refused. It also fails on a forbidden card on a P0 case, an urgent card on a benign how-to, a help question that becomes a send or plan, a prompt over 3,600 tokens or a request that errored. Refusals are measured on the holdout when there is one, otherwise on dev. A holdout used for tuning must be replaced.

### Enabling written answers

`writer-checks.json`, `writer-checks-frozen.json` and `help-writing-holdout.json` are not committed yet. Each checker file needs 150 bad drafts, 20 or more in each class, and 75 faithful ones. Their authors do not edit the prompts, and nobody tuning reads the frozen file or a holdout.

1. Run `measure`. Tune on `writing-checker-dev` and `writing-dev` only. No gate or threshold is loosened to pass.
2. Freeze the router prompt, cards, writer and checker prompts, schemas, gates and models. On one commit run `selection`, `writing-checker`, `writing`, `writing-knockout` and `commands`. Each holdout suite runs once; only a run with no verdict may be repeated.
3. A person grades every row of both grading files: `verdict` is `correct` or `wrong`, and `serious` is true for a text that could cost money or a secret, cause a double payment, or states a forbidden claim.
4. Commit under `scripts/command-ai-eval/results/` the files `selection.json`, `writing-checker.json`, `writing.json`, `writing-knockout.json`, `writing-grading.json` and `writing-knockout-grading.json`, then dispatch `writing-score`. Such a commit changes no hashed file: the score refuses summaries from other code, questions or models, an ungraded or unmatched row, and a partial or dev run.

The score needs 150 or more written clusters, 95% of them correct with a Wilson lower bound of 90% (143 of 150 passes), no serious error, the selection and checker bars, and its limits on all answered clusters, refusals, knockout, technical failures and checked-answer fallbacks. A card is listed only with 3 or more graded written clusters, no serious error and fewer than 2 wrong. A cluster is right only if every run of every question in it is. After a failure, writing stays off, and any change needs an unseen holdout.

## Bindings & Configuration

| Name                    | Kind               | Purpose                                                     |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| `GROQ_API_KEY`          | Worker secret      | Server-side Groq API key used by `POST /v1/compile`         |
| `ALLOWED_ORIGINS`       | Worker variable    | JSON array of exact allowed wallet origins (no wildcards)   |
| `DEPLOYMENT_REVISION`   | Worker variable    | Deployed commit SHA exposed on `/healthz`                   |
| `COMMAND_AI_RATE_LIMIT` | Rate limit binding | Namespace `189405` (30 requests / 60 seconds per caller IP) |

## Deployment

Before it deploys, the workflow asks the questions in `scripts/command-ai-eval/questions.json` with the production provider key. A missed question is asked twice more and needs two passes of three. While `writing.cards` lists any card, at least 6 questions must accept a listed card and two thirds of those must be answered in written text. The deploy stops if a control fails, a help question becomes a send or plan, a P0 question gets a forbidden card, whether served or given to the writer for a written reply, a reply fails the app parser or a forbidden pattern, or fewer than 90% of help questions get an accepted card. The 30-minute job timeout and 20-minute retry budget are provisional until the key's rate limits are measured.

To turn writing off, deploy with `writing.cards: []`. To roll back, run `npx wrangler rollback --config services/command-ai/wrangler.jsonc` (or use the Cloudflare dashboard), which runs no evaluation. Then check that `/healthz` shows the expected revision.

Live Worker URL: `https://miden-command-ai.wiktor-s-e3d.workers.dev`

`.github/workflows/deploy-command-ai.yml` deploys from the `command-ai-production` GitHub environment using:

- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Account Settings: Read), `CLOUDFLARE_ACCOUNT_ID`, `GROQ_API_KEY`
- Variables: `COMMAND_AI_PROXY_URL`, `COMMAND_AI_ALLOWED_ORIGINS`
