import { readFileSync } from 'node:fs';

// API 36 `am instrument -w` prints the stream bundle value verbatim. The
// non-interactive ADB shell preserves LF; neither raw reporter keys nor CRLF are records.
const stem = 'DAPP_SWIPE_';
const prefix = `${stem}BOUNDARY_V1 `;
const transitions = {
  unknown: ['enter'],
  enter: ['false', 'throw', 'true'],
  true: ['reply-ready'],
  'reply-ready': ['writer-error', 'writer-clear'],
};

export function reduceSwipeBoundary(capture) {
  const lines = capture.split('\n');
  const tail = lines.pop();
  if (tail && (stem.startsWith(tail) || tail.includes(stem))) return 'unknown';

  let state = 'unknown';
  for (const line of lines) {
    if (!line.includes(stem)) continue;
    if (!line.startsWith(prefix)) return 'unknown';
    const next = line.slice(prefix.length);
    if (!transitions[state]?.includes(next)) return 'unknown';
    state = next;
  }
  return state;
}

export function readSwipeBoundary(path) {
  try {
    return reduceSwipeBoundary(readFileSync(path, 'utf8'));
  } catch {
    return 'unknown';
  }
}
