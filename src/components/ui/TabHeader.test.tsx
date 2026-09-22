import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { reducedMotionTransition } from 'lib/animation';
import { navigate } from 'lib/woozie';

import TabHeaderDefault, { TabHeader, TabHeaderAction } from './TabHeader';

// TabHeader no longer navigates anywhere — the settings gear moved to the
// bottom nav. The spy stays so the regression tests below can prove the header
// never routes on its own.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockNavigate = navigate as jest.Mock;

// SearchInput (rendered once `search.open` is true) reads `t('clear')` for its
// clear button — stub react-i18next so that doesn't warn about a missing
// instance, same as every other test that renders it.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `AnimatePresence` renders its children directly (no deferred-exit bookkeeping
// to await — jsdom has no real paint/animation-frame clock to drive that
// against). `motion.*` becomes the plain tag it wraps, forwarding a ref and
// every DOM prop, while capturing the animation-only props (`initial`,
// `animate`, `exit`, `transition`) into `motionCaptures` keyed by the
// element's own `data-testid` so a test can inspect what TabHeader asked for
// without a real animation clock. Same shape as the `framer-motion` mock in
// `src/components/Navigator.test.tsx`.
const motionCaptures: Record<string, { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }> =
  {};
let mockReduceMotion = false;

jest.mock('framer-motion', () => {
  const react = require('react');
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get: (_target: unknown, tag: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          react.forwardRef(({ children, initial, animate, exit, transition, ...rest }: any, ref: unknown) => {
            const key = rest['data-testid'] ?? tag;
            motionCaptures[key] = { initial, animate, exit, transition };
            return react.createElement(tag, { ...rest, ref }, children);
          })
      }
    ),
    useReducedMotion: () => mockReduceMotion
  };
});

beforeEach(() => {
  for (const key of Object.keys(motionCaptures)) delete motionCaptures[key];
  mockReduceMotion = false;
});

describe('TabHeader — exports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the same component as the default and named export', () => {
    expect(TabHeaderDefault).toBe(TabHeader);
  });
});

describe('TabHeader — structure & title', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the title inside a single h1 heading with the heading typography classes', () => {
    render(<TabHeader title="Activity" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Activity' });
    expect(heading.tagName).toBe('H1');
    expect(heading.textContent).toBe('Activity');
    expect(heading).toHaveClass('text-title-tab', 'text-ink');
    expect(heading.className).toContain('text-ink');
    expect(heading.className).not.toContain('dark:text-pure-white');
  });

  it('renders the outer element as a <header> with the shared layout classes and no grey rule below it', () => {
    const { container } = render(<TabHeader title="Explore" />);

    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('shrink-0');
    expect(header!.className).toContain('flex');
    expect(header!.className).toContain('items-center');
    expect(header!.className).toContain('justify-between');

    // The 4px grey rule under the title is gone — the header is the last thing rendered.
    expect(header!.nextElementSibling).toBeNull();
  });

  it('reflects whatever title string it is given', () => {
    render(<TabHeader title="A Very Custom Title" />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A Very Custom Title');
  });
});

