import React from 'react';

import { render, screen } from '@testing-library/react';

import Portal from './Portal';

/**
 * The Portal renders its children directly inside a bare host <div> that it
 * appends to <document.body>. So the child's `parentElement` IS that host div,
 * which lets us assert on the host without depending on how @testing-library
 * mounts its own container.
 */
const hostOf = (el: HTMLElement) => el.parentElement as HTMLElement;

describe('Portal', () => {
  it('renders children into a bare div appended directly to document.body', () => {
    render(
      <Portal>
        <span data-testid="portal-content">Hello portal</span>
      </Portal>
    );

    const content = screen.getByTestId('portal-content');
    expect(content).toBeInTheDocument();
    expect(content).toHaveTextContent('Hello portal');

    const host = hostOf(content);
    expect(host.tagName).toBe('DIV');
    // The host is a direct child of <body> (that's where the effect appends it).
    expect(host.parentElement).toBe(document.body);
    expect(document.body.contains(content)).toBe(true);
  });

  it('removes the portal host element from document.body on unmount', () => {
    const { unmount } = render(
      <Portal>
        <span data-testid="portal-content">Bye portal</span>
      </Portal>
    );

    const host = hostOf(screen.getByTestId('portal-content'));
    expect(document.body.contains(host)).toBe(true);

    unmount();

    // The effect cleanup removes the portal host div from <body>.
    expect(document.body.contains(host)).toBe(false);
    expect(screen.queryByTestId('portal-content')).not.toBeInTheDocument();
  });

  it('reuses the same memoized host across re-renders (effect not re-run)', () => {
    const appendSpy = jest.spyOn(document.body, 'appendChild');
    const removeSpy = jest.spyOn(document.body, 'removeChild');

    try {
      const { rerender } = render(
        <Portal>
          <span data-testid="portal-content">First</span>
        </Portal>
      );

      const host = hostOf(screen.getByTestId('portal-content'));
      const appendsAfterMount = appendSpy.mock.calls.length;
      expect(appendsAfterMount).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('portal-content')).toHaveTextContent('First');

      // Re-render with different children: the memoized host div must be
      // reused, so the effect does not re-run — no further append/remove of
      // the host, and the same DOM node keeps hosting the content.
      rerender(
        <Portal>
          <span data-testid="portal-content">Second</span>
        </Portal>
      );

      const hostAfterRerender = hostOf(screen.getByTestId('portal-content'));
      expect(hostAfterRerender).toBe(host);
      expect(appendSpy.mock.calls.length).toBe(appendsAfterMount);
      expect(removeSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('portal-content')).toHaveTextContent('Second');
    } finally {
      appendSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('creates a distinct host element for each mounted Portal instance', () => {
    render(
      <>
        <Portal>
          <span data-testid="portal-a">A</span>
        </Portal>
        <Portal>
          <span data-testid="portal-b">B</span>
        </Portal>
      </>
    );

    const hostA = hostOf(screen.getByTestId('portal-a'));
    const hostB = hostOf(screen.getByTestId('portal-b'));

    // Each instance memoizes its own createElement('div') host.
    expect(hostA).not.toBe(hostB);
    expect(hostA.parentElement).toBe(document.body);
    expect(hostB.parentElement).toBe(document.body);
  });
});
