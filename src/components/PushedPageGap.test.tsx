/**
 * Every pushed page opens at the same height.
 *
 * The 4px rule under a pushed page's title is `PageHeader`'s, and so is the 8px under it — the
 * same `mb-2` `TabRootHeader` puts under the identical rule, so the first line of content sits
 * where it sits on a tab root. Before that, each page paid for its own opening space and they
 * disagreed: 2px through `SubPageLayout`, 8px through `FlowLayout` plus whatever the page added,
 * and 12, 16, 24 or 32 on the pages that hand-assemble the frame. The encrypted-wallet-file page
 * came out with its first label against the rule while its siblings had air (Brian, simulator).
 *
 * So the check is not "each frame looks right on its own": it is that two different sub-pages,
 * drawn through two different frames, put their content the same distance under the rule.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';

import { FlowLayout } from 'components/flow/FlowLayout';
import { PageHeader } from 'components/PageHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('app/icons/v2', () => ({
  IconName: { ArrowLeft: 'arrow-left', ChevronLeft: 'chevron-left', Close: 'close' },
  Icon: ({ name }: { name: string }) => <svg data-name={name} />
}));

/** Vertical space a class list contributes above its content: the top padding and margin in it. */
const topSpacing = (el: Element): string[] =>
  Array.from(el.classList).filter(name => /^-?(pt|py|mt|my)-/.test(name) || /^-?p-|^-?m-/.test(name));

/**
 * The gap a page opens with: the rule's own bottom spacing, plus anything every element between
 * the rule and the content adds on top. jsdom has no layout, so the classes ARE the offset.
 */
const gapUnderRule = (root: HTMLElement, contentTestId: string) => {
  const rule = root.querySelector('header')!.nextElementSibling!;
  const ruleBottom = Array.from(rule.classList).filter(name => /^-?(mb|my|pb|py)-/.test(name));

  const added: string[] = [];
  for (let node = screen.getByTestId(contentTestId).parentElement; node && node !== root; node = node.parentElement) {
    added.push(...topSpacing(node));
  }

  return { ruleBottom, added };
};

it('opens a sub-page and a flow page the same distance under the rule', () => {
  const { container: subPage } = render(
    <SubPageLayout title="Encrypted wallet file" onBack={jest.fn()} footer={<button type="button">Continue</button>}>
      <p data-testid="content">a field</p>
    </SubPageLayout>
  );
  const subPageGap = gapUnderRule(subPage, 'content');

  screen.getByTestId('content').remove();

  const { container: flowPage } = render(
    <FlowLayout title="New contact" onBack={jest.fn()} footer={<button type="button">Add</button>}>
      <p data-testid="content">a field</p>
    </FlowLayout>
  );

  // The header owns the whole gap, and nothing between it and the content adds to it.
  expect(subPageGap.ruleBottom).toEqual(['mb-2']);
  expect(subPageGap.added).toEqual([]);
  expect(gapUnderRule(flowPage, 'content')).toEqual(subPageGap);
});

it('gives a hand-assembled pushed page the same gap without it asking', () => {
  const { container } = render(
    <div>
      <PageHeader title="Recovery phrase" onBack={jest.fn()} />
      <div className="flex flex-col px-4">
        <p data-testid="content">the words</p>
      </div>
    </div>
  );

  expect(gapUnderRule(container.firstElementChild as HTMLElement, 'content')).toEqual({
    ruleBottom: ['mb-2'],
    added: []
  });
});
