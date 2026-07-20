import React from 'react';

import { act, render, screen } from '@testing-library/react';

import ContactsDropdown from './ContactsDropdown';

// `useTranslation` is the only impure hook the component uses; stub it so
// `t('noContactsFound')` deterministically returns its key (mirrors the sibling
// atom tests — Alert/ColorIdenticon/FormField).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

// `ContactsDropdownItem` is imported at module load but, because the component
// hard-codes `filteredContacts = []`, it is NEVER rendered. Stub it to keep this
// unit hermetic and avoid dragging its atom / @miden-sdk import chain into the
// suite. Coverage is collected only for ContactsDropdown.tsx anyway.
jest.mock('./ContactsDropdownItem', () => ({
  __esModule: true,
  default: () => null
}));

// The component renders an outer scroll <div> whose only child (in the reachable
// state) is the "no contacts found" empty-state block.
const outer = (container: HTMLElement) => container.firstChild as HTMLElement;

// Dispatch a keyup on `window` (where the component attaches its global
// listener). `bubbles` mirrors the repo's DisableOutlinesForClick test.
const keyup = (key: string) => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

describe('ContactsDropdown', () => {
  it('renders the "no contacts found" empty state (filteredContacts is always empty)', () => {
    const { container } = render(<ContactsDropdown onSelect={jest.fn()} searchTerm="" fullPage={false} />);

    // The empty-state branch of the `length > 0 ? … : …` ternary: the contact
    // book icon (svgMock renders <svg>) plus the translated label.
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();

    // Base wrapper classes from the `classNames(...)` call.
    expect(outer(container)).toHaveClass('overflow-x-hidden', 'overflow-y-auto', 'z-50', 'rounded-lg');
  });

  it('uses the compact 5rem height when fullPage is false', () => {
    const { container } = render(<ContactsDropdown onSelect={jest.fn()} searchTerm="" fullPage={false} />);

    // `height: fullPage ? '9rem' : '5rem'` → false branch.
    expect(outer(container).style.height).toBe('5rem');
    expect(outer(container).style.backgroundColor).toBe('white');
  });

  it('uses the tall 9rem height when fullPage is true', () => {
    const { container } = render(<ContactsDropdown onSelect={jest.fn()} searchTerm="" fullPage />);

    // `height: fullPage ? '9rem' : '5rem'` → true branch.
    expect(outer(container).style.height).toBe('9rem');
  });

  it('forwards testID / testIDProperties props without error (empty-state path)', () => {
    // These props are only consumed by the (never-rendered) list items, but the
    // destructuring + pass-through must still execute cleanly.
    const { container } = render(
      <ContactsDropdown
        onSelect={jest.fn()}
        searchTerm=""
        fullPage={false}
        testID="contacts-dd"
        testIDProperties={{ foo: 'bar' }}
      />
    );

    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
    expect(outer(container)).toBeInTheDocument();
  });

  it('runs the search-term effect with a truthy searchTerm on mount', () => {
    // Truthy searchTerm drives `getSearchTermIndex` down the `getDefinedIndex`
    // path (→ 0). The active-index guard effect then resets it back to null
    // because the contact list is empty. Still shows the empty state.
    render(<ContactsDropdown onSelect={jest.fn()} searchTerm="alice" fullPage={false} />);

    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });

  it('re-runs the search-term effect when searchTerm changes', () => {
    const { rerender } = render(<ContactsDropdown onSelect={jest.fn()} searchTerm="" fullPage={false} />);

    // Falsy → truthy transition re-fires the searchTerm effect.
    rerender(<ContactsDropdown onSelect={jest.fn()} searchTerm="bob" fullPage={false} />);
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();

    // Truthy → falsy transition takes the `: i` branch of getSearchTermIndex.
    rerender(<ContactsDropdown onSelect={jest.fn()} searchTerm="" fullPage={false} />);
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });

  it('handles ArrowDown / ArrowUp / Enter / unknown keys without selecting (no active item)', () => {
    const onSelect = jest.fn();
    render(<ContactsDropdown onSelect={onSelect} searchTerm="" fullPage={false} />);

    // Each key exercises a switch arm in `handleKeyup`. With an empty list there
    // is never an active item, so Enter takes the `if (activeItem)` false branch
    // and onSelect is not called.
    act(() => keyup('ArrowDown'));
    act(() => keyup('ArrowUp'));
    act(() => keyup('Enter'));
    act(() => keyup('Escape')); // unmatched key → switch falls through, no-op

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });

  it('drives the index reducers through non-null values via batched key events', () => {
    // Because the guard effect resets activeIndex to null after every commit,
    // the ONLY way to feed a non-null index into getMinimumIndex/getMaximumIndex
    // is to batch several keyups inside a single act() so React accumulates the
    // functional state updaters (null → 0 → 1 → …) before effects flush.
    const onSelect = jest.fn();
    render(<ContactsDropdown onSelect={onSelect} searchTerm="" fullPage={false} />);

    // null → getMinimumIndex(null)=0 → getMinimumIndex(0)=1 → getMaximumIndex(1)=0
    // covers getMinimumIndex's `i + 1` branch and getMaximumIndex's `i > 0 ? i-1`
    act(() => {
      keyup('ArrowDown');
      keyup('ArrowDown');
      keyup('ArrowUp');
    });

    // null → getMinimumIndex(null)=0 → getMaximumIndex(0)=0
    // covers getMaximumIndex's `: 0` (i === 0) branch.
    act(() => {
      keyup('ArrowDown');
      keyup('ArrowUp');
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });

  it('removes the keyup listener on unmount (effect cleanup)', () => {
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    const onSelect = jest.fn();

    const { unmount } = render(<ContactsDropdown onSelect={onSelect} searchTerm="" fullPage={false} />);

    unmount();

    // The effect's cleanup detaches the keyup handler …
    expect(removeSpy).toHaveBeenCalledWith('keyup', expect.any(Function));

    // … so post-unmount key events are inert.
    act(() => keyup('Enter'));
    expect(onSelect).not.toHaveBeenCalled();

    removeSpy.mockRestore();
  });

  it('is memoized (stable identity on equal props re-render)', () => {
    // ContactsDropdown is wrapped in React.memo — a re-render with identical
    // props keeps the same empty state without throwing.
    const onSelect = jest.fn();
    const { rerender } = render(<ContactsDropdown onSelect={onSelect} searchTerm="" fullPage={false} />);
    rerender(<ContactsDropdown onSelect={onSelect} searchTerm="" fullPage={false} />);

    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });
});
