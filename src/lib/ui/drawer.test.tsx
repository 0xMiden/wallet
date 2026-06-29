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
});
