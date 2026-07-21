import React from 'react';

import { render, screen } from '@testing-library/react';

import ImportTabSwitcher from './ImportTabSwitcher';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert the rendered label directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

// `lib/woozie`'s real `Link` depends on the woozie location/history/analytics
// stack. Replace it with a plain anchor that forwards the props the component
// sets so we can assert `to`, `replace` and inspect the child markup/classes.
jest.mock('lib/woozie', () => ({
  Link: ({ to, replace, children }: { to: string; replace?: boolean; children?: React.ReactNode }) => (
    <a href={to} data-testid="tab-link" data-to={to} data-replace={String(replace)}>
      {children}
    </a>
  )
}));

const TABS = [
  { slug: 'first', i18nKey: 'firstTab' },
  { slug: 'second', i18nKey: 'secondTab' }
];

const getWrapper = (container: HTMLElement) => container.firstChild as HTMLElement;
const getInner = (link: HTMLElement) => link.firstElementChild as HTMLElement;

describe('ImportTabSwitcher', () => {
  it('renders one Link per tab with translated labels', () => {
    render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('t:firstTab');
    expect(links[1]).toHaveTextContent('t:secondTab');
  });

  it('builds each Link `to` from the urlPrefix and slug, with replace enabled', () => {
    render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links[0]).toHaveAttribute('data-to', '/import/first');
    expect(links[1]).toHaveAttribute('data-to', '/import/second');
    expect(links[0]).toHaveAttribute('data-replace', 'true');
    expect(links[1]).toHaveAttribute('data-replace', 'true');
  });

  it('applies the active classes to the matching tab (active branch)', () => {
    render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const inner = getInner(screen.getAllByTestId('tab-link')[0]!);
    expect(inner).toHaveClass('border-primary-orange', 'text-primary-orange');
    expect(inner).not.toHaveClass('border-transparent');
    expect(inner).not.toHaveClass('hover:text-primary-orange');
  });

  it('applies the inactive classes to non-matching tabs (inactive branch)', () => {
    render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const inner = getInner(screen.getAllByTestId('tab-link')[1]!);
    expect(inner).toHaveClass('border-transparent', 'hover:text-primary-orange');
    expect(inner).not.toHaveClass('border-primary-orange');
    expect(inner).not.toHaveClass('text-primary-orange');
  });

  it('renders shared static classes on each inner tab element', () => {
    render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const inner = getInner(screen.getAllByTestId('tab-link')[0]!);
    expect(inner).toHaveClass('text-center', 'cursor-pointer', 'text-text-muted', 'border-b-2', 'truncate');
  });

  it('renders the base wrapper class, inline styles and merges an extra className', () => {
    const { container } = render(
      <ImportTabSwitcher className="my-extra" tabs={TABS} activeTabSlug="first" urlPrefix="/import" />
    );

    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('w-full', 'my-extra');
    expect(wrapper).toHaveStyle({ borderBottomWidth: '1px', fontSize: '17px' });

    // The inner flex row that lays out the tabs.
    const row = wrapper.firstChild as HTMLElement;
    expect(row).toHaveClass('flex', 'items-center', 'justify-around');
  });

  it('omits an extra className when none is provided (falsy className branch)', () => {
    const { container } = render(<ImportTabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/import" />);

    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('w-full');
    // Only the base class is present — no `undefined` leaked into the class list.
    expect(wrapper.className).not.toContain('undefined');
  });

  it('renders no Links when the tabs array is empty', () => {
    const { container } = render(<ImportTabSwitcher tabs={[]} activeTabSlug="none" urlPrefix="/x" />);

    expect(screen.queryByTestId('tab-link')).toBeNull();
    // The wrapper and its inner flex row are still rendered even with zero tabs.
    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('w-full');
    expect(wrapper.firstChild as HTMLElement).toHaveClass('justify-around');
  });
});
