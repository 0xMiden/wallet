/**
 * Structured log: one JSON line per event.
 * Do not put a signature, an authorization, a request body or a secret in the fields.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogValue = string | number | bigint | boolean | null | undefined;

export type LogFields = Record<string, LogValue>;

export type LogWriter = (line: string) => void;

let writer: LogWriter = line => {
  console.log(line);
};

/** Replace the output of the log. The tests use this to catch or silence lines. */
export function setLogWriter(next: LogWriter): void {
  writer = next;
}

function toJson(value: LogValue): string | number | boolean | null {
  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'undefined':
      return null;
    default:
      return value;
  }
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line: Record<string, string | number | boolean | null> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      line[key] = toJson(value);
    }
  }
  writer(JSON.stringify(line));
}

/** A short text for an error, safe for the log. */
export function errorText(error: unknown): string {
  switch (true) {
    case error instanceof Error && 'shortMessage' in error && typeof error.shortMessage === 'string':
      return `${error.name}: ${error.shortMessage}`;
    case error instanceof Error:
      return `${error.name}: ${error.message}`;
    default:
      return String(error);
  }
}
