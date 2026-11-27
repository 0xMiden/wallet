# Command AI Proxy (Dev / Groq OSS)

Stateless HTTP compiler proxy for Bread Command's AI bar, reusing the Groq OSS model & spend-cap design from WLG (`openai/gpt-oss-120b`, configurable to `openai/gpt-oss-20b`).

## Privacy & Security Rules

- Never embeds `GROQ_API_KEY` in the wallet client bundle.
- Compiles commands only: it ignores `helpContext`. Help is served by the Worker in `services/command-ai`.
- Never logs request bodies, prompt text, model outputs, or client IPs.
- Enforces strict JSON Schema decoding (`COMMAND_AI_JSON_SCHEMA`) and monthly USD spend limits.

## Run Locally

```bash
export GROQ_API_KEY="gsk_..."
node services/command-ai-proxy/server.mjs
```

Optional environment variables:

- `COMMAND_AI_MODEL` (default `openai/gpt-oss-120b`; can set `openai/gpt-oss-20b`)
- `COMMAND_AI_REASONING_EFFORT` (default `low`)
- `COMMAND_AI_MONTHLY_CAP_USD` (default `50`)
- `PORT` (default `8787`)
