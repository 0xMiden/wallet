import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ChooseDeviceRole } from './ChooseDeviceRole';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, number>) => (params ? `${key}:${Object.values(params).join(',')}` : key)
  })
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  )
}));

describe('ChooseDeviceRole', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders both roles and preselects Add this device', () => {
    render(<ChooseDeviceRole onSubmit={jest.fn()} />);

    expect(screen.getByTestId('choose-device-role')).toBeInTheDocument();
    expect(screen.getByText('chooseDeviceRoleTitle', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.queryByText('chooseDeviceRoleAddSubtitle')).not.toBeInTheDocument();
    expect(screen.getByText('chooseDeviceRoleMainSubtitle')).toBeInTheDocument();
    expect(screen.getByTestId('device-role-add')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('device-role-main')).toHaveAttribute('aria-checked', 'false');
  });

  it('submits Add by default', () => {
    const onSubmit = jest.fn();
    render(<ChooseDeviceRole onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('device-role-continue'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('add');
  });

  it('submits replace after the user selects the main device role', () => {
    const onSubmit = jest.fn();
    render(<ChooseDeviceRole onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('device-role-main'));
    expect(screen.getByTestId('device-role-main')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('device-role-continue'));

    expect(onSubmit).toHaveBeenCalledWith('replace');
  });

  it('goes back to Add when the user selects it again', () => {
    const onSubmit = jest.fn();
    render(<ChooseDeviceRole onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('device-role-main'));
    fireEvent.click(screen.getByTestId('device-role-add'));
    fireEvent.click(screen.getByTestId('device-role-continue'));

    expect(onSubmit).toHaveBeenCalledWith('add');
  });

  it('disables Continue while it submits', () => {
    render(<ChooseDeviceRole submitting onSubmit={jest.fn()} />);

    expect(screen.getByTestId('device-role-continue')).toBeDisabled();
  });

  describe('the device count line', () => {
    it('is hidden while the count is not known', () => {
      render(<ChooseDeviceRole onSubmit={jest.fn()} />);

      expect(screen.queryByText(/chooseDeviceRoleDevice/)).not.toBeInTheDocument();
      expect(screen.getByText('chooseDeviceRoleDescription')).toBeInTheDocument();
    });

    it('is hidden for a count of zero', () => {
      render(<ChooseDeviceRole deviceCount={0} onSubmit={jest.fn()} />);

      expect(screen.queryByText(/chooseDeviceRoleDevice/)).not.toBeInTheDocument();
    });

    it('uses the singular line for one device', () => {
      render(<ChooseDeviceRole deviceCount={1} onSubmit={jest.fn()} />);

      expect(screen.getByText('chooseDeviceRoleDevice')).toBeInTheDocument();
      expect(screen.queryByText(/chooseDeviceRoleDevices/)).not.toBeInTheDocument();
    });

    it('uses the plural line with the count for more devices', () => {
      render(<ChooseDeviceRole deviceCount={3} onSubmit={jest.fn()} />);

      expect(screen.getByText('chooseDeviceRoleDevices:3')).toBeInTheDocument();
    });
  });
});
