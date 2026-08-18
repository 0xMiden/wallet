import * as path from 'path';

export function screenShotName(seq: number, key: string, label: string): string {
  const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
  const padded = String(seq).padStart(3, '0');
  return `screen-${padded}-${slug}-wallet-${label.toLowerCase()}.png`;
}

export async function captureBestEffort(
  grab: (path: string) => Promise<void>,
  dir: string,
  seq: number,
  key: string,
  label: string
): Promise<void> {
  try {
    await grab(path.join(dir, screenShotName(seq, key, label)));
  } catch {
    // best-effort: page/context may be mid-navigation or torn down
  }
}

export function startScreenPoll(opts: {
  intervalMs: number;
  read: () => Promise<{ key: string; seq: number } | null>;
  grab: (path: string) => Promise<void>;
  dir: string;
  label: string;
}): { stop: () => void } {
  let lastSeq = -1;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await opts.read();
      if (s && s.seq !== lastSeq) {
        lastSeq = s.seq;
        await captureBestEffort(opts.grab, opts.dir, s.seq, s.key, opts.label);
      }
    } catch {
      // ignore a single bad read
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
