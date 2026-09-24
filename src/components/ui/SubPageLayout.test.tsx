import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';

import { SubPageHeaderProvider, SubPageLayout, SubPageSection } from './SubPageLayout';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({
  IconName: { ChevronLeft: 'chevron-left', Close: 'close' },
  Icon: ({ name }: { name: string }) => <svg data-name={name} />
}));

const body = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-slot="body"]')!;
const footer = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-slot="footer"]');

describe('SubPageLayout', () => {
  it('renders the shared page header with the title and a back button that calls onBack', () => {
    const onBack = jest.fn();
    render(
      <SubPageLayout title="Keys" onBack={onBack} data-testid="page">
        <p>content</p>
      </SubPageLayout>
    );

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1, name: 'Keys' })).toBeInTheDocument();
    // The header block (row and rule) takes the page's 16px margin, like the body and the footer.
    expect(header).toHaveClass('min-h-15');
    expect(header.parentElement).toHaveClass('px-4');
    fireEvent.click(screen.getByTestId('page-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('scrolls only the body, with the 16px gutter and 20px between sections', () => {
    render(
      <SubPageLayout title="Keys" data-testid="page">
        <section data-testid="one" />
        <section data-testid="two" />
      </SubPageLayout>
    );

    const page = screen.getByTestId('page');
    const scroller = body(page);
    expect(scroller).toHaveClass('overflow-y-auto', 'min-h-0', 'flex-1', 'px-4', 'gap-5');
    expect(screen.getByTestId('one').parentElement).toBe(scroller);
    expect(screen.getByTestId('two').parentElement).toBe(scroller);
    // Neither the header nor the root scrolls: only the body does.
    expect(page).not.toHaveClass('overflow-y-auto');
    expect(screen.getByRole('banner')).toHaveClass('shrink-0');
  });

  it('pins the footer under the body with the page margin, its buttons 10px apart', () => {
    render(
      <SubPageLayout title="Keys" data-testid="page" footer={<button type="button">Rotate</button>}>
        <p>content</p>
      </SubPageLayout>
    );

    const page = screen.getByTestId('page');
    const pinned = footer(page)!;
    // A sibling after the scroller, not inside it: it stays put while the body scrolls.
    expect(pinned.parentElement).toBe(page);
    expect(pinned.previousElementSibling).toBe(body(page));
    expect(pinned).toHaveClass('shrink-0', 'flex', 'gap-2.5', 'px-4');
    // The flow footer's keyboard-aware cushion, not a flat `pb-4`: the docked bar draws over the
    // page, so a sub-page's CTA clears it for as long as the bar is up, and `data-navbar-cushion`
    // is what collapses the cushion once `body[data-hide-navbar]` says the bar is down.
    expect(pinned.className).toContain('var(--keyboard-height,0px)');
    expect(pinned.getAttribute('data-navbar-cushion')).toBe('true');
    expect(pinned).not.toHaveClass('flex-col');
    expect(within(pinned).getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
  });

  it('pins it through the flow footer, so the CTA rides the keyboard instead of jumping', () => {
    (useSlideOnReflow as jest.Mock).mockClear();
    render(
      <SubPageLayout title="Keys" data-testid="page" footer={<button type="button">Rotate</button>}>
        <p>content</p>
      </SubPageLayout>
    );

    const pinned = footer(screen.getByTestId('page'))!;
    // FlowFooter's own spacing above the CTA, and its slide on every reflow the keyboard causes.
    expect(pinned).toHaveClass('pt-3');
    const observed = (useSlideOnReflow as jest.Mock).mock.calls.map(([ref]) => ref.current);
    expect(observed).toContain(pinned);
  });

  it('keeps the flat 16px margin, with no navbar cushion, where no tab bar is drawn', () => {
    render(
      <SubPageLayout
        title="Keys"
        data-testid="page"
        footerNavbarCushion={false}
        footer={<button type="button">Rotate</button>}
      >
        <p>content</p>
      </SubPageLayout>
    );

    const pinned = footer(screen.getByTestId('page'))!;
    expect(pinned).toHaveClass('pb-4', 'pt-3');
    expect(pinned.className).not.toContain('var(--keyboard-height,0px)');
    expect(pinned).not.toHaveAttribute('data-navbar-cushion');
  });

  it('stacks the footer on request and renders none without one', () => {
    const { rerender } = render(
      <SubPageLayout title="Keys" data-testid="page" footer={<button type="button">a</button>} footerLayout="stack">
        <p>content</p>
      </SubPageLayout>
    );
    expect(footer(screen.getByTestId('page'))).toHaveClass('flex-col');

    rerender(
      <SubPageLayout title="Keys" data-testid="page">
        <p>content</p>
      </SubPageLayout>
    );
    expect(footer(screen.getByTestId('page'))).toBeNull();
  });

  it('takes its header from the route that opened it, and lets the page override it', () => {
    const onBack = jest.fn();
    const { rerender } = render(
      <SubPageHeaderProvider value={{ title: 'From route', onBack, focusTitleOnMount: true }}>
        <SubPageLayout>
          <p>content</p>
        </SubPageLayout>
      </SubPageHeaderProvider>
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'From route' });
    expect(heading).toHaveFocus();
    fireEvent.click(screen.getByTestId('page-back'));
    expect(onBack).toHaveBeenCalledTimes(1);

    rerender(
      <SubPageHeaderProvider value={{ title: 'From route', onBack }}>
        <SubPageLayout title="Own title">
          <p>content</p>
        </SubPageLayout>
      </SubPageHeaderProvider>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Own title' })).toBeInTheDocument();
  });

  it('omits the header row when there is neither a title nor a back button', () => {
    render(
      <SubPageLayout data-testid="page">
        <p>content</p>
      </SubPageLayout>
    );

    expect(screen.queryByRole('banner')).toBeNull();
  });
});

