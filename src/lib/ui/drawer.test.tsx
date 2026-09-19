import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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

  it('renders DrawerTitle at 20px/26 Nunito 800, left-aligned, on the ink token', () => {
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
    expect(title.className).toContain('text-[20px]');
    expect(title.className).toContain('leading-[26px]');
    expect(title.className).toContain('font-extrabold');
    expect(title.className).toContain('font-heading');
    expect(title.className).toContain('text-left');
    expect(title.className).toContain('text-ink');
    expect(title.className).not.toContain('text-heading-gray');
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
