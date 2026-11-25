# Miden Command AI Worker

Standalone, stateless Cloudflare Worker that compiles privacy-redacted wallet prompts into structured command intents via Groq (`POST /v1/compile`). It holds no database bindings and no user authentication secrets.

## Endpoints

- `GET /healthz` — returns `{ ok: true, revision }` with `Cache-Control: private, no-store`.
- `POST /v1/compile` — rate-limited (`COMMAND_AI_RATE_LIMIT`, 30 req / 60 s per caller IP), validates `{ redactedText, snapshot? }`, calls Groq structured output (`openai/gpt-oss-120b`), and returns `{ output }`.

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