describe('SubPageSection', () => {
  it('labels the section, then its muted description, content and footnote', () => {
    render(
      <SubPageSection title="Rotate device key" description="What it does" footnote="Small print" data-testid="s">
        <button type="button">Rotate</button>
      </SubPageSection>
    );

    const section = screen.getByTestId('s');
    expect(section.tagName).toBe('SECTION');
    expect(within(section).getByRole('heading', { level: 2, name: 'Rotate device key' })).toHaveClass(
      'text-label',
      'text-muted'
    );
    // A description is a paragraph (body); a footnote under a control is secondary copy.
    expect(screen.getByText('What it does')).toHaveClass('text-body', 'text-muted');
    expect(screen.getByText('Small print')).toHaveClass('text-body-sm', 'text-muted');

    const order = Array.from(section.querySelectorAll('h2, div, button')).map(el => el.textContent);
    expect(order.indexOf('What it does')).toBeLessThan(order.indexOf('Rotate'));
    expect(order.indexOf('Rotate')).toBeLessThan(order.indexOf('Small print'));
  });

  it('drops the label a level under a hero heading', () => {
    render(<SubPageSection title="Details" titleAs="h3" />);

    expect(screen.getByRole('heading', { level: 3, name: 'Details' })).toBeInTheDocument();
  });

  it('renders only what it is given', () => {
    render(
      <SubPageSection data-testid="s">
        <p>only content</p>
      </SubPageSection>
    );

    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByTestId('s').children).toHaveLength(1);
  });
});

describe('SubPageLayout — close', () => {
  it('puts a close button in the header for a dismissed page', () => {
    const onClose = jest.fn();
    render(
      <SubPageLayout title="Forgot password" onClose={onClose}>
        <div />
      </SubPageLayout>
    );
    fireEvent.click(screen.getByTestId('page-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('page-back')).not.toBeInTheDocument();
  });
});
