import React from 'react';

import { render, screen } from '@testing-library/react';

import HashChip from './HashChip';

// HashChip is a thin composition component: it wires a `CopyButton` around a
// `HashShortView` plus an optional copy `Icon`, forwarding/renaming props to
// each child. We stub all three children to lightweight markers so we can
// assert exactly which props HashChip forwards where, and exercise every
// default-parameter and conditional-render branch.

const mockCopyButtonProps = jest.fn();
const mockHashShortViewProps = jest.fn();

jest.mock('app/atoms/CopyButton', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockCopyButtonProps(props);
    // Render children so the inner span / HashShortView / Icon end up in the DOM.
    return <div data-testid="copy-button">{props.children as React.ReactNode}</div>;
  }
}));

jest.mock('app/atoms/HashShortView', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockHashShortViewProps(props);
    return <span data-testid="hash-short-view" />;
  }
}));

jest.mock('app/icons/v2', () => ({
  IconName: { Copy: 'copy' },
  Icon: (props: { name: string; size?: string; fill?: string; className?: string }) => (
    <span data-testid="copy-icon" data-name={props.name} data-size={props.size} data-fill={props.fill} />
  )
}));

describe('HashChip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders with default params: button type, xs/black copy icon, and forwards the hash', () => {
    // No optional props → every defaulted destructure param takes its default
    // branch (type='button', size='xs', fill='black', copyIcon=true).
    const hash = '0xabcdef0123456789';
    render(<HashChip hash={hash} />);

    // CopyButton receives the hash as its `text` and the default `type`.
    const copyProps = mockCopyButtonProps.mock.calls[0][0];
    expect(copyProps.text).toBe(hash);
    expect(copyProps.type).toBe('button');

    // The inner flex wrapper span is present.
    const { container } = render(<HashChip hash={hash} />);
    expect(container.querySelector('span.flex.flex-row.items-center')).toBeInTheDocument();

    // HashShortView receives the hash; all trimming props are undefined by default.
    const hsvProps = mockHashShortViewProps.mock.calls[0][0];
    expect(hsvProps).toEqual({
      hash,
      trimHash: undefined,
      trimAfter: undefined,
      firstCharsCount: undefined,
      lastCharsCount: undefined,
      displayName: undefined
    });

    // The copy Icon is rendered with the default size/fill and the Copy name.
    const icon = screen.getAllByTestId('copy-icon')[0];
    expect(icon).toHaveAttribute('data-name', 'copy');
    expect(icon).toHaveAttribute('data-size', 'xs');
    expect(icon).toHaveAttribute('data-fill', 'black');
  });

  it('omits the copy icon when copyIcon is false', () => {
    // The `copyIcon && <Icon />` branch: false → no Icon in the DOM.
    render(<HashChip hash="0xdeadbeef" copyIcon={false} />);

    expect(screen.queryByTestId('copy-icon')).not.toBeInTheDocument();
    // HashShortView is still rendered.
    expect(screen.getByTestId('hash-short-view')).toBeInTheDocument();
  });

  it('forwards explicit type/size/fill and copyIcon=true, and routes trim + pass-through props', () => {
    // Provides every optional param so the non-default branch of each default
    // parameter is taken, and confirms the prop routing:
    //   - size/fill      -> Icon
    //   - type           -> CopyButton
    //   - trim* / displayName -> HashShortView
    //   - everything else (...rest) -> CopyButton
    const onClick = jest.fn();
    render(
      <HashChip
        hash="hashy"
        type="link"
        size="sm"
        fill="white"
        copyIcon
        className="extra-class"
        small
        rounded="base"
        bgShade={200}
        textShade={700}
        trimHash={false}
        trimAfter={10}
        firstCharsCount={2}
        lastCharsCount={3}
        displayName="My Wallet"
        id="chip-id"
        onClick={onClick}
      />
    );

    // Icon picks up the explicit size/fill.
    const icon = screen.getByTestId('copy-icon');
    expect(icon).toHaveAttribute('data-size', 'sm');
    expect(icon).toHaveAttribute('data-fill', 'white');
    expect(icon).toHaveAttribute('data-name', 'copy');

    // CopyButton: text + explicit type, plus all the ...rest pass-through props.
    // Crucially, size/fill/copyIcon and the trim* props are NOT forwarded here
    // (they were destructured out before `...rest`).
    const copyProps = mockCopyButtonProps.mock.calls[0][0];
    expect(copyProps.text).toBe('hashy');
    expect(copyProps.type).toBe('link');
    expect(copyProps.className).toBe('extra-class');
    expect(copyProps.small).toBe(true);
    expect(copyProps.rounded).toBe('base');
    expect(copyProps.bgShade).toBe(200);
    expect(copyProps.textShade).toBe(700);
    expect(copyProps.id).toBe('chip-id');
    expect(copyProps.onClick).toBe(onClick);
    expect(copyProps.size).toBeUndefined();
    expect(copyProps.fill).toBeUndefined();
    expect(copyProps.copyIcon).toBeUndefined();
    expect(copyProps.trimHash).toBeUndefined();
    expect(copyProps.displayName).toBeUndefined();

    // HashShortView receives the trimming props and the displayName.
    const hsvProps = mockHashShortViewProps.mock.calls[0][0];
    expect(hsvProps).toEqual({
      hash: 'hashy',
      trimHash: false,
      trimAfter: 10,
      firstCharsCount: 2,
      lastCharsCount: 3,
      displayName: 'My Wallet'
    });
  });
});
