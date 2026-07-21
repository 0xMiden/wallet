import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import PrivateDataPermissionCheckbox from './PrivateDataPermissionCheckbox';

// `t` is never `init()`-ed in the unit env; echo the key back so the rendered
// description and checkbox label are directly assertable by translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The rendered checkbox tree (FormCheckbox → Checkbox) fires `hapticMedium` on
// every change, which reaches into @capacitor/haptics + platform/settings
// helpers. Mock the module so the toggle interaction stays hermetic and native
// code is never touched.
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn()
}));

describe('PrivateDataPermissionCheckbox', () => {
  it('renders the description copy and the confirm-risk checkbox label', () => {
    render(<PrivateDataPermissionCheckbox setChecked={jest.fn()} />);

    expect(screen.getByText('confirmPrivateDataPermissionDescription')).toBeInTheDocument();
    expect(screen.getByText('confirmRisk')).toBeInTheDocument();
  });

  it('renders the checkbox unchecked initially (default useState false) and does not call setChecked on mount', () => {
    const setChecked = jest.fn();
    render(<PrivateDataPermissionCheckbox setChecked={setChecked} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.name).toBe('confirmPrivateDataPermission');
    expect(checkbox).not.toBeChecked();
    expect(setChecked).not.toHaveBeenCalled();
  });

  it('checks the box and reports true through setChecked when toggled on (evt.target.checked === true branch)', () => {
    const setChecked = jest.fn();
    render(<PrivateDataPermissionCheckbox setChecked={setChecked} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(setChecked).toHaveBeenCalledTimes(1);
    expect(setChecked).toHaveBeenLastCalledWith(true);
  });

  it('unchecks the box and reports false through setChecked when toggled off again (evt.target.checked === false branch)', () => {
    const setChecked = jest.fn();
    render(<PrivateDataPermissionCheckbox setChecked={setChecked} />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;

    // Toggle on, then off — exercises both target.checked branches of handlePopupModeChange.
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);

    expect(checkbox).not.toBeChecked();
    expect(setChecked).toHaveBeenCalledTimes(2);
    expect(setChecked).toHaveBeenNthCalledWith(1, true);
    expect(setChecked).toHaveBeenNthCalledWith(2, false);
  });

  it('exposes the description via a label wired to the checkbox id', () => {
    const { container } = render(<PrivateDataPermissionCheckbox setChecked={jest.fn()} />);

    const label = container.querySelector('label[for="confirmPrivateDataPermission"]');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('confirmPrivateDataPermissionDescription');
  });
});
