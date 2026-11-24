import { physicalHostTap, unlockWithNativeKeypad } from './native-input';

// eslint-disable-next-line no-new-func -- Execute the real inspection body against this DOM.
const page = { evalJs: async <T>(code: string): Promise<T> => new Function(code)() as T };
const rect = { x: 10, y: 20, width: 44, height: 48, top: 20, bottom: 68, left: 10, right: 54, toJSON: () => ({}) };

beforeEach(() => {
  document.body.innerHTML = '<button id="control">Control</button>';
  document.querySelector('button')!.getBoundingClientRect = () => rect;
  document.elementFromPoint = jest.fn(() => document.querySelector('button'));
});

test('projects a fresh reachable control into native coordinates without a DOM click', async () => {
  const tap = jest.fn(async () => {});
  const clicked = jest.fn();
  document.querySelector('button')!.addEventListener('click', clicked);
  await physicalHostTap(page, '#control', tap, { scale: 2, x: 3, y: 7 });
  expect(tap).toHaveBeenCalledWith(67, 95);
  expect(clicked).not.toHaveBeenCalled();
});

test.each(['occluded', 'disabled', 'outside'])('refuses a %s control before native input', async reason => {
  const tap = jest.fn();
  if (reason === 'occluded') document.elementFromPoint = jest.fn(() => document.body);
  if (reason === 'disabled') document.querySelector('button')!.disabled = true;
  if (reason === 'outside') document.querySelector('button')!.getBoundingClientRect = () => ({ ...rect, y: -100 });
  await expect(physicalHostTap(page, '#control', tap)).rejects.toThrow('not reachable');
  expect(tap).not.toHaveBeenCalled();
});

test('keypad sends six physical taps with no passcode in evaluated scripts or navigation', async () => {
  const code = Array.from({ length: 6 }, (_, i) => String(i)).join('');
  const scripts: string[] = [];
  const keypad = Array.from({ length: 10 }, (_, digit) => ({
    digit: String(digit),
    x: digit + 20,
    y: 40,
    reachable: true
  }));
  const fake = {
    evalJs: jest.fn(async (script: string) => {
      scripts.push(script);
      return keypad;
    })
  };
  const tap = jest.fn(async () => {});
  await unlockWithNativeKeypad(fake, code, tap);
  expect(tap).toHaveBeenCalledTimes(6);
  expect(scripts.join('')).not.toContain(code);
  expect(scripts.join('')).not.toMatch(/location|navigate|click\(/);
});

test('incompatible credential or blocked keypad issues no native input', async () => {
  const tap = jest.fn();
  await expect(unlockWithNativeKeypad(page, 'incompatible', tap)).rejects.toThrow('six-digit');
  const blocked = { evalJs: jest.fn(async () => []) };
  await expect(unlockWithNativeKeypad(blocked, String(0).repeat(6), tap)).rejects.toThrow('not reachable');
  expect(tap).not.toHaveBeenCalled();
});

test.each([
  { scale: 0, x: 0, y: 0 },
  { scale: 1, x: Number.NaN, y: 0 },
  { scale: Number.MAX_VALUE, x: 0, y: 0 },
  { scale: 1, x: -100, y: 0 }
])('refuses invalid native projection %j without native input', async projection => {
  const tap = jest.fn();
  await expect(physicalHostTap(page, '#control', tap, projection)).rejects.toThrow('projection is invalid');
  expect(tap).not.toHaveBeenCalled();
});

test('preflights the complete keypad before any credential tap', async () => {
  const keypad = Array.from({ length: 10 }, (_, digit) => ({
    digit: String(digit),
    x: digit === 5 ? Number.NaN : digit + 20,
    y: 40,
    reachable: true
  }));
  const inspected = { evalJs: jest.fn(async () => keypad) };
  const tap = jest.fn();
  const code = Array.from({ length: 6 }, (_, i) => String(i)).join('');
  await expect(unlockWithNativeKeypad(inspected, code, tap)).rejects.toThrow('not reachable');
  expect(tap).not.toHaveBeenCalled();
});
