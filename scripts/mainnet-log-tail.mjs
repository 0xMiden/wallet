import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_BYTES = 65_536;
const MAX_LINES = 60;
const MAX_LINE = 400;

// Private process logs are never uploaded raw: only a bounded tail with secrets and long hex identifiers removed.
export function sanitizedTail(text, secrets = []) {
  let out = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  out = out
    .replace(/\b(?:0x)?[0-9a-fA-F]{32,}\b/g, '[redacted-hex]')
    .replace(/\b(api[_-]?key|token|secret|authorization|mnemonic|seed|password)\b(["']?\s*[:=]\s*)\S+/gi, '$1$2[redacted]');
  return out
    .split('\n')
    .map(line => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line))
    .filter(line => line.trim() !== '')
    .slice(-MAX_LINES)
    .join('\n');
}

function readTail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, MAX_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

export function logTailReport(paths, env = process.env) {
  const secrets = Object.entries(env)
    .filter(([key]) => key.startsWith('E2E_MAINNET_'))
    .map(([, value]) => value ?? '');
  return paths
    .map(path =>
      existsSync(path)
        ? `### ${basename(path)}\n\n\`\`\`\n${sanitizedTail(readTail(path), secrets)}\n\`\`\`\n`
        : `### ${basename(path)}\n\nNo log was written.\n`
    )
    .join('\n');
}

if (basename(process.argv[1] ?? '') === 'mainnet-log-tail.mjs') process.stdout.write(logTailReport(process.argv.slice(2)));
