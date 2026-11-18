import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

// API 36 `am instrument -w` prints the stream bundle value verbatim. The
// non-interactive ADB shell preserves LF; neither raw reporter keys nor CRLF are records.
const stem = 'DAPP_SWIPE_';
const prefix = `${stem}BOUNDARY_V2 `;
const stage = 'capsule-cancel-reply-before-injected\n';
const maxCaptureBytes = 1024 * 1024;
const transitions = {
  unknown: ['enter'],
  enter: ['false', 'throw', 'true'],
  true: ['reply-ready'],
  'reply-ready': ['writer-error', 'writer-clear'],
};

export function reduceSwipeBoundary(capture) {
  const lines = capture.split('\n');
  const tail = lines.pop();
  if (tail && (stem.startsWith(tail) || tail.includes(stem))) return undefined;

  let state = 'unknown';
  let budget;
  for (const line of lines) {
    if (!line.includes(stem)) continue;
    if (!line.startsWith(prefix)) return undefined;
    const [next, bit, extra] = line.slice(prefix.length).split(' ');
    if (!transitions[state]?.includes(next) || extra !== undefined) return undefined;
    if (next === 'true') {
      if (bit !== 'under-budget' && bit !== 'at-least-budget') return undefined;
      budget = bit;
    } else if (bit !== undefined) return undefined;
    state = next;
  }
  return state === 'unknown' ? undefined : { state, budget };
}

function readPrefixes(path, entrySnapshot, finalSnapshot) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd, { bigint: true });
    if (!file.isFile()) return [];
    const identity = `${file.dev}:${file.ino}:`;
    const length = snapshot => {
      const size = Number(snapshot.slice(identity.length));
      return size > 0 && size <= maxCaptureBytes && Number.isInteger(size) && snapshot === `${identity}${size}`
        ? size
        : 0;
    };
    const entry = length(entrySnapshot);
    const final = length(finalSnapshot);
    if (!entry || final < entry || BigInt(final) > file.size) return [];
    // The invocation owns a single append-only capture; never read beyond the pre-kill boundary.
    const bytes = Buffer.alloc(final);
    if (readSync(fd, bytes, 0, final, 0) !== final) return [];
    return [reduceSwipeBoundary(bytes.toString('utf8', 0, entry)), reduceSwipeBoundary(bytes.toString('utf8'))];
  } finally {
    closeSync(fd);
  }
}

export function readSwipeVerdict(path, stagePath, entrySnapshot, finalSnapshot) {
  try {
    const tag = readFileSync(stagePath, 'utf8');
    if (tag !== `${stage}idle\n` && tag !== `${stage}other\n`) return 'unknown';
    const [entry, final] = readPrefixes(path, entrySnapshot, finalSnapshot);
    if (!entry || !final) return 'unknown';
    if (tag === `${stage}other\n`) return 'other-rejection';
    if (final.state === 'false') return 'native-false';
    if (final.state === 'throw') return 'native-throw';
    if (final.budget === 'at-least-budget') return 'idle-at-least-budget';
    if (final.budget === 'under-budget') {
      // First visible in the second snapshot is not evidence of later execution.
      return entry.budget ? 'idle-under-budget' : 'idle-under-budget-late-visible';
    }
  } catch {
    // Missing or unreadable private evidence must not mask the original failure.
  }
  return 'unknown';
}
