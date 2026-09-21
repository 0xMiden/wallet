/**
 * A pinned CTA is the same width wherever it is pinned.
 *
 * The bug this guards is two callers disagreeing, not one caller being wrong. `SubPageLayout`
 * pads its footer row by the 16px page margin; `HomeGroupPaneBody` does not, because its own
 * scrolling body carries that margin and the footer sits outside it. So a `Button` whose width
 * was decided by the caller came out inset on a settings sub-page and flush against both screen
 * edges on the send review and the swap step — Brian's report, from the simulator.
 *
 * The fix is that a `lg` `Button` decides its own width: it fills the row it is given up to
 * `max-w-cta` and centres there, which is the same 16px either side that the padded row gives.
 * That only holds while neither frame's caller overrides it, and an override is one class long,
 * so what is checked here is the rendered button, through both frames, not the intention.
 *
 * jsdom has no layout: the classes ARE the geometry.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button } from 'components/ui/Button';
import { SubPageLayout } from 'components/ui/SubPageLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({
  IconName: { ArrowLeft: 'arrow-left', ChevronLeft: 'chevron-left', Close: 'close' },
  Icon: ({ name }: { name: string }) => <svg data-name={name} />
}));

/** Everything about an element that decides where its left and right edges land. */
const horizontalGeometry = (el: Element): string[] =>
  Array.from(el.classList)
    .filter(name => /^-?(w|min-w|max-w|mx|ml|mr|px|pl|pr)-/.test(name))
    .sort();

const cta = (testId: string) => horizontalGeometry(screen.getByTestId(testId));

it('draws a pinned CTA at the same width through both page frames', () => {
  render(
    <SubPageLayout title="Spending limits" onBack={jest.fn()} footer={<Button title="Save" data-testid="sub-cta" />}>
      <p>a field</p>
    </SubPageLayout>
  );
  render(
    <HomeGroupPaneBody footer={<Button title="Confirm" data-testid="pane-cta" />}>
      <p>a review</p>
    </HomeGroupPaneBody>
  );

  expect(cta('pane-cta')).toEqual(cta('sub-cta'));
});

it('caps that width and centres what is left over, so both land on the page margin', () => {
  render(
    <HomeGroupPaneBody footer={<Button title="Confirm" data-testid="pane-cta" />}>
      <p>a review</p>
    </HomeGroupPaneBody>
  );

  // `w-full` up to the cap, `mx-auto` to split the slack past it. Without the second half the cap
  // left every screen's CTA hard against the left edge, which is why 65 files turned it off.
  expect(cta('pane-cta')).toEqual(['max-w-cta', 'mx-auto', 'px-4', 'w-full']);
});

it('lets a pair split the row between them, still inside the one cap', () => {
  render(
    <SubPageLayout
      title="Contact"
      onBack={jest.fn()}
      footer={
        <>
          <Button title="Delete" className="flex-1" data-testid="left-cta" />
          <Button title="Send" className="flex-1" data-testid="right-cta" />
        </>
      }
    >
      <p>a contact</p>
    </SubPageLayout>
  );

  // `flex-1` is placement, not a width: the cap and the centring stay the component's, and a pair
  // inside the page margin never reaches the cap anyway.
  expect(cta('left-cta')).toEqual(cta('right-cta'));
  expect(cta('left-cta')).toContain('max-w-cta');
});
