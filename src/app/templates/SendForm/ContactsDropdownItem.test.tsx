import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SendFormSelectors } from '../SendForm.selectors';
import ContactsDropdownItem from './ContactsDropdownItem';

// `useTranslation` is the only impure hook the component uses; stub it so
// `t('ownAccount')` deterministically renders its key (mirrors the sibling
// ContactsDropdown test and the atom tests — Alert/ColorIdenticon/FormField).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

// Stub the design-system Button with a ref-forwarding <button> so the
// component's `useRef` → `ref.current?.scrollIntoView(...)` effect can reach a
// real DOM node (the repo's canonical Button mock does NOT forward refs, which
// would leave `ref.current` null and skip the scroll branch). `variant` is
// surfaced as `data-variant` and every other prop (className, data-testid,
// type, tabIndex, onClick, …) is spread straight through for assertion.
jest.mock('components/Button', () => {
  const ReactActual = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
    Button: ReactActual.forwardRef(({ children, variant, ...rest }: any, ref: any) =>
      ReactActual.createElement('button', { ref, 'data-variant': variant, ...rest }, children)
    )
  };
});

// Keep the unit hermetic: stub the three atoms so we assert the props the
// component threads into them without dragging in randomColor / Avatar /
// truncateAddress. Coverage is collected only for ContactsDropdownItem.tsx.
jest.mock('app/atoms/ColorIdenticon', () => ({
  __esModule: true,
  default: ({ publicKey, className }: any) => (
    <div data-testid="color-identicon" data-public-key={publicKey} className={className} />
  )
}));

jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: ({ address }: any) => <span data-testid="address-short-view">{address}</span>
}));

jest.mock('app/atoms/Name', () => ({
  __esModule: true,
  default: ({ children, className }: any) => (
    <div data-testid="name" className={className}>
      {children}
    </div>
  )
}));

// jsdom does not implement scrollIntoView; install a spy on the prototype (the
// mocked Button forwards the ref to a real jsdom <button>, so this is what the
// active-branch effect ends up calling).
let scrollIntoViewSpy: jest.Mock;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  scrollIntoViewSpy = jest.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const button = () => screen.getByRole('button');

describe('ContactsDropdownItem', () => {
  it('renders a Ghost, type=button, tabIndex=-1 button with the default contact-item testID', () => {
    render(<ContactsDropdownItem />);

    const btn = button();
    expect(btn).toBeInTheDocument();
    // `data-testid={testID ?? SendFormSelectors.ContactItemButton}` → default branch.
    expect(btn).toHaveAttribute('data-testid', SendFormSelectors.ContactItemButton);
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveAttribute('tabindex', '-1');
    // `variant={ButtonVariant.Ghost}`.
    expect(btn).toHaveAttribute('data-variant', 'ghost');
  });

  it('renders the identicon, name, address and ownAccount chip with their hard-coded placeholder data', () => {
    render(<ContactsDropdownItem />);

    // ColorIdenticon receives the placeholder publicKey + `shrink-0` class.
    const identicon = screen.getByTestId('color-identicon');
    expect(identicon).toHaveAttribute('data-public-key', 'contact.address');
    expect(identicon).toHaveClass('shrink-0');

    // Name renders the placeholder contact name.
    expect(screen.getByTestId('name')).toHaveTextContent('contact.name');

    // AddressShortView receives the placeholder address.
    expect(screen.getByTestId('address-short-view')).toHaveTextContent('contact.address');

    // `t('ownAccount')` → stubbed useTranslation returns the key verbatim.
    expect(screen.getByText('ownAccount')).toBeInTheDocument();
  });

  it('applies the inactive class set and does NOT scroll when `active` is omitted (falsy branch)', () => {
    render(<ContactsDropdownItem />);

    const btn = button();
    // `active ? 'bg-gray-100' : 'hover:bg-gray-100 focus:bg-gray-100'` → false branch.
    expect(btn).toHaveClass('hover:bg-gray-100', 'focus:bg-gray-100');
    expect(btn).not.toHaveClass('bg-gray-100');
    // Static base classes from the classNames(...) call.
    expect(btn).toHaveClass('h-auto', 'w-full', 'rounded-none', 'justify-start', 'text-black');

    // Effect runs but `if (active)` is false → no scroll.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it('applies the active class and scrolls into view when `active` is true (truthy branch)', () => {
    render(<ContactsDropdownItem active />);

    const btn = button();
    // `active ? 'bg-gray-100' : …` → true branch.
    expect(btn).toHaveClass('bg-gray-100');
    expect(btn).not.toHaveClass('hover:bg-gray-100');

    // `ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })`.
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('re-runs the scroll effect only when `active` transitions to true', () => {
    const { rerender } = render(<ContactsDropdownItem active={false} />);
    // Initial inactive render: effect fires, active is false → no scroll.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    // false → true: dependency `[active]` changed, active branch now scrolls.
    rerender(<ContactsDropdownItem active />);
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    // true → false: effect re-runs but active is false → still one scroll total.
    rerender(<ContactsDropdownItem active={false} />);
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit testID over the default and forwards passthrough props via {...rest}', () => {
    const onClick = jest.fn();
    render(<ContactsDropdownItem testID="custom-contact-id" onClick={onClick} aria-label="pick-alice" />);

    const btn = button();
    // `testID ?? SendFormSelectors.ContactItemButton` → left (truthy) branch.
    expect(btn).toHaveAttribute('data-testid', 'custom-contact-id');
    // Arbitrary DOM props flow through the `{...rest}` spread onto the button.
    expect(btn).toHaveAttribute('aria-label', 'pick-alice');

    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('destructures testIDProperties out of {...rest} so it never lands on the DOM node', () => {
    render(<ContactsDropdownItem testID="dd-item" testIDProperties={{ foo: 'bar' }} />);

    const btn = button();
    expect(btn).toHaveAttribute('data-testid', 'dd-item');
    // testIDProperties is consumed by the destructure, not spread onto <button>.
    expect(btn).not.toHaveAttribute('testIDProperties');
    expect(btn).not.toHaveAttribute('testidproperties');
  });
});
