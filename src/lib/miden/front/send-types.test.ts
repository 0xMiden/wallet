// `send-types.ts` is a type-only module: it exports a single TypeScript
// `type ConfirmStatus` and contains no runtime code (types are erased at
// compile time). There are no functions, components, or hooks to invoke.
//
// To still exercise the module in the coverage graph and lock the shape of
// the exported type, we side-effect import the module (forcing it into the
// module graph / instrumentation) and assert that representative values
// satisfy `ConfirmStatus` at both compile time and runtime.

import './send-types';

import type { ConfirmStatus } from './send-types';

describe('send-types', () => {
  it('module imports without side effects (type-only module)', async () => {
    const mod = await import('./send-types');
    // A type-only module transpiles to an empty runtime object — no
    // runtime exports should leak out of it.
    expect(Object.keys(mod)).toHaveLength(0);
  });

  it('accepts a fully confirmed + delegated status', () => {
    const status: ConfirmStatus = { confirmed: true, delegated: true };
    expect(status.confirmed).toBe(true);
    expect(status.delegated).toBe(true);
  });

  it('accepts an unconfirmed + non-delegated status', () => {
    const status: ConfirmStatus = { confirmed: false, delegated: false };
    expect(status.confirmed).toBe(false);
    expect(status.delegated).toBe(false);
  });

  it('accepts mixed confirmed/delegated combinations', () => {
    const combos: ConfirmStatus[] = [
      { confirmed: true, delegated: false },
      { confirmed: false, delegated: true }
    ];

    for (const status of combos) {
      expect(typeof status.confirmed).toBe('boolean');
      expect(typeof status.delegated).toBe('boolean');
      // exactly the two documented keys, nothing more
      expect(Object.keys(status).sort()).toEqual(['confirmed', 'delegated']);
    }
  });
});
