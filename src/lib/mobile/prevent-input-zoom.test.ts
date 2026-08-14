/**
 * @jest-environment jsdom
 */
import { PREVENT_INPUT_ZOOM_SCRIPT } from './prevent-input-zoom';

// Execute the injected script the way the WKWebView runs it (a self-contained
// IIFE string). `new Function` evaluates it in global scope where `window` and
// `document` resolve to the jsdom globals — the same shape the real WebView sees.
function runInjectedScript(): void {
  // Deliberately runs the shipped injected string as the WKWebView would, so the
  // test exercises the real code, not a paraphrase.
  // eslint-disable-next-line no-new-func
  new Function(PREVENT_INPUT_ZOOM_SCRIPT)();
}

function viewportContent(): string {
  return document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
}

describe('PREVENT_INPUT_ZOOM_SCRIPT (#503 — iOS faucet WebView input zoom)', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    delete (window as unknown as { __preventInputZoomInjected?: boolean }).__preventInputZoomInjected;
  });

  it('adds a zoom-locking viewport meta when the page has none', () => {
    expect(document.querySelector('meta[name="viewport"]')).toBeNull();

    runInjectedScript();

    const meta = document.querySelector('meta[name="viewport"]');
    expect(meta).not.toBeNull();
    const content = viewportContent();
    expect(content).toContain('width=device-width');
    // maximum-scale=1 is what stops iOS from auto-zooming (and sticking) when a
    // sub-16px input gains focus — WKWebView honours it (unlike mobile Safari).
    expect(content).toContain('maximum-scale=1');
  });

  it('adds maximum-scale in place while preserving other page directives', () => {
    const existing = document.createElement('meta');
    existing.setAttribute('name', 'viewport');
    // A notched-device viewport (the tester was on an iPhone 14) that must survive.
    existing.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    document.head.appendChild(existing);

    runInjectedScript();

    const metas = document.querySelectorAll('meta[name="viewport"]');
    expect(metas).toHaveLength(1); // rewritten in place, not duplicated
    const content = viewportContent();
    expect(content).toContain('maximum-scale=1');
    expect(content).toContain('viewport-fit=cover'); // page directive preserved
    expect(content).toContain('initial-scale=1');
  });

  it('does not disable pinch zoom-out (no user-scalable=no)', () => {
    runInjectedScript();
    expect(viewportContent()).not.toContain('user-scalable=no');
  });

  it('does not latch the guard when there is no <head> yet, so a later injection still applies', () => {
    // Simulate the script running before the document has a <head>.
    const head = document.head;
    head.parentNode!.removeChild(head);
    expect(document.head).toBeNull();

    runInjectedScript();
    // The latch must NOT be set — otherwise a later, effective injection would be
    // permanently suppressed (the reviewed ordering bug).
    expect(
      (window as unknown as { __preventInputZoomInjected?: boolean }).__preventInputZoomInjected
    ).toBeUndefined();

    // Once <head> exists, a re-injection applies the viewport lock.
    document.documentElement.appendChild(document.createElement('head'));
    runInjectedScript();
    expect(viewportContent()).toContain('maximum-scale=1');
  });

  it('guards against re-processing so a later page viewport change is not clobbered', () => {
    runInjectedScript();
    expect((window as unknown as { __preventInputZoomInjected?: boolean }).__preventInputZoomInjected).toBe(true);

    // Simulate the faucet mutating its own viewport AFTER our one-shot injection.
    document.querySelector('meta[name="viewport"]')!.setAttribute('content', 'width=device-width, initial-scale=2');
    runInjectedScript(); // the guard must short-circuit — no re-enforcement

    // Without the guard the second run would re-append maximum-scale=1; with it,
    // the page's later value stands. This is what actually exercises the latch
    // (in-place selector dedupe alone would not).
    expect(viewportContent()).not.toContain('maximum-scale=1');
  });
});
