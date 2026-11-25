import { type AiCompilerOutput, parseAiCompilerOutput } from './schema';

export const COMMAND_AI_PROXY_STORAGE_KEY = 'bread_command_ai_proxy_url';

export type CommandAiErrorCode =
  | 'unconfigured'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_response'
  | 'timeout'
  | 'aborted';

export class CommandAiClientError extends Error {
  readonly code: CommandAiErrorCode;

  constructor(code: CommandAiErrorCode, message: string) {
    super(message);
    this.name = 'CommandAiClientError';
    this.code = code;
  }
}

export interface RedactedClarificationSnapshot {
  missingSlot: string;
  allowedOptionIds: string[];
  draft: {
    action: string;
    asset: string | null;
    to_asset: string | null;
    from_chain: string | null;
    to_chain: string | null;
    hasAmount: boolean;
    hasRecipient: boolean;
    provider: string | null;
    note_type: string | null;
    earn_op: string | null;
  };
}

export interface CompileCommandRequest {
  redactedText: string;
  snapshot?: RedactedClarificationSnapshot;
  endpoint?: string;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function resolveCommandAiEndpoint(override?: string): string | null {
  const candidates = [
    override,
    typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage.getItem(COMMAND_AI_PROXY_STORAGE_KEY)
      : null,
    process.env.COMMAND_AI_PROXY_URL
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') return trimmed;
      if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
        return trimmed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function compileCommandPrompt(req: CompileCommandRequest): Promise<AiCompilerOutput> {
  const endpoint = resolveCommandAiEndpoint(req.endpoint);
  if (!endpoint) {
    throw new CommandAiClientError('unconfigured', 'AI command proxy endpoint is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort('external');
  req.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(`${endpoint}/v1/compile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      // Stateless request: never attach wallet identity, addresses, cookies, or credentials.
      credentials: 'omit',
      body: JSON.stringify({
        redactedText: req.redactedText,
        ...(req.snapshot ? { snapshot: req.snapshot } : {})
      }),
      signal: controller.signal
    });

    if (response.status === 429) {
      throw new CommandAiClientError('rate_limited', 'AI command service rate limited');
    }
    if (!response.ok) {
      throw new CommandAiClientError('unavailable', `AI command service returned ${response.status}`);
    }

    const rawText = await response.text();
    if (rawText.length > MAX_RESPONSE_BYTES) {
      throw new CommandAiClientError('invalid_response', 'AI command response exceeded size limit');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new CommandAiClientError('invalid_response', 'AI command response was not valid JSON');
    }

    const compilerPayload =
      typeof parsedJson === 'object' && parsedJson !== null && 'output' in parsedJson
        ? (parsedJson as { output: unknown }).output
        : parsedJson;
    const output = parseAiCompilerOutput(compilerPayload);
    if (!output) {
      throw new CommandAiClientError('invalid_response', 'AI command response failed schema validation');
    }
    return output;
  } catch (error) {
    if (error instanceof CommandAiClientError) throw error;
    if (controller.signal.aborted) {
      if (req.signal?.aborted) {
        throw new CommandAiClientError('aborted', 'AI command request was aborted');
      }
      throw new CommandAiClientError('timeout', 'AI command request timed out');
    }
    throw new CommandAiClientError('unavailable', 'AI command service unreachable');
  } finally {
    clearTimeout(timeout);
    req.signal?.removeEventListener('abort', onExternalAbort);
  }
}
