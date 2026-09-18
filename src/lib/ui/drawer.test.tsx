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
});
