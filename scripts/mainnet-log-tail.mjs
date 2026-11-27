import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_BYTES = 65_536;
const MAX_LINES = 60;
const MAX_LINE = 400;

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Between words: any punctuation, whitespace or a short bracketed log prefix, so reflowed, comma-joined or prefixed phrases match.
const separator = lines => `(?:[^A-Za-z0-9\\[${lines ? '' : '\\n'}]|\\[[^\\]\\n]{0,40}\\])+`;
const SEPARATOR = `(?:${separator(true)}|\\\\[nrt])+`;
const LINE_SEPARATOR = separator(false);

function collectLeaves(node, out) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') Object.values(node).forEach(child => collectLeaves(child, out));
}

// Every shape a secret can take in a log: as given, trimmed, JSON-escaped, URL-encoded, or reflowed across whitespace.
function secretPatterns(secret) {
  const value = secret.trim();
  if (value.length < 8) return [];
  const literals = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)];
  literals.push(literals[2].replace(/%20/g, '+'));
  const reflowed = value.split(/\s+/).map(escapeRegex).join(SEPARATOR);
  return [...new Set(literals)].map(escapeRegex).concat(reflowed);
}

// Private process logs are never uploaded raw: only a bounded tail with secrets, key-like runs and addresses removed.
// When in doubt a value is dropped: any 32+ character alphanumeric run, any ".near" account and any 12 plain words go.
export function sanitizedTail(text, secrets = []) {
  let out = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const secret of secrets)
    for (const pattern of secretPatterns(secret)) out = out.replace(new RegExp(pattern, 'gi'), '[redacted]');
  out = out
    .replace(/(^\s*at [^(\n]*)\((?![^()\s]*:\d+:\d+\)|<anonymous>\)|native\))[^)\n]*\)/gm, '$1(...)')
    .replace(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g, '[redacted-hex]')
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g, '[redacted-key]')
    .replace(
      /(?<![A-Za-z0-9-])[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,10}\.near(?![A-Za-z0-9])/gi,
      '[redacted-account]'
    )
    .replace(
      new RegExp(
        `(?<![A-Za-z])(?:[a-z]{3,8}${LINE_SEPARATOR}){11}[a-z]{3,8}(?:${LINE_SEPARATOR}[a-z]{3,8})*(?![A-Za-z])`,
        'gi'
      ),
      '[redacted-words]'
    )
    .replace(/(?<![A-Za-z])(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(
      /(?<![A-Za-z0-9])((?:api|private|secret)[_-]?key|token|secret|authorization|mnemonic|seed|passwd|password|cookie|session)(?![A-Za-z0-9])(["']?\s*[:=]\s*|\s+)(?:(?:bearer|basic)\s+)?\S+/gi,
      '$1$2[redacted]'
    );
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

if (basename(process.argv[1] ?? '') === 'mainnet-log-tail.mjs')
  process.stdout.write(logTailReport(process.argv.slice(2)));
