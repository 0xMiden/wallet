import { installLandedTrapRetirement, retireLandedTrap, retiringLandedTraps } from './landed-trap-retirement';
import { bumpWasmClientGeneration, WasmClientPoisonedError } from './wasm-client-poison';

// The leaf's state is module scope and shared by every test here, so each test uses its own landing.
describe('landed-trap retirement', () => {
  let retire: jest.Mock;
  let restore: () => void;

  beforeEach(() => {
    retire = jest.fn();
    restore = installLandedTrapRetirement(retire);
  });

  afterEach(() => {
    restore();
  });

  it('retires once per landing however many traps its readers answer', () => {
    const first = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(first, 'row-once', undefined);
    retireLandedTrap(new WebAssembly.RuntimeError('unreachable'), 'row-once', undefined);
    expect(retire.mock.calls).toEqual([[first, 'row-once']]);
  });

  it('answers anything but a trap with no retire and leaves the landing open', () => {
    retireLandedTrap(new Error('ordinary'), 'row-open', undefined);
    retireLandedTrap(new WasmClientPoisonedError('watchdog'), 'row-open', undefined);
    expect(retire).not.toHaveBeenCalled();
    const trap = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(trap, 'row-open', undefined);
    expect(retire.mock.calls).toEqual([[trap, 'row-open']]);
  });

  it('retires nothing for a result read before the client was replaced, and leaves the landing open', async () => {
    const stale = {};
    await retiringLandedTraps('row-stale', stale, async () => {
      bumpWasmClientGeneration();
      retireLandedTrap(new WebAssembly.RuntimeError('unreachable'), 'row-stale', stale);
    });
    expect(retire).not.toHaveBeenCalled();
    const fresh = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(fresh, 'row-stale', undefined);
    expect(retire.mock.calls).toEqual([[fresh, 'row-stale']]);
  });

  it('reads a result no tail recorded as read under the current client', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(trap, 'row-unrecorded', {});
    expect(retire.mock.calls).toEqual([[trap, 'row-unrecorded']]);
  });

  it('keeps the generation a result was first recorded at', async () => {
    const result = {};
    const trap = new WebAssembly.RuntimeError('unreachable');
    await retiringLandedTraps('row-first', result, async () => {
      bumpWasmClientGeneration();
      await retiringLandedTraps('row-first', result, async () => {
        retireLandedTrap(trap, 'row-first', result);
      });
    });
    expect(retire).not.toHaveBeenCalled();
  });

  it('retires a trap that leaves the tail and rethrows that same object', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    await expect(
      retiringLandedTraps('row-tail', {}, async () => {
        throw trap;
      })
    ).rejects.toBe(trap);
    expect(retire.mock.calls).toEqual([[trap, 'row-tail']]);
  });

  it('passes a value through and rethrows an ordinary failure with no retire', async () => {
    await expect(retiringLandedTraps('row-pass', {}, async () => 'value')).resolves.toBe('value');
    const failure = new Error('ordinary');
    await expect(
      retiringLandedTraps('row-pass', {}, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(retire).not.toHaveBeenCalled();
  });

  it('answers with no retirement installed', () => {
    restore();
    const trap = new WebAssembly.RuntimeError('unreachable');
    expect(() => retireLandedTrap(trap, 'row-none', undefined)).not.toThrow();
    expect(retire).not.toHaveBeenCalled();
  });

  it('restores the previous retirement only while its own is current', () => {
    const a = jest.fn();
    const b = jest.fn();
    const restoreA = installLandedTrapRetirement(a);
    const restoreB = installLandedTrapRetirement(b);

    restoreA();
    const first = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(first, 'row-restore-b', undefined);
    expect(b.mock.calls).toEqual([[first, 'row-restore-b']]);

    restoreB();
    const second = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(second, 'row-restore-a', undefined);
    expect(a.mock.calls).toEqual([[second, 'row-restore-a']]);

    restoreA();
    const third = new WebAssembly.RuntimeError('unreachable');
    retireLandedTrap(third, 'row-restore-suite', undefined);
    expect(retire.mock.calls).toEqual([[third, 'row-restore-suite']]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
