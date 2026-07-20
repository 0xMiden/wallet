import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import SettingToggle from './SettingToggle';

// `app/atoms/ToggleSwitch` pulls in the analytics barrel (SDK-backed) plus the
// native haptics plugin. SettingToggle is a pure presentational wrapper, so we
// swap the child for a plain checkbox that echoes the props SettingToggle
// forwards — letting us assert `checked`, `name`, `onChange` and `testID`
// without touching native/SDK code. (Sibling tests mock child deps the same
// way, e.g. MenuItem stubs `lib/woozie`'s Link.)
jest.mock('app/atoms/ToggleSwitch', () => ({
  __esModule: true,
  default: ({
    checked,
    onChange,
    name,
    testID
  }: {
    checked: boolean;
    onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
    name: string;
    testID: string;
  }) => <input type="checkbox" data-testid={testID} data-name={name} checked={checked} onChange={onChange} />
}));

const baseProps = {
  checked: false,
  onChange: jest.fn(),
  name: 'toggle-name',
  testID: 'toggle-test-id',
  title: 'Toggle title'
};

describe('SettingToggle', () => {
  it('renders the title text', () => {
    render(<SettingToggle {...baseProps} />);

    expect(screen.getByText('Toggle title')).toBeInTheDocument();
  });

  it('renders a label whose `htmlFor` matches the `name` prop', () => {
    const { container } = render(<SettingToggle {...baseProps} />);

    const label = container.querySelector('label')!;
    expect(label).toHaveAttribute('for', 'toggle-name');
  });

  it('forwards `checked`, `name` and `testID` to the ToggleSwitch child', () => {
    render(<SettingToggle {...baseProps} checked name="my-name" testID="my-test-id" />);

    const toggle = screen.getByTestId('my-test-id') as HTMLInputElement;
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute('data-name', 'my-name');
  });

  it('reflects `checked={false}` on the ToggleSwitch child', () => {
    render(<SettingToggle {...baseProps} checked={false} />);

    expect(screen.getByTestId('toggle-test-id')).not.toBeChecked();
  });

  it('forwards the `onChange` handler to the ToggleSwitch child', () => {
    const onChange = jest.fn();
    render(<SettingToggle {...baseProps} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('toggle-test-id'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders the description span when `description` is provided (truthy branch)', () => {
    render(<SettingToggle {...baseProps} description="Some helpful description" />);

    expect(screen.getByText('Some helpful description')).toBeInTheDocument();
  });

  it('omits the description span when `description` is undefined (falsy branch)', () => {
    const { container } = render(<SettingToggle {...baseProps} />);

    // Only the title span renders; the optional description span is absent.
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toHaveTextContent('Toggle title');
  });

  it('omits the description span when `description` is an empty string (falsy branch)', () => {
    const { container } = render(<SettingToggle {...baseProps} description="" />);

    expect(container.querySelectorAll('span')).toHaveLength(1);
  });
});
