import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from './drawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
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
});