describe('TabHeader — no built-in settings affordance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders no buttons at all when no actions are supplied', () => {
    // Settings is a bottom-nav destination now; a gear here would duplicate it
    // on exactly the screens (Activity, Explore) that show that tab.
    render(<TabHeader title="Activity" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders no settings-labelled control', () => {
    render(<TabHeader title="Activity" />);

    expect(screen.queryByRole('button', { name: /settings/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
  });

  it('omits the actions container entirely when actions is undefined', () => {
    const { container } = render(<TabHeader title="Activity" />);

    // Only the h1 remains inside the header — no empty flex row left behind.
    const header = container.querySelector('header')!;
    expect(header.children).toHaveLength(1);
    expect(header.children[0]!.tagName).toBe('H1');
  });

  it('never navigates on render', () => {
    render(<TabHeader title="Activity" />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TabHeader — actions slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a caller-supplied action', () => {
    render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action">
            Extra
          </button>
        }
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTestId('extra-action')).toBeTruthy();
  });

  it('accepts multiple action nodes', () => {
    render(
      <TabHeader
        title="Activity"
        actions={
          <>
            <button type="button">One</button>
            <button type="button">Two</button>
          </>
        }
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'One' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Two' })).toBeTruthy();
  });

  it('wraps actions in the spaced flex container', () => {
    const { container } = render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action">
            Extra
          </button>
        }
      />
    );

    const header = container.querySelector('header')!;
    const wrapper = header.children[1]!;
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('items-center');
    expect(wrapper.className).toContain('gap-2');
    expect(wrapper.contains(screen.getByTestId('extra-action'))).toBe(true);
  });

  it('clicking a caller-supplied action runs only that handler and does not navigate', () => {
    const onExtra = jest.fn();
    render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action" onClick={onExtra}>
            Extra
          </button>
        }
      />
    );

    fireEvent.click(screen.getByTestId('extra-action'));

    expect(onExtra).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TabHeaderAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a bare 24px icon in a 44px hit area, with no background circle', () => {
    render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.className).toContain('w-11');
    expect(button.className).toContain('h-11');
    expect(button.className).not.toMatch(/\bbg-/);

    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('class')).toContain('w-6');
    expect(icon!.getAttribute('class')).toContain('h-6');
  });

  it('is ink by default and switches to the accent color when active', () => {
    const { rerender } = render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Search' }).className).toContain('text-ink');

    rerender(<TabHeaderAction label="Search" icon={IconName.Search} active onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.className).toContain('text-accent-primary');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps its accessible label and fires the click + haptic handler', () => {
    const onClick = jest.fn();
    render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.getAttribute('aria-label')).toBe('Search');

    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('TabHeader — search swap animation', () => {
  const search = { open: true, value: '', onChange: jest.fn(), placeholder: 'Search' };

  it('keeps the header at its fixed height whichever side is showing', () => {
    const { container, rerender } = render(<TabHeader title="Activity" />);
    expect(container.querySelector('header')!.className).toContain('h-15');

    rerender(<TabHeader title="Activity" search={search} />);
    expect(container.querySelector('header')!.className).toContain('h-15');
  });

  it('swaps the title for the search field, and back, through one AnimatePresence slot', () => {
    const { rerender } = render(<TabHeader title="Activity" search={{ ...search, open: false }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('tab-header-search')).toBeNull();

    rerender(<TabHeader title="Activity" search={{ ...search, open: true }} />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByTestId('tab-header-search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search')).toBeInTheDocument();

    rerender(<TabHeader title="Activity" search={{ ...search, open: false }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('tab-header-search')).toBeNull();
  });

  it('passes submit, Escape, the URL keyboard and a test id through to the field', () => {
    const onSubmit = jest.fn();
    const onEscape = jest.fn();
    render(
      <TabHeader
        title="Explore"
        search={{ ...search, value: 'miden.xyz', onSubmit, onEscape, inputMode: 'url', 'data-testid': 'field' }}
      />
    );
    const input = screen.getByTestId('field');
    expect(input).toHaveAttribute('inputmode', 'url');
    expect(input).toHaveAttribute('enterkeyhint', 'go');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('forwards a test id to a header action', () => {
    render(
      <TabHeader
        title="Explore"
        actions={<TabHeaderAction label="Search" icon={IconName.Search} onClick={jest.fn()} data-testid="toggle" />}
      />
    );
    expect(screen.getByTestId('toggle')).toHaveAccessibleName('Search');
  });

  it('still autofocuses the search field when it opens', () => {
    render(<TabHeader title="Activity" search={search} />);

    expect(screen.getByPlaceholderText('Search')).toHaveFocus();
  });

  it('opens the title sliding left and the search field growing in from the icon side, on the shared spring, with opacity on its own fade', () => {
    render(<TabHeader title="Activity" search={search} />);

    const captured = motionCaptures['tab-header-search']!;
    expect(captured.initial).toEqual({ opacity: 0, scale: 0.96, x: 6 });
    expect(captured.animate).toEqual({ opacity: 1, scale: 1, x: 0 });
    expect(captured.exit).toEqual({ opacity: 0, scale: 0.96, x: 6 });

    const transition = captured.transition as { default: unknown; opacity: unknown };
    // A spring (has stiffness/damping) drives position + scale; opacity is a
    // separate tween so it doesn't inherit the spring's physics.
    expect(transition.default).toMatchObject({
      type: 'spring',
      stiffness: expect.any(Number),
      damping: expect.any(Number)
    });
    expect(transition.opacity).toMatchObject({ duration: expect.any(Number), ease: expect.anything() });
    expect(transition.default).not.toBe(transition.opacity);
  });

  it('gives the title the mirrored close-side offset', () => {
    render(<TabHeader title="Activity" search={{ ...search, open: false }} />);

    const captured = motionCaptures['tab-header-title']!;
    expect(captured.initial).toEqual({ opacity: 0, x: -6 });
    expect(captured.animate).toEqual({ opacity: 1, x: 0 });
    expect(captured.exit).toEqual({ opacity: 0, x: -6 });
  });

  it('collapses both the spring and the fade to an instant transition under reduced motion', () => {
    mockReduceMotion = true;
    render(<TabHeader title="Activity" search={search} />);

    const transition = motionCaptures['tab-header-search']!.transition as { default: unknown; opacity: unknown };
    expect(transition.default).toEqual(reducedMotionTransition);
    expect(transition.opacity).toEqual(reducedMotionTransition);
  });

  it("the search action's active-color swap animates via the shared color-transition utility, not a snap", () => {
    render(<TabHeaderAction label="Search" icon={IconName.Search} active onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.className).toContain('transition-colors');
    expect(button.className).toMatch(/duration-\d/);
  });
});
