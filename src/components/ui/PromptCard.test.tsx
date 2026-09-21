import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

import { PromptCard } from './PromptCard';

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { Checkmark: 'Checkmark', ChevronRight: 'ChevronRight', Close: 'Close', Loader: 'Loader' }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// framer-motion reads the OS preference through useReducedMotion; drive it from
// the test so the looping funding animations can be asserted both ways. The
// motion elements render as their plain tag and publish whether they were asked
// to LOOP - jsdom applies real transforms asynchronously, so inline style is not
// an observable a test can rely on.
let mockReduceMotion = false;
jest.mock('framer-motion', () => {
  const react = require('react');
  return {
    useReducedMotion: () => mockReduceMotion,
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({ children, animate, initial, transition, ...rest }: Record<string, unknown>) =>
            react.createElement(
              tag,
              {
                ...rest,
                'data-loops': String((transition as { repeat?: number } | undefined)?.repeat === Infinity)
              },
              children
            )
      }
    )
  };
});

describe('PromptCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
  });

  it('runs the card action when its content is clicked', () => {
    const onClick = jest.fn();
    render(<PromptCard title="Fund your wallet" onClick={onClick} />);

    fireEvent.click(screen.getByText('Fund your wallet'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('exposes the card action as a real button, so the platform gives it keyboard activation', () => {
    const onClick = jest.fn();
    render(<PromptCard title="Fund your wallet" onClick={onClick} />);

    // A native <button> activates on Enter/Space without a keydown handler.
    // jsdom does not synthesize that click, so assert the element type that
    // earns the behaviour, then that activating it runs the card action.
    const action = screen.getByRole('button', { name: /Fund your wallet/ });
    expect(action.tagName).toBe('BUTTON');

    fireEvent.click(action);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is not focusable when the card has no action', () => {
    render(<PromptCard title="Fund your wallet" />);

    // Assert the PROPERTY, not one obsolete shape of it: a `div[tabindex]`
    // qualifier matched nothing in either configuration once the card action
    // became a real button, so it could not detect a regression. A card with no
    // action has no dismiss and no CTA either, so zero focusables is exact.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Fund your wallet').closest('[tabindex]')).toBeNull();
  });

  it('keeps the dismiss and CTA controls outside the card-action button', () => {
    const onClick = jest.fn();
    const onDismiss = jest.fn();
    const onAction = jest.fn();
    render(
      <PromptCard
        title="Fund your wallet"
        onClick={onClick}
        onDismiss={onDismiss}
        actionLabel="Fund now"
        onAction={onAction}
      />
    );

    // ARIA gives the button role presentational children: nesting these inside
    // the card action would stop assistive tech exposing them at all.
    const action = screen.getByRole('button', { name: /Fund your wallet/ });
    const dismiss = screen.getByRole('button', { name: 'promptCardDismiss' });
    const cta = screen.getByRole('button', { name: 'Fund now' });

    expect(action.contains(dismiss)).toBe(false);
    expect(action.contains(cta)).toBe(false);
    // …and no ancestor re-flattens them by claiming the button role either.
    expect(dismiss.closest('[role="button"]')).toBeNull();
    expect(cta.closest('[role="button"]')).toBeNull();
  });

  it('runs the CTA exactly once without bubbling to the card action', () => {
    const onClick = jest.fn();
    const onAction = jest.fn();
    render(<PromptCard title="Fund your wallet" onClick={onClick} actionLabel="Fund now" onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fund now' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('dismisses without invoking either card action', () => {
    const onClick = jest.fn();
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    render(
      <PromptCard
        title="Fund your wallet"
        onClick={onClick}
        actionLabel="Fund now"
        onAction={onAction}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'promptCardDismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not invoke a disabled CTA', () => {
    const onAction = jest.fn();
    render(<PromptCard title="Fund your wallet" actionLabel="Fund now" onAction={onAction} actionDisabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Fund now' }));

    expect(onAction).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', 'promptCardLoading', 'Loader'],
    ['success', 'success', 'Checkmark'],
    ['failure', 'failed', 'Close']
  ] as const)('renders the %s status indicator', (status, label, icon) => {
    render(<PromptCard title="Fund your wallet" status={status} />);

    expect(screen.getByRole('status', { name: label })).toContainElement(screen.getByTestId(`icon-${icon}`));
  });

  it('keeps the action available after a failure so it can be retried', () => {
    const onAction = jest.fn();
    render(<PromptCard title="Fund your wallet" status="failure" actionLabel="Try again" onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('does not loop the funding animations when the user asks for reduced motion', () => {
    const hero = { icon: IconName.Loader, label: 'Funding', subLabel: 'soon', tone: 'accent' } as const;
    const loopingCount = () =>
      screen.queryAllByText((_content, el) => el?.getAttribute('data-loops') === 'true').length;

    mockReduceMotion = false;
    const { unmount } = render(<PromptCard title="Fund your wallet" hero={hero} status="loading" />);
    // While motion is allowed, the progress runner and the hourglass both loop.
    expect(loopingCount()).toBe(2);
    unmount();

    mockReduceMotion = true;
    render(<PromptCard title="Fund your wallet" hero={hero} status="loading" />);

    // Reduced motion collapses both - they previously ran for the whole funding
    // wait, up to 3 minutes, with no way to turn them off.
    expect(loopingCount()).toBe(0);
  });

  it('announces each hero state by mutating one stable live region', () => {
    const funding = { icon: IconName.Loader, label: 'Funding', subLabel: 'available shortly', tone: 'accent' } as const;
    const funded = {
      icon: IconName.Checkmark,
      label: 'Funds deposited',
      subLabel: '$5 ready',
      tone: 'positive'
    } as const;

    const { rerender } = render(<PromptCard title="Fund your wallet" hero={funding} status="loading" />);

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Funding');
    expect(live).toHaveTextContent('available shortly');

    rerender(<PromptCard title="Fund your wallet" hero={funded} status="success" />);

    // Assistive tech only announces a live region that EXISTED before its
    // content changed. Asserting the text alone is satisfied by a freshly
    // mounted node too, so the swap must mutate the very same element.
    const settled = screen.getByRole('status');
    expect(settled).toBe(live);
    expect(settled).toHaveTextContent('Funds deposited');
    expect(settled).toHaveTextContent('$5 ready');
  });

  it('announces a failure that follows the Funding hero through the same live region', () => {
    const funding = { icon: IconName.Loader, label: 'Funding', subLabel: 'available shortly', tone: 'accent' } as const;

    const { rerender } = render(<PromptCard title="Fund your wallet" hero={funding} status="loading" />);
    const live = screen.getAllByRole('status').find(node => node.getAttribute('aria-live') === 'polite')!;
    expect(live).toHaveTextContent('Funding');

    // The request fails: the hero drops and the faucet's message becomes the
    // body. The region that already existed must carry that message - the
    // failure indicator beside it is newly mounted, so it is not announced.
    rerender(<PromptCard title="Fund your wallet" body="rate limited" status="failure" />);

    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent('failed');
    expect(live).toHaveTextContent('rate limited');
  });

  describe('focus when a hero takes over the card (#923)', () => {
    const funding = { icon: IconName.Loader, label: 'Funding', subLabel: 'soon', tone: 'accent' } as const;

    // Tapping the card swaps in the hero, as the faucet card does.
    const Harness: React.FC = () => {
      const [hero, setHero] = React.useState<typeof funding | undefined>(undefined);
      return (
        <div>
          <PromptCard
            data-testid="card"
            title="Fund your wallet"
            hero={hero}
            onClick={hero ? undefined : () => setHero(funding)}
          />
          <button type="button" onClick={() => setHero(undefined)}>
            end hero
          </button>
        </div>
      );
    };

    it('keeps keyboard focus in the card when the activated button is replaced by the hero', () => {
      render(<Harness />);
      const action = screen.getByRole('button', { name: /Fund your wallet/ });
      action.focus();

      // Enter on a focused button dispatches a click.
      fireEvent.click(action);

      const card = screen.getByTestId('card');
      expect(document.activeElement).not.toBe(document.body);
      expect(card.contains(document.activeElement)).toBe(true);
    });

    it('does not move focus for a tap that never focused the card', () => {
      render(<Harness />);
      // A pointer tap in Safari does not focus the button.
      expect(document.activeElement).toBe(document.body);

      fireEvent.click(screen.getByRole('button', { name: /Fund your wallet/ }));

      expect(document.activeElement).toBe(document.body);
    });

    it('hands focus back to the card action when the hero ends', () => {
      render(<Harness />);
      const action = screen.getByRole('button', { name: /Fund your wallet/ });
      action.focus();
      fireEvent.click(action);
      expect(document.activeElement).toBe(screen.getByTestId('card'));

      // The hero ends with the card still there (a failed request, say) and focus
      // still on the card: it must land on the action again, not fall to the page
      // when the container stops being focusable. `click()` leaves focus alone.
      act(() => {
        screen.getByRole('button', { name: 'end hero' }).click();
      });

      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Fund your wallet/ }));
    });

    it('hands focus back when the hero ends in a browser that blurs as the tabindex goes', () => {
      // Chromium blurs a focused element the moment its tabindex is removed; jsdom does not.
      const removeAttribute = Element.prototype.removeAttribute;
      const blurOnTabIndexRemoval = jest.spyOn(Element.prototype, 'removeAttribute').mockImplementation(function (
        this: Element,
        name: string
      ) {
        if (name.toLowerCase() === 'tabindex' && this === document.activeElement && this instanceof HTMLElement) {
          this.blur();
        }
        removeAttribute.call(this, name);
      });
      try {
        render(<Harness />);
        const action = screen.getByRole('button', { name: /Fund your wallet/ });
        action.focus();
        fireEvent.click(action);
        expect(document.activeElement).toBe(screen.getByTestId('card'));

        act(() => {
          screen.getByRole('button', { name: 'end hero' }).click();
        });

        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Fund your wallet/ }));
        // Once focus has moved on, the card is not left in the tab order.
        expect(screen.getByTestId('card')).not.toHaveAttribute('tabindex');
      } finally {
        blurOnTabIndexRemoval.mockRestore();
      }
    });

    it('hands focus back when the hero ends after the page lost focus with the card still focused', () => {
      const removeAttribute = Element.prototype.removeAttribute;
      const blurOnTabIndexRemoval = jest.spyOn(Element.prototype, 'removeAttribute').mockImplementation(function (
        this: Element,
        name: string
      ) {
        if (name.toLowerCase() === 'tabindex' && this === document.activeElement && this instanceof HTMLElement) {
          this.blur();
        }
        removeAttribute.call(this, name);
      });
      try {
        render(<Harness />);
        const action = screen.getByRole('button', { name: /Fund your wallet/ });
        action.focus();
        fireEvent.click(action);
        const card = screen.getByTestId('card');
        expect(document.activeElement).toBe(card);

        // The window, tab or side panel loses focus: a blur event, but focus stays on the card.
        fireEvent.blur(card);
        expect(document.activeElement).toBe(card);

        act(() => {
          screen.getByRole('button', { name: 'end hero' }).click();
        });

        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Fund your wallet/ }));
      } finally {
        blurOnTabIndexRemoval.mockRestore();
      }
    });

    it('leaves focus where the user moved it when the hero ends', () => {
      render(<Harness />);
      const action = screen.getByRole('button', { name: /Fund your wallet/ });
      action.focus();
      fireEvent.click(action);
      expect(document.activeElement).toBe(screen.getByTestId('card'));

      // The user tabs on during the wait; the hero ending must not pull focus back.
      const endHero = screen.getByRole('button', { name: 'end hero' });
      endHero.focus();
      act(() => {
        endHero.click();
      });

      expect(document.activeElement).toBe(endHero);
      expect(screen.getByTestId('card')).not.toHaveAttribute('tabindex');
    });

    it('never moves focus for a hero that shows after the tap', () => {
      // The tap does not swap in a hero; one arrives later, after the user has moved on.
      const LateHero: React.FC = () => {
        const [hero, setHero] = React.useState<typeof funding | undefined>(undefined);
        return (
          <div>
            <PromptCard data-testid="card" title="Fund your wallet" hero={hero} onClick={() => undefined} />
            <button type="button" onClick={() => setHero(funding)}>
              start hero
            </button>
          </div>
        );
      };
      render(<LateHero />);
      const action = screen.getByRole('button', { name: /Fund your wallet/ });
      action.focus();
      fireEvent.click(action);

      const elsewhere = screen.getByRole('button', { name: 'start hero' });
      elsewhere.focus();
      act(() => {
        elsewhere.click();
      });

      expect(document.activeElement).toBe(elsewhere);
    });
  });
});
