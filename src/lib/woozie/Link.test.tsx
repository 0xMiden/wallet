/**
 * @jest-environment jsdom
 */
import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { changeState, HistoryAction } from 'lib/woozie/history';

import Link from './Link';

// Mock dependencies
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/woozie/location', () => ({
  useLocation: () => ({
    pathname: '/',
    search: '',
    hash: ''
  }),
  createLocationUpdates: (to: any) => {
    if (typeof to === 'string') return { pathname: to, search: '', hash: '' };
    if (typeof to === 'function') return to({ pathname: '/', search: '', hash: '' });
    return to;
  }
}));

jest.mock('lib/woozie/history', () => ({
  createUrl: (pathname: string = '/', search: string = '', hash: string = '') => {
    let url = pathname;
    if (search) url += search.startsWith('?') ? search : `?${search}`;
    if (hash) url += hash.startsWith('#') ? hash : `#${hash}`;
    return url;
  },
  changeState: jest.fn(),
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' }
}));

describe('Link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an anchor element', () => {
    render(<Link to="/test">Click me</Link>);

    const link = screen.getByText('Click me');
    expect(link.tagName).toBe('A');
  });

  it('sets href attribute based on destination', () => {
    render(<Link to="/about">About</Link>);

    const link = screen.getByText('About');
    expect(link.getAttribute('href')).toContain('/about');
  });

  it('calls changeState on click', () => {
    render(<Link to="/new-page">Go</Link>);

    fireEvent.click(screen.getByText('Go'));

    expect(changeState).toHaveBeenCalled();
  });

  it('triggers haptic feedback on click', () => {
    render(<Link to="/test">Click</Link>);

    fireEvent.click(screen.getByText('Click'));

    expect(hapticLight).toHaveBeenCalled();
  });

  it('uses Replace action when replace prop is true', () => {
    render(
      <Link to="/replaced" replace>
        Replace
      </Link>
    );

    fireEvent.click(screen.getByText('Replace'));

    expect(changeState).toHaveBeenCalledWith(HistoryAction.Replace, undefined, expect.any(String));
  });

  it('uses Push action by default for different URL', () => {
    render(<Link to="/new-url">Push</Link>);

    fireEvent.click(screen.getByText('Push'));

    expect(changeState).toHaveBeenCalledWith(HistoryAction.Push, undefined, expect.any(String));
  });

  it('handles object destination', () => {
    render(<Link to={{ pathname: '/page', search: '?q=test' }}>Object To</Link>);

    const link = screen.getByText('Object To');
    expect(link.getAttribute('href')).toContain('/page');
  });

  it('handles function destination', () => {
    const toFn = (loc: any) => ({ pathname: loc.pathname + '/child' });
    render(<Link to={toFn}>Function To</Link>);

    const link = screen.getByText('Function To');
    expect(link.getAttribute('href')).toContain('/child');
  });

  it('calls custom onClick handler', () => {
    const handleClick = jest.fn();
    render(
      <Link to="/test" onClick={handleClick}>
        Custom Click
      </Link>
    );

    fireEvent.click(screen.getByText('Custom Click'));

    expect(handleClick).toHaveBeenCalled();
  });

  it('does not navigate when onClick prevents default', () => {
    const handleClick = jest.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <Link to="/test" onClick={handleClick}>
        Prevented
      </Link>
    );

    fireEvent.click(screen.getByText('Prevented'));

    expect(changeState).not.toHaveBeenCalled();
  });

  it('ignores right clicks', () => {
    render(<Link to="/test">Right Click</Link>);

    fireEvent.click(screen.getByText('Right Click'), { button: 2 });

    expect(changeState).not.toHaveBeenCalled();
  });

  it('ignores modified clicks (ctrl key)', () => {
    render(<Link to="/test">Ctrl Click</Link>);

    fireEvent.click(screen.getByText('Ctrl Click'), { ctrlKey: true });

    expect(changeState).not.toHaveBeenCalled();
  });

  it('ignores modified clicks (meta key)', () => {
    render(<Link to="/test">Meta Click</Link>);

    fireEvent.click(screen.getByText('Meta Click'), { metaKey: true });

    expect(changeState).not.toHaveBeenCalled();
  });

  it('ignores modified clicks (alt key)', () => {
    render(<Link to="/test">Alt Click</Link>);

    fireEvent.click(screen.getByText('Alt Click'), { altKey: true });

    expect(changeState).not.toHaveBeenCalled();
  });

  it('ignores modified clicks (shift key)', () => {
    render(<Link to="/test">Shift Click</Link>);

    fireEvent.click(screen.getByText('Shift Click'), { shiftKey: true });

    expect(changeState).not.toHaveBeenCalled();
  });

  it('does not navigate when target is _blank', () => {
    render(
      <Link to="/test" target="_blank">
        New Tab
      </Link>
    );

    fireEvent.click(screen.getByText('New Tab'));

    expect(changeState).not.toHaveBeenCalled();
  });

  it('passes additional props to anchor', () => {
    render(
      <Link to="/test" className="my-link" data-testid="my-link">
        Styled Link
      </Link>
    );

    const link = screen.getByTestId('my-link');
    expect(link).toHaveClass('my-link');
  });
});
