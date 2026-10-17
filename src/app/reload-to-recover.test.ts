import { markReloadToRecover, needsReloadToRecover } from './reload-to-recover';

describe('reload-to-recover', () => {
  it('asks a reload for an error marked as recoverable only by one', () => {
    const startFailure = new Error('wasm start trapped');
    markReloadToRecover(startFailure);
    expect(needsReloadToRecover(startFailure)).toBe(true);
  });

  it('asks no reload for an error nobody marked', () => {
    markReloadToRecover(new Error('wasm start trapped'));
    expect(needsReloadToRecover(new Error('wasm start trapped'))).toBe(false);
  });

  it('cannot mark a value that is not an object, and asks no reload for one', () => {
    markReloadToRecover('wasm start trapped');
    markReloadToRecover(null);
    expect(needsReloadToRecover('wasm start trapped')).toBe(false);
    expect(needsReloadToRecover(null)).toBe(false);
  });
});
