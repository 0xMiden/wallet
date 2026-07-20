import React, { PropsWithChildren } from 'react';

import { act, renderHook } from '@testing-library/react';

type DialogModule = typeof import('./dialog');

// `dialog.tsx` captures `document.getElementById('root')` into a module-level
// `const rootElement` at *import* time. Everything the module does with the DOM
// (attaching the one-shot close listeners in `waitForEvent`, and dispatching the
// close events) hangs off that captured node. So the element has to exist BEFORE
// the module is first evaluated, and to exercise the null-guard branch we have to
// re-evaluate the module with the node removed. Both require loading the module
// from a fresh registry — the same trick `theme.test.ts` uses for its module-level
// state.
function ensureRoot(present: boolean): void {
  const existing = document.getElementById('root');
  if (present && !existing) {
    const el = document.createElement('div');
    el.id = 'root';
    document.body.appendChild(el);
  } else if (!present && existing) {
    existing.remove();
  }
}

/**
 * Load `dialog.tsx` sharing the test's React instance so its constate provider
 * and hooks can be rendered by `@testing-library/react`. Called once, cached by
 * the normal module registry, with `#root` guaranteed present first.
 */
function loadDialogWithRoot(): DialogModule {
  ensureRoot(true);
  return require('./dialog');
}

/**
 * Load a *fresh* copy of `dialog.tsx` in an isolated registry with `#root`
 * removed, so `rootElement` is captured as `null`. Used only to drive the
 * optional-chaining null branches of the dispatch helpers — these paths touch no
 * React, so the isolated module getting its own React copy is irrelevant.
 */
function loadDialogWithoutRoot(): DialogModule {
  ensureRoot(false);
  let mod!: DialogModule;
  jest.isolateModules(() => {
    mod = require('./dialog');
  });
  return mod;
}

function renderDialogs(mod: DialogModule) {
  const wrapper = ({ children }: PropsWithChildren) => <mod.DialogsProvider>{children}</mod.DialogsProvider>;

  return renderHook(
    () => ({
      alert: mod.useAlert(),
      confirm: mod.useConfirm(),
      params: mod.useModalsParams()
    }),
    { wrapper }
  );
}

describe('lib/ui/dialog', () => {
  describe('with a #root element present (real event flow)', () => {
    let mod: DialogModule;

    beforeAll(() => {
      mod = loadDialogWithRoot();
    });

    it('exposes the constate-derived provider, hooks and dispatch helpers', () => {
      expect(typeof mod.DialogsProvider).toBe('function');
      expect(typeof mod.useAlert).toBe('function');
      expect(typeof mod.useConfirm).toBe('function');
      expect(typeof mod.useModalsParams).toBe('function');
      expect(typeof mod.dispatchAlertClose).toBe('function');
      expect(typeof mod.dispatchConfirmClose).toBe('function');
    });

    it('starts with both modals closed', () => {
      const { result } = renderDialogs(mod);

      expect(result.current.params.alertParams).toEqual({ isOpen: false });
      expect(result.current.params.confirmParams).toEqual({ isOpen: false });
    });

    it('memoises modalsParams while the underlying state is unchanged', () => {
      const { result, rerender } = renderDialogs(mod);

      const first = result.current.params;
      rerender();

      expect(result.current.params).toBe(first);
    });

    it('alert: opens the modal, waits for the close event, then closes it', async () => {
      const { result } = renderDialogs(mod);

      let alertPromise!: Promise<void>;
      let resolved = false;

      act(() => {
        alertPromise = result.current.alert({ title: 'Heads up' }).then(() => {
          resolved = true;
        });
      });

      // Synchronous first setState has flushed: modal is open, promise pending.
      expect(result.current.params.alertParams).toEqual({ title: 'Heads up', isOpen: true });
      expect(resolved).toBe(false);

      await act(async () => {
        mod.dispatchAlertClose();
        await alertPromise;
      });

      // Close event fired -> promise resolved (void) and the modal is marked closed.
      expect(resolved).toBe(true);
      expect(result.current.params.alertParams).toEqual({ title: 'Heads up', isOpen: false });
    });

    it('confirm: resolves true when the close event carries true', async () => {
      const { result } = renderDialogs(mod);

      let confirmPromise!: Promise<boolean>;
      let outcome: boolean | undefined;

      act(() => {
        confirmPromise = result.current.confirm({ title: 'Proceed?' }).then(value => {
          outcome = value;
          return value;
        });
      });

      expect(result.current.params.confirmParams).toEqual({ title: 'Proceed?', isOpen: true });
      expect(outcome).toBeUndefined();

      await act(async () => {
        mod.dispatchConfirmClose(true);
        await confirmPromise;
      });

      expect(outcome).toBe(true);
      expect(result.current.params.confirmParams).toEqual({ title: 'Proceed?', isOpen: false });
    });

    it('confirm: resolves false when the close event carries false', async () => {
      const { result } = renderDialogs(mod);

      let confirmPromise!: Promise<boolean>;
      let outcome: boolean | undefined;

      act(() => {
        confirmPromise = result.current.confirm({ title: 'Delete?' }).then(value => {
          outcome = value;
          return value;
        });
      });

      expect(result.current.params.confirmParams).toEqual({ title: 'Delete?', isOpen: true });

      await act(async () => {
        mod.dispatchConfirmClose(false);
        await confirmPromise;
      });

      expect(outcome).toBe(false);
      expect(result.current.params.confirmParams).toEqual({ title: 'Delete?', isOpen: false });
    });

    it('removes the one-shot listener so a second dispatch does not re-resolve', async () => {
      const { result } = renderDialogs(mod);

      let alertPromise!: Promise<void>;
      let resolveCount = 0;

      act(() => {
        alertPromise = result.current.alert({ title: 'Once' }).then(() => {
          resolveCount += 1;
        });
      });

      await act(async () => {
        mod.dispatchAlertClose();
        await alertPromise;
      });

      // The listener detached itself on first fire; a stray dispatch is inert.
      await act(async () => {
        mod.dispatchAlertClose();
      });

      expect(resolveCount).toBe(1);
    });
  });

  describe('without a #root element (null-guard branches)', () => {
    afterAll(() => {
      // Restore the shared jsdom root so nothing after this suite is affected.
      ensureRoot(true);
    });

    it('dispatch helpers are inert no-ops when rootElement was captured as null', () => {
      const mod = loadDialogWithoutRoot();

      expect(document.getElementById('root')).toBeNull();
      expect(() => mod.dispatchAlertClose()).not.toThrow();
      expect(() => mod.dispatchConfirmClose(true)).not.toThrow();
      expect(() => mod.dispatchConfirmClose(false)).not.toThrow();
    });
  });
});
