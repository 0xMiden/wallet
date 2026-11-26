# Miden Command AI Worker

Standalone, stateless Cloudflare Worker that compiles privacy-redacted wallet prompts into structured command intents via Groq (`POST /v1/compile`). It holds no database bindings and no user authentication secrets.

## Endpoints

- `GET /healthz` — returns `{ ok: true, revision }` with `Cache-Control: private, no-store`.
- `POST /v1/compile` validates `{ redactedText, snapshot? }` for existing commands, or `{ redactedText, helpContext }` to enable help. The help context is null or the previous public topic ID. Help requests cannot include a snapshot. Both use the existing Groq structured output and share the same rate limit.

Help adds a compact public fact sheet to the model instructions. The model writes the reply. The wallet accepts bounded plain text and maps a known topic to an official source link. Older clients continue using the original prompt and schema.

Run `node scripts/command-ai-eval/run-eval.mjs --questions` from the repository root to check the bounded synthetic question set. With `GROQ_API_KEY` configured, the run reports model routing, basic fact checks, peak prompt tokens, and latency. Add `--offline` when checking fixture redaction without the provider.

## Bindings & Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | Worker secret | Server-side Groq API key used by `POST /v1/compile` |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact allowed wallet origins (no wildcards) |
| `DEPLOYMENT_REVISION` | Worker variable | Deployed commit SHA exposed on `/healthz` |
| `COMMAND_AI_RATE_LIMIT` | Rate limit binding | Namespace `189405` (30 requests / 60 seconds per caller IP) |

## Deployment

Live Worker URL: `https://miden-command-ai.wiktor-s-e3d.workers.dev`

`.github/workflows/deploy-command-ai.yml` deploys from the `command-ai-production` GitHub environment using:

- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Account Settings: Read), `CLOUDFLARE_ACCOUNT_ID`, `GROQ_API_KEY`
- Variables: `COMMAND_AI_PROXY_URL`, `COMMAND_AI_ALLOWED_ORIGINS`
