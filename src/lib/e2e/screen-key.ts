export type ScreenState = { key: string; seq: number };

export const SCREEN_PUSH_DEBOUNCE_MS = 150;

type Parts = { route?: string | null; card?: string | null; overlay?: string | null };

export function composeScreenKey(parts: Parts): string {
  return [parts.route, parts.card, parts.overlay].filter((p): p is string => !!p).join(' > ');
}

let routePart: string | null = null;
let cardPart: string | null = null;
const overlayStack: string[] = [];
let current: ScreenState = { key: '', seq: 0 };
let pushTimer: ReturnType<typeof setTimeout> | null = null;

type GlobalWithScreen = typeof globalThis & { __TEST_SCREEN__?: ScreenState };
type WindowWithPush = typeof window & { __e2eScreenChanged?: (key: string, seq: number) => void };

function enabled(): boolean {
  return process.env.MIDEN_E2E_TEST === 'true';
}

function scheduleChromePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const w = (typeof window !== 'undefined' ? window : undefined) as WindowWithPush | undefined;
    w?.__e2eScreenChanged?.(current.key, current.seq);
  }, SCREEN_PUSH_DEBOUNCE_MS);
}

function recomputeAndPublish(): void {
  if (!enabled()) return;
  const key = composeScreenKey({
    route: routePart,
    card: cardPart,
    overlay: overlayStack[overlayStack.length - 1] ?? null
  });
  if (key === current.key) return;
  current = { key, seq: current.seq + 1 };
  (globalThis as GlobalWithScreen).__TEST_SCREEN__ = current;
  scheduleChromePush();
}

export function setRoutePart(value: string | null): void {
  routePart = value || null;
  recomputeAndPublish();
}

export function setCardPart(value: string | null): void {
  cardPart = value || null;
  recomputeAndPublish();
}

export function pushOverlay(id: string): void {
  if (!id) return;
  overlayStack.push(id);
  recomputeAndPublish();
}

export function popOverlay(id: string): void {
  const idx = overlayStack.lastIndexOf(id);
  if (idx >= 0) overlayStack.splice(idx, 1);
  recomputeAndPublish();
}

export function getCurrentScreen(): ScreenState {
  return current;
}

export function __resetScreenKeyForTest(): void {
  routePart = null;
  cardPart = null;
  overlayStack.length = 0;
  current = { key: '', seq: 0 };
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  delete (globalThis as GlobalWithScreen).__TEST_SCREEN__;
}
