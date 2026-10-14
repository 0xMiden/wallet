interface InspectedPage {
  evalJs(code: string): Promise<unknown>;
}

type NativeTap = (x: number, y: number) => Promise<void>;
interface Projection {
  scale: number;
  x: number;
  y: number;
}
interface Target {
  x: number;
  y: number;
  reachable: boolean;
}
const identityProjection: Projection = { scale: 1, x: 0, y: 0 };

const inspectTarget = `function target(n) {
  if (!n) return { reachable: false };
  const r = n.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  return { x, y, reachable: !n.disabled && r.width > 0 && r.height > 0 &&
    r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight &&
    n.contains(document.elementFromPoint(x, y)) };
}`;

function projectTarget(target: Target, projection: Projection) {
  if (target?.reachable !== true || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error('Native input target is not reachable');
  }
  if (!(projection.scale > 0) || ![projection.scale, projection.x, projection.y].every(Number.isFinite)) {
    throw new Error('Native input projection is invalid');
  }
  const x = Math.round(target.x * projection.scale + projection.x);
  const y = Math.round(target.y * projection.scale + projection.y);
  if (x < 0 || y < 0 || ![x, y].every(Number.isSafeInteger)) {
    throw new Error('Native input projection is invalid');
  }
  return { x, y };
}

export async function physicalHostTap(
  page: InspectedPage,
  selector: string,
  tap: NativeTap,
  projection = identityProjection
): Promise<void> {
  const target = (await page.evalJs(
    `${inspectTarget};return target(document.querySelector(${JSON.stringify(selector)}));`
  )) as Target;
  const { x, y } = projectTarget(target, projection);
  await tap(x, y);
}

export async function unlockWithNativeKeypad(
  page: InspectedPage,
  passcode: string,
  tap: NativeTap,
  projection = identityProjection
): Promise<void> {
  if (!/^\d{6}$/.test(passcode)) throw new Error('Current mobile keypad requires a six-digit credential');
  // Read all keys together so the credential never enters an inspection script or its diagnostics.
  const keys = (await page.evalJs(`${inspectTarget};return Array.from({length:10},(_,digit)=>({
    digit:String(digit),...target(document.querySelector('[data-testid="numpad-'+digit+'"]'))
  }));`)) as Array<Target & { digit: string }>;
  if (keys.length !== 10 || keys.some(key => !key.reachable)) throw new Error('Native keypad is not reachable');
  const targets = Array.from(passcode, digit => {
    const key = keys.find(key => key.digit === digit);
    if (!key) throw new Error('Native keypad is not reachable');
    return projectTarget(key, projection);
  });
  for (const { x, y } of targets) await tap(x, y);
}

export async function lockRetainedRuntime(page: InspectedPage): Promise<void> {
  await page.evalJs(`if (!window.__TEST_INTERCOM__) throw new Error('Test intercom unavailable');
    void window.__TEST_INTERCOM__.request({type:'LOCK_REQUEST'});return null;`);
}
