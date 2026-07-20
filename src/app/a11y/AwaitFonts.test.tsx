import React, { Suspense } from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import { SWRConfig } from 'swr';

import AwaitFonts from './AwaitFonts';

// `AwaitFonts` drives its font-load gate through `useSWR({ suspense: true })`,
// so every render must sit inside a Suspense boundary. We also give each render
// its own fresh SWR cache (`provider: () => new Map()`) so the async fetcher
// actually re-runs per test instead of being served from a shared cache — that
// is what lets us assert the `awaitFonts` side effects (body classes, the
// Font Loading API calls, and the console.error catch path).

/**
 * jsdom does not implement the CSS Font Loading API, so `document.fonts` is
 * `undefined` by default. Each test installs (or clears) it explicitly to steer
 * the `document.fonts && typeof document.fonts.load === 'function'` guard.
 */
function setDocumentFonts(value: unknown) {
  Object.defineProperty(document, 'fonts', {
    value,
    configurable: true,
    writable: true
  });
}

function clearDocumentFonts() {
  // Restore the jsdom default (property absent → `document.fonts` is undefined).
  delete (document as unknown as { fonts?: unknown }).fonts;
}

function renderAwaitFonts(props: {
  name: string;
  weights: number[];
  className?: string;
  childTestId?: string;
}) {
  const childTestId = props.childTestId ?? 'child';
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Suspense fallback={<div data-testid="fallback">loading</div>}>
        <AwaitFonts name={props.name} weights={props.weights} className={props.className}>
          <div data-testid={childTestId}>content</div>
        </AwaitFonts>
      </Suspense>
    </SWRConfig>
  );
}

describe('AwaitFonts', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    clearDocumentFonts();
    // Body classes are a global side effect of `applyClass`; reset between tests.
    document.body.className = '';
  });

  it('loads every requested weight via the Font Loading API, applies the class names, and renders its children', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    setDocumentFonts({ load });

    renderAwaitFonts({ name: 'Inter', weights: [400, 700], className: 'font-loaded is-ready' });

    // Children only appear once the suspense promise (the fetcher) resolves.
    expect(await screen.findByTestId('child')).toHaveTextContent('content');
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument();

    // One `document.fonts.load` call per weight, in the exact spec string format.
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith('400 1em "Inter"');
    expect(load).toHaveBeenCalledWith('700 1em "Inter"');

    // applyClass split the className on spaces and added each token to <body>.
    expect(document.body).toHaveClass('font-loaded');
    expect(document.body).toHaveClass('is-ready');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('swallows a Font Loading API rejection, logs it, and still resolves so children render', async () => {
    const error = new Error('cdn timeout');
    const load = jest.fn().mockRejectedValue(error);
    setDocumentFonts({ load });

    renderAwaitFonts({ name: 'Roboto', weights: [500], className: 'fonts-done' });

    // Even though `document.fonts.load` rejected, `awaitFonts` catches it, so the
    // suspense promise resolves and the subtree still mounts.
    expect(await screen.findByTestId('child')).toBeInTheDocument();

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith(error));
    // The class is still applied after the caught failure.
    expect(document.body).toHaveClass('fonts-done');
  });

  it('skips the Font Loading API entirely when document.fonts is unavailable', async () => {
    // jsdom default: `document.fonts` is undefined → the guard short-circuits.
    clearDocumentFonts();

    renderAwaitFonts({ name: 'Inter', weights: [400], className: 'no-font-api' });

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(document.body).toHaveClass('no-font-api');
  });

  it('skips the Font Loading API when document.fonts exists but load is not a function', async () => {
    // Exercises the `typeof document.fonts.load === 'function'` false branch
    // while `document.fonts` itself is truthy.
    setDocumentFonts({ load: 'not-a-function' });

    renderAwaitFonts({ name: 'Inter', weights: [400, 900], className: 'partial-font-api' });

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(document.body).toHaveClass('partial-font-api');
  });

  it('adds no body classes when className is omitted (uses empty-string key)', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    setDocumentFonts({ load });
    const before = document.body.className;

    // No className prop → `className ?? ''` falls back to '' in the SWR key and
    // applyClass produces an empty token list (nothing added to <body>).
    renderAwaitFonts({ name: 'Inter', weights: [400] });

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(document.body.className).toBe(before);
    expect(load).toHaveBeenCalledWith('400 1em "Inter"');
  });

  it('adds no body classes when className is only whitespace', async () => {
    setDocumentFonts({ load: jest.fn().mockResolvedValue(undefined) });
    const before = document.body.className;

    // '   '.split(' ').filter(Boolean) === [] → applyClass takes the length===0
    // branch and never calls classList.add.
    renderAwaitFonts({ name: 'Inter', weights: [300], className: '   ' });

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(document.body.className).toBe(before);
  });

  it('handles an empty weights array (no load calls) and still renders + applies class', async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    setDocumentFonts({ load });

    renderAwaitFonts({ name: 'Inter', weights: [], className: 'no-weights' });

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(document.body).toHaveClass('no-weights');
  });
});
