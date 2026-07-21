import { resolveRootView } from './root-view';

describe('resolveRootView — MV3 cold-start gating', () => {
  it('shows loading (NOT onboarding) before the backend has responded', () => {
    // Popup just opened, MV3 service worker is cold-starting, no GetStateResponse
    // yet → status is the initial Idle and hydrated is false. This is the bug
    // window: it must render the loading spinner, never the restore-from-seed flow.
    expect(resolveRootView({ locked: false, ready: false, hydrated: false })).toBe('loading');
  });

  it('shows onboarding only after the backend confirms there is no wallet', () => {
    // Hydrated + still Idle = backend actually reported vaultExist=false → new user.
    expect(resolveRootView({ locked: false, ready: false, hydrated: true })).toBe('welcome');
  });

  it('shows unlock for an existing locked vault', () => {
    expect(resolveRootView({ locked: true, ready: false, hydrated: true })).toBe('unlock');
  });

  it('never shows onboarding for a locked vault even mid-hydration', () => {
    // Defensive: a Locked status only ever comes from the backend, so hydrated is
    // implicitly true, but assert unlock wins regardless.
    expect(resolveRootView({ locked: true, ready: false, hydrated: false })).toBe('unlock');
  });

  it('shows the app once ready', () => {
    expect(resolveRootView({ locked: false, ready: true, hydrated: true })).toBe('app');
  });
});
