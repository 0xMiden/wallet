/**
 * The box the four home-carousel panes share.
 *
 * Two of the three things this pins are regressions, not preferences:
 *
 * - **The horizontal gesture belongs to the carousel.** `HomeSwipeContainer` drags the track with
 *   framer, under `touch-action: pan-y`. A pane that becomes a horizontal scroll container is the
 *   handler for a sideways pan and takes that gesture before the carousel sees it — which is how
 *   the Send pane stopped switching tabs. The body's `touch-action: pan-y` and `overflow-x-hidden`
 *   are what make that impossible, so they are asserted rather than left to a reviewer's eye.
 * - **One page margin and one top offset**, so a pane's first line does not move as you swipe
 *   between panes, and no pane sits inset from its neighbours.
 *
 * jsdom has no layout and no touch, so these are assertions about the contract — the classes and
 * the inline `touch-action` — not about pixels. What a device has to confirm is the feel; what
 * this file stops is the contract being quietly rewritten per page again.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';

import { FlowLayout } from 'components/flow/FlowLayout';

import { HomeGroupPane, HomeGroupPaneBody, HomeGroupPaneRoot } from './HomeGroupPane';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({
  IconName: { ArrowLeft: 'arrow-left', Close: 'close' },
  Icon: ({ name }: { name: string }) => <svg data-name={name} />
}));

const body = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-home-pane-body="true"]')!;

describe('HomeGroupPaneBody', () => {
  it('keeps the horizontal gesture for the carousel: pan-y, and never a horizontal scroller', () => {
    const { container } = render(
      <HomeGroupPaneBody>
        <p>content</p>
      </HomeGroupPaneBody>
    );

    const el = body(container);
    // Declared inline, so it survives any `className` a caller might add.
    expect(el.style.touchAction).toBe('pan-y');
    // `overflow-y-auto` alone computes `overflow-x` to `auto`, which makes the body itself a
    // horizontal scroll container the moment anything inside it bleeds past the page margin.
    expect(el).toHaveClass('overflow-y-auto', 'overflow-x-hidden', 'overscroll-contain');
  });

  it('puts every pane on the one page margin and the one top offset', () => {
    const { container } = render(
      <HomeGroupPaneBody>
        <p>content</p>
      </HomeGroupPaneBody>
    );

    // 16px, the design system's page margin — not the 24px the flow frame used to carry, which is
    // what made the Send pane read as inset next to Receive and Earn.
    expect(body(container)).toHaveClass('px-4', 'pt-6');
  });

  it('starts a pushed step under its header rather than at a pane title height', () => {
    const { container } = render(
      <HomeGroupPaneBody top="header">
        <p>content</p>
      </HomeGroupPaneBody>
    );

    expect(body(container)).toHaveClass('pt-2');
    expect(body(container)).not.toHaveClass('pt-6');
  });

  it('draws the pane title, so all four sit at the same height', () => {
    render(
      <HomeGroupPaneBody title="Receive at" titleTestId="receive-title" titleAccessory={<span>chip</span>}>
        <p>content</p>
      </HomeGroupPaneBody>
    );

    const title = screen.getByTestId('receive-title');
    expect(title.tagName).toBe('H1');
    expect(title).toHaveClass('text-title-tab', 'text-ink');
    expect(screen.getByText('chip')).toBeInTheDocument();
  });

  it('clears the docked tab bar from the same expression the pinned CTA uses', () => {
    // A pane with a CTA clears the bar with the footer's cushion; a pane without one has to clear
    // it itself, and the two have to be the same number or the panes end at different heights.
    const withoutFooter = render(
      <HomeGroupPaneBody>
        <p>content</p>
      </HomeGroupPaneBody>
    );
    const cushion = 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]';
    expect(body(withoutFooter.container)).toHaveClass(cushion);
    withoutFooter.unmount();

    const withFooter = render(
      <HomeGroupPaneBody footer={<button>cta</button>}>
        <p>content</p>
      </HomeGroupPaneBody>
    );
    // The body stops padding itself and hands the job to the footer, which carries the same value
    // and the `data-navbar-cushion` hook that collapses it.
    expect(body(withFooter.container)).not.toHaveClass(cushion);
    const footer = screen.getByText('cta').parentElement;
    expect(footer).toHaveClass(cushion);
    expect(footer).toHaveAttribute('data-navbar-cushion', 'true');
  });
});

describe('the four panes are drawn in one box', () => {
  /** The body's classes and gesture contract, whichever component put it there. */
  const contract = (root: HTMLElement) => {
    const el = body(root);
    return { className: el.className, touchAction: el.style.touchAction };
  };

  it('gives a Navigator-backed flow page the same body as a page with no Navigator', () => {
    // Send and Swap run their steps through `Navigator` and reach the box through `FlowLayout`;
    // Receive and Earn have no Navigator and reach it directly. Both have to arrive at the same
    // element, or the panes drift apart again the next time one of them is touched.
    const pane = render(
      <HomeGroupPane paneTestId="earn-page" title="Your Earnings" footer={<button>cta</button>}>
        <p>content</p>
      </HomeGroupPane>
    );
    const paneContract = contract(pane.container);
    expect(pane.container.querySelector('[data-testid="earn-page"]')).toBeInTheDocument();
    pane.unmount();

    const flow = render(
      <FlowLayout tabRoot title="Send to" footer={<button>cta</button>}>
        <p>content</p>
      </FlowLayout>
    );

    expect(contract(flow.container)).toEqual(paneContract);
  });

  it('roots a pane full bleed on the app surface', () => {
    const { container } = render(
      <HomeGroupPaneRoot testId="send-flow">
        <p>content</p>
      </HomeGroupPaneRoot>
    );

    const root = container.querySelector<HTMLElement>('[data-testid="send-flow"]')!;
    expect(root).toHaveClass('h-full', 'w-full', 'bg-app-bg', 'overflow-hidden');
    // No `mx-auto`, no cap of its own: the pane fills the carousel's cell edge to edge, and
    // TabLayout already caps the column at 600px where there is room for more.
    expect(root.className).not.toMatch(/mx-auto|max-w-/);
  });
});
