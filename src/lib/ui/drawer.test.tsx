import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { sheetMotionVars } from 'lib/animation';
import { isExtension } from 'lib/platform';

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from './drawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn(() => false)
}));

describe('Drawer', () => {
  it('renders the open drawer through the local API and closes from the header button', () => {
    const onOpenChange = jest.fn();

    render(
      <Drawer open onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerHeader>
          <div>Drawer body</div>
        </DrawerContent>
      </Drawer>
    );

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Drawer body')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('close'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stops taking pointer events once dismissed, so a tap during the close reaches what is underneath', () => {
    // The guard is asserted as an inline style, not a class: Radix sets inline pointer-events on both
    // layers, which only an inline style can outrank, and jsdom applies no Tailwind CSS.
    const { rerender } = render(
      <Drawer open onOpenChange={() => {}}>
        <DrawerContent forceMount>
          <DrawerHeader>
            <DrawerTitle>Pick a token</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );

    const openContent = screen.getByRole('dialog', { name: 'Pick a token' });
    expect(openContent.style.pointerEvents).not.toBe('none');

    rerender(
      <Drawer open={false} onOpenChange={() => {}}>
        <DrawerContent forceMount>
          <DrawerHeader>
            <DrawerTitle>Pick a token</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );

    const closingContent = screen.getByRole('dialog', { name: 'Pick a token' });
    expect(closingContent.style.pointerEvents).toBe('none');
    expect(closingContent.getAttribute('data-state')).toBe('closed');

    const overlay = document.querySelector('[data-vaul-overlay]') as HTMLElement | null;
    expect(overlay?.style.pointerEvents).toBe('none');
  });

  it('draws the header close as a 32px circle on fill, per the design system', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );

    const close = screen.getByLabelText('close');
    expect(close.className).toContain('h-8');
    expect(close.className).toContain('w-8');
    expect(close.className).toContain('bg-fill');
    expect(close.className).toContain('text-muted');
  });

  it('renders DrawerTitle at 18px/24 Nunito 800, left-aligned, on the ink token', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );

    const title = screen.getByRole('heading', { name: 'Settings' });
    expect(title).toHaveClass('text-title-section');
    expect(title.className).toContain('text-left');
    expect(title.className).toContain('text-ink');
  });

  it('draws no rule under the header: a sheet separates with fill groups, not a divider', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );

    const header = document.querySelector('[data-slot="drawer-header"]')!;
    expect(header.className).not.toMatch(/\bborder-b\b/);
    expect(header.className).toContain('px-4');
  });

  it('dims the page behind with one plain scrim token and no blur', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    const overlay = document.querySelector('[data-vaul-overlay]')!;
    expect(overlay.className).toContain('bg-scrim');
    expect(overlay.className).not.toMatch(/backdrop-blur/);
    // One value in both themes: no `dark:` variant to override it.
    expect(overlay.className).not.toMatch(/\bdark:/);
  });

  it('runs the sheet and its backdrop on the tab-bar springs, on one timing', () => {
    render(
      <Drawer open>
        <DrawerContent data-testid="sheet">
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    for (const el of [screen.getByTestId('sheet'), document.querySelector('[data-vaul-overlay]')!]) {
      const style = (el as HTMLElement).style;
      for (const [name, value] of Object.entries(sheetMotionVars)) {
        expect(style.getPropertyValue(name)).toBe(value);
      }
    }
  });

  // The spring rule's !important duration and easing reach every property the sheet transitions,
  // and keyboard padding must snap (lib/mobile/keyboard-inset.ts).
  it('transitions only its transform, so the keyboard inset snaps', () => {
    render(
      <Drawer open>
        <DrawerContent data-testid="sheet">
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    const sheet = screen.getByTestId('sheet');
    expect(sheet).toHaveClass('transition-transform');
    expect(sheet.className).not.toContain('transition-[padding-bottom]');
  });

  it('keeps a sheet’s own inline style beside the motion variables', () => {
    render(
      <Drawer open>
        <DrawerContent data-testid="sheet" style={{ zIndex: 99 }}>
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    const sheet = screen.getByTestId('sheet');
    expect(sheet.style.zIndex).toBe('99');
    expect(sheet.style.getPropertyValue('--sheet-open-easing')).toBe(sheetMotionVars['--sheet-open-easing']);
  });

  it('puts the sheet on the page surface', () => {
    render(
      <Drawer open>
        <DrawerContent data-testid="sheet">
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    expect(screen.getByTestId('sheet').className).toContain('bg-page');
  });

  it('gives the sheet a 28px top radius', () => {
    render(
      <Drawer open>
        <DrawerContent data-testid="sheet">
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    expect(screen.getByTestId('sheet').className).toContain('rounded-t-[28px]');
  });

  it('renders a 36x5 handle on the fill-pressed token when shown', () => {
    render(
      <Drawer open>
        <DrawerContent hideHandle={false} data-testid="sheet">
          <div>Body</div>
        </DrawerContent>
      </Drawer>
    );

    const handle = screen.getByTestId('sheet').querySelector('[data-vaul-handle]');
    expect(handle).not.toBeNull();
    expect(handle!.className).toContain('w-9');
    expect(handle!.className).toContain('h-[5px]');
    expect(handle!.className).toContain('bg-fill-pressed');
  });

  /** Radix attaches its outside-press listener on the next tick. */
  const outsideListenerReady = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

  it('dismisses on Escape by default', () => {
    const onOpenChange = jest.fn();
    render(
      <Drawer open onOpenChange={onOpenChange}>
        <DrawerContent data-testid="sheet">
          <DrawerTitle>Settings</DrawerTitle>
        </DrawerContent>
      </Drawer>
    );

    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('dismisses on a press outside by default', async () => {
    const onOpenChange = jest.fn();
    render(
      <Drawer open onOpenChange={onOpenChange}>
        <DrawerContent data-testid="sheet">
          <DrawerTitle>Settings</DrawerTitle>
        </DrawerContent>
      </Drawer>
    );
    await outsideListenerReady();

    fireEvent.pointerDown(document.querySelector('[data-vaul-overlay]')!);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('never closes itself when dismissible is false (the caller owns closing)', async () => {
    const onOpenChange = jest.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} dismissible={false}>
        <DrawerContent data-testid="sheet">
          <DrawerTitle>Settings</DrawerTitle>
        </DrawerContent>
      </Drawer>
    );

    await outsideListenerReady();
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    fireEvent.pointerDown(document.querySelector('[data-vaul-overlay]')!);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
  });

  describe('body styles (extension background scale)', () => {
    let wrapper: HTMLDivElement;

    beforeEach(() => {
      jest.mocked(isExtension).mockReturnValue(true);
      wrapper = document.createElement('div');
      wrapper.setAttribute('data-vaul-drawer-wrapper', '');
      document.body.appendChild(wrapper);
    });

    afterEach(() => {
      // Unmount first: vaul's scale effect writes body styles on the way out too.
      cleanup();
      jest.mocked(isExtension).mockReturnValue(false);
      wrapper.remove();
      document.body.style.cssText = '';
    });

    it('scales the app behind the sheet and paints the body black by default', () => {
      render(
        <Drawer open>
          <DrawerContent>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerContent>
        </Drawer>
      );

      expect(wrapper.style.transform).toContain('scale(');
      expect(document.body.style.cssText).toContain('black');
    });

    it('does not paint the body black on open with noBodyStyles', () => {
      // Open only: vaul's scale cleanup still resets body.style.background 500ms after close,
      // noBodyStyles or not. What noBodyStyles protects for a sheet beneath is the Safari pin.
      render(
        <Drawer open noBodyStyles>
          <DrawerContent>
            <DrawerTitle>Settings</DrawerTitle>
          </DrawerContent>
        </Drawer>
      );

      expect(wrapper.style.transform).toContain('scale(');
      expect(document.body.style.cssText).not.toContain('black');
    });
  });
});
