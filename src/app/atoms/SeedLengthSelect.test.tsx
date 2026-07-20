import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import { SeedLengthSelect } from './SeedLengthSelect';

// i18n is stubbed to an identity-ish translator that folds the interpolated
// `num` back into the key, so assertions can match the selected/option value
// the component passes through (e.g. `seedInputNumberOfWords:24`).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { num?: string }) => `${key}:${opts?.num ?? ''}`
  })
}));

type Props = React.ComponentProps<typeof SeedLengthSelect>;

// The ref div is `container.firstChild`; its children are [header, <ul>].
const getWrapper = (container: HTMLElement) => container.firstChild as HTMLElement;
const getHeader = (container: HTMLElement) => getWrapper(container).children[0] as HTMLElement;
const getHeaderLabel = (container: HTMLElement) => getHeader(container).querySelector('span') as HTMLElement;
const getList = (container: HTMLElement) => getWrapper(container).children[1] as HTMLElement;
const getItems = (container: HTMLElement) => Array.from(getList(container).querySelectorAll('li')) as HTMLLIElement[];

const renderSelect = (overrides: Partial<Props> = {}) => {
  const setShowSeed = jest.fn();
  const onChange = jest.fn();
  const props: Props = {
    options: ['12', '24'],
    currentOption: '24',
    setShowSeed,
    onChange,
    ...overrides
  };
  const utils = render(<SeedLengthSelect {...props} />);
  return { ...utils, setShowSeed, onChange, props };
};

describe('SeedLengthSelect', () => {
  it('renders the current option label and the dropdown arrow icon', () => {
    const { container } = renderSelect({ currentOption: '24' });

    // Sync effect promotes `currentOption` into the header label on mount.
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:24');
    // The auto-mocked SVG icon renders as an <svg> with the passed classes.
    const icon = getHeader(container).querySelector('svg') as SVGElement;
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass('ml-1', 'w-5', 'h-5');
  });

  it('starts closed with the option list hidden', () => {
    const { container } = renderSelect();
    expect(getList(container)).toHaveClass('hidden');
  });

  it('falls back to an empty initial option when no defaultOption is given', () => {
    // currentOption differs from the '' fallback, so the sync effect fires
    // (not-equal branch) and the header ends on the current option.
    const { container } = renderSelect({ defaultOption: undefined, currentOption: '12' });
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:12');
  });

  it('keeps the provided defaultOption when it already matches currentOption (equal branch)', () => {
    // defaultOption === currentOption means the sync effect takes its no-op
    // (equal) branch on first run.
    const { container } = renderSelect({ defaultOption: '24', currentOption: '24' });
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:24');
  });

  it('toggles the list open and closed when the header is clicked', () => {
    const { container } = renderSelect();

    expect(getList(container)).toHaveClass('hidden');

    fireEvent.click(getHeader(container));
    expect(getList(container)).not.toHaveClass('hidden');

    fireEvent.click(getHeader(container));
    expect(getList(container)).toHaveClass('hidden');
  });

  it('renders one list item per option with the interpolated label', () => {
    const { container } = renderSelect({ options: ['12', '18', '24'], currentOption: '24' });

    fireEvent.click(getHeader(container));
    const items = getItems(container);

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('seedInputNumberOfWords:12');
    expect(items[1]).toHaveTextContent('seedInputNumberOfWords:18');
    expect(items[2]).toHaveTextContent('seedInputNumberOfWords:24');
  });

  it('highlights the selected option and leaves the rest unselected', () => {
    const { container } = renderSelect({ options: ['12', '24'], currentOption: '24' });

    fireEvent.click(getHeader(container));
    const [twelve, twentyFour] = getItems(container);

    // selectedOption === option → highlighted; otherwise the plain/white style.
    expect(twentyFour).toHaveClass('bg-gray-25');
    expect(twentyFour).not.toHaveClass('bg-white');
    expect(twelve).toHaveClass('bg-white', 'hover:bg-gray-100');
    expect(twelve).not.toHaveClass('bg-gray-25');
  });

  it('selects an option: closes the list, reveals the seed, updates label and fires onChange', () => {
    const { container, setShowSeed, onChange } = renderSelect({ options: ['12', '24'], currentOption: '24' });

    fireEvent.click(getHeader(container));
    const [twelve] = getItems(container);

    fireEvent.click(twelve);

    expect(setShowSeed).toHaveBeenCalledTimes(1);
    expect(setShowSeed).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('12');
    // The dropdown collapsed again after the selection.
    expect(getList(container)).toHaveClass('hidden');
    // The list is parent-controlled: onChange notifies the parent, but with
    // `currentOption` unchanged in isolation the sync effect immediately
    // re-pins the header back to `currentOption`.
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:24');
  });

  it('closes the list on an outside mousedown (outside branch)', () => {
    const { container } = renderSelect();

    fireEvent.click(getHeader(container));
    expect(getList(container)).not.toHaveClass('hidden');

    // A mousedown outside the ref subtree collapses the dropdown.
    fireEvent.mouseDown(document.body);
    expect(getList(container)).toHaveClass('hidden');
  });

  it('keeps the list open on a mousedown inside the component (inside branch)', () => {
    const { container } = renderSelect();

    fireEvent.click(getHeader(container));
    expect(getList(container)).not.toHaveClass('hidden');

    // A mousedown on an element contained by the ref must NOT close it.
    fireEvent.mouseDown(getHeaderLabel(container));
    expect(getList(container)).not.toHaveClass('hidden');
  });

  it('re-syncs the header when the currentOption prop changes', () => {
    const { container, rerender, props } = renderSelect({ currentOption: '12' });
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:12');

    rerender(<SeedLengthSelect {...props} currentOption="24" />);
    expect(getHeaderLabel(container)).toHaveTextContent('seedInputNumberOfWords:24');
  });

  it('removes the outside-click listener on unmount (effect cleanup)', () => {
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    const { unmount } = renderSelect();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
    removeSpy.mockRestore();
  });
});
