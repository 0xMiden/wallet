import React from 'react';

import { render, screen } from '@testing-library/react';

import AddressChip from './AddressChip';

// AddressChip is a pure presentational wrapper. Its only job is to forward the
// right props to three children — `CopyButton`, `AddressShortView` and the copy
// `Icon` — while applying its own defaults (`type`, `size`, `className`,
// `copyIcon`) and always pinning the button's className to `p-0!`.
//
// We replace each direct child with a prop-recording stub so every forwarded
// value is asserted precisely, without dragging in CopyButton's hook stack
// (tippy / clipboard / analytics / haptics) or the SVG icon switch. The stubs
// follow the sibling-test convention of `mock`-prefixed spies referenced inside
// the (hoisted) `jest.mock` factories.
const mockCopyButtonProps = jest.fn();
const mockAddressShortViewProps = jest.fn();
const mockIconProps = jest.fn();

// The CopyButton stub MUST render `children`, otherwise the nested
// AddressShortView / Icon stubs would never be invoked.
jest.mock('app/atoms/CopyButton', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockCopyButtonProps(props);
    return <button data-testid="copy-button">{props.children as React.ReactNode}</button>;
  }
}));

jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockAddressShortViewProps(props);
    return <span data-testid="address-short-view" />;
  }
}));

jest.mock('app/icons/v2', () => ({
  __esModule: true,
  Icon: (props: Record<string, unknown>) => {
    mockIconProps(props);
    return <span data-testid="copy-icon" />;
  },
  IconName: { Copy: 'copy' }
}));

const ADDRESS = '0xabcdef0123456789abcdef0123456789';

beforeEach(() => {
  mockCopyButtonProps.mockClear();
  mockAddressShortViewProps.mockClear();
  mockIconProps.mockClear();
});

describe('AddressChip', () => {
  it('applies every default (type/size/className/copyIcon) when only `address` is given', () => {
    render(<AddressChip address={ADDRESS} />);

    // CopyButton: text = address, default type = 'button', className hard-pinned
    // to 'p-0!' (never the `className` prop, which belongs to the Icon).
    expect(mockCopyButtonProps).toHaveBeenCalledTimes(1);
    const copyProps = mockCopyButtonProps.mock.calls[0][0];
    expect(copyProps.text).toBe(ADDRESS);
    expect(copyProps.type).toBe('button');
    expect(copyProps.className).toBe('p-0!');
    expect(screen.getByTestId('copy-button')).toBeInTheDocument();

    // AddressShortView: address forwarded; displayName/trim omitted → undefined.
    expect(mockAddressShortViewProps).toHaveBeenCalledTimes(1);
    const shortProps = mockAddressShortViewProps.mock.calls[0][0];
    expect(shortProps.address).toBe(ADDRESS);
    expect(shortProps.displayName).toBeUndefined();
    expect(shortProps.trim).toBeUndefined();

    // copyIcon defaults to true → Icon renders with the default size/className.
    expect(mockIconProps).toHaveBeenCalledTimes(1);
    const iconProps = mockIconProps.mock.calls[0][0];
    expect(iconProps.name).toBe('copy');
    expect(iconProps.size).toBe('xs');
    expect(iconProps.className).toBe('ml-4');
    expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
  });

  it('omits the copy Icon when `copyIcon={false}` (falsy branch of `copyIcon && …`)', () => {
    render(<AddressChip address={ADDRESS} copyIcon={false} />);

    // Button + address view still render; only the Icon is gone.
    expect(mockCopyButtonProps).toHaveBeenCalledTimes(1);
    expect(mockAddressShortViewProps).toHaveBeenCalledTimes(1);
    expect(mockIconProps).not.toHaveBeenCalled();
    expect(screen.queryByTestId('copy-icon')).toBeNull();
  });

  it('forwards overridden props and spreads `...rest` onto CopyButton', () => {
    const onClick = jest.fn();

    render(
      <AddressChip
        address={ADDRESS}
        displayName="Alice"
        trim={false}
        type="link"
        size="md"
        className="custom-cls"
        copyIcon
        // `...rest` members: CopyButton-only props + a plain HTML attr + a
        // handler. `fill` is declared in the type but NOT destructured, so it
        // flows through rest to CopyButton (it never reaches the Icon).
        small
        bgShade={200}
        rounded="base"
        textShade={700}
        fill="rgb(1, 2, 3)"
        id="chip-id"
        onClick={onClick}
      />
    );

    const copyProps = mockCopyButtonProps.mock.calls[0][0];
    // Explicit props win.
    expect(copyProps.text).toBe(ADDRESS);
    expect(copyProps.type).toBe('link');
    // className stays pinned regardless of the `className` prop.
    expect(copyProps.className).toBe('p-0!');
    // rest is spread through verbatim.
    expect(copyProps.small).toBe(true);
    expect(copyProps.bgShade).toBe(200);
    expect(copyProps.rounded).toBe('base');
    expect(copyProps.textShade).toBe(700);
    expect(copyProps.fill).toBe('rgb(1, 2, 3)');
    expect(copyProps.id).toBe('chip-id');
    expect(copyProps.onClick).toBe(onClick);

    // AddressShortView receives the overridden display props.
    const shortProps = mockAddressShortViewProps.mock.calls[0][0];
    expect(shortProps.address).toBe(ADDRESS);
    expect(shortProps.displayName).toBe('Alice');
    expect(shortProps.trim).toBe(false);

    // Icon receives the overridden size/className — and specifically NOT `fill`.
    const iconProps = mockIconProps.mock.calls[0][0];
    expect(iconProps.name).toBe('copy');
    expect(iconProps.size).toBe('md');
    expect(iconProps.className).toBe('custom-cls');
    expect(iconProps.fill).toBeUndefined();
  });
});
