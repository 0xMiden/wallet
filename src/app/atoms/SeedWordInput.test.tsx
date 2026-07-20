import React from 'react';

import { fireEvent, render, screen, act } from '@testing-library/react';

import { SeedWordInput } from './SeedWordInput';

// react-i18next: return the key verbatim so we can assert on `clickToReveal`.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

type Props = React.ComponentProps<typeof SeedWordInput>;

const renderInput = (overrides: Partial<Props> = {}) => {
  const setShowSeed = jest.fn();
  const props: Props = {
    id: 0,
    submitted: false,
    showSeed: false,
    setShowSeed,
    ...overrides
  };
  const utils = render(<SeedWordInput {...props} />);
  return { ...utils, setShowSeed, props };
};

const getInput = () => screen.getByRole('textbox') as HTMLInputElement;

describe('SeedWordInput', () => {
  it('renders the 1-based label derived from id', () => {
    renderInput({ id: 4 });

    expect(screen.getByText('#5')).toBeInTheDocument();
  });

  it('applies error styling when submitted without a value', () => {
    const { container } = renderInput({ submitted: true, value: '' });

    const label = container.querySelector('label') as HTMLElement;
    expect(label).toHaveClass('text-red-600');
    expect(label).not.toHaveClass('text-black');
    expect(getInput()).toHaveClass('border-red-500');
    expect(getInput()).not.toHaveClass('border-gray-100');
  });

  it('does not apply error styling when submitted with a value', () => {
    const { container } = renderInput({ submitted: true, value: 'apple' });

    const label = container.querySelector('label') as HTMLElement;
    expect(label).toHaveClass('text-black');
    expect(getInput()).toHaveClass('border-gray-100');
  });

  it('does not apply error styling when not submitted (even without a value)', () => {
    const { container } = renderInput({ submitted: false, value: '' });

    const label = container.querySelector('label') as HTMLElement;
    expect(label).toHaveClass('text-black');
    expect(getInput()).toHaveClass('border-gray-100');
  });

  it('defaults autoComplete to "off" and forwards value + custom className', () => {
    renderInput({ value: 'seed', className: 'custom-word' });

    const input = getInput();
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveValue('seed');
    expect(input).toHaveClass('custom-word');
  });

  it('forwards a custom autoComplete value', () => {
    renderInput({ value: 'seed', autoComplete: 'on' });

    expect(getInput()).toHaveAttribute('autocomplete', 'on');
  });

  describe('reveal overlay (isWordHidden)', () => {
    it('shows the reveal overlay when there is a value, not focused, and seed is hidden', () => {
      renderInput({ value: 'apple', showSeed: false });

      expect(screen.getByText('clickToReveal')).toBeInTheDocument();
    });

    it('hides the overlay when showSeed is true', () => {
      renderInput({ value: 'apple', showSeed: true });

      expect(screen.queryByText('clickToReveal')).not.toBeInTheDocument();
    });

    it('hides the overlay when there is no value', () => {
      renderInput({ value: '', showSeed: false });

      expect(screen.queryByText('clickToReveal')).not.toBeInTheDocument();
    });

    it('hides the overlay while the input is focused', () => {
      renderInput({ value: 'apple', showSeed: false });

      expect(screen.getByText('clickToReveal')).toBeInTheDocument();

      fireEvent.focus(getInput());

      expect(screen.queryByText('clickToReveal')).not.toBeInTheDocument();
    });

    it('focuses the input and reveals the seed when the overlay is clicked', () => {
      const { setShowSeed } = renderInput({ value: 'apple', showSeed: false });

      const input = getInput();
      const focusSpy = jest.spyOn(input, 'focus');

      fireEvent.click(screen.getByText('clickToReveal').closest('div') as HTMLElement);

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(setShowSeed).toHaveBeenCalledWith(true);
    });
  });

  describe('focus / blur handlers', () => {
    it('resets focus state and hides the seed on blur', () => {
      const { setShowSeed } = renderInput({ value: 'apple', showSeed: false });

      const input = getInput();
      fireEvent.focus(input);
      // Overlay hidden while focused.
      expect(screen.queryByText('clickToReveal')).not.toBeInTheDocument();

      fireEvent.blur(input);

      expect(setShowSeed).toHaveBeenCalledWith(false);
      // Overlay visible again once focus is lost.
      expect(screen.getByText('clickToReveal')).toBeInTheDocument();
    });
  });

  describe('onChange', () => {
    it('invokes the onChange callback when provided', () => {
      const onChange = jest.fn();
      renderInput({ value: '', onChange });

      fireEvent.change(getInput(), { target: { value: 'melon' } });

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('does not throw when onChange is not provided', () => {
      renderInput({ value: '' });

      expect(() => fireEvent.change(getInput(), { target: { value: 'melon' } })).not.toThrow();
    });
  });

  describe('onPaste', () => {
    it('blurs the input and forwards the paste event when onPaste is provided', () => {
      const onPaste = jest.fn();
      renderInput({ value: '', onPaste });

      const input = getInput();
      const blurSpy = jest.spyOn(input, 'blur');

      fireEvent.paste(input);

      expect(blurSpy).toHaveBeenCalledTimes(1);
      expect(onPaste).toHaveBeenCalledTimes(1);
    });

    it('does not blur or throw when onPaste is not provided', () => {
      renderInput({ value: '' });

      const input = getInput();
      const blurSpy = jest.spyOn(input, 'blur');

      expect(() => fireEvent.paste(input)).not.toThrow();
      expect(blurSpy).not.toHaveBeenCalled();
    });
  });

  describe('showSeed auto-hide effect', () => {
    it('hides the seed and blurs the input after the 30s timeout', () => {
      jest.useFakeTimers();
      try {
        const { setShowSeed } = renderInput({ value: 'apple', showSeed: true });

        const input = getInput();
        const blurSpy = jest.spyOn(input, 'blur');

        act(() => {
          jest.advanceTimersByTime(30_000);
        });

        expect(blurSpy).toHaveBeenCalledTimes(1);
        expect(setShowSeed).toHaveBeenCalledWith(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('hides the seed and blurs the input when the window loses focus', () => {
      const { setShowSeed } = renderInput({ value: 'apple', showSeed: true });

      const input = getInput();
      const blurSpy = jest.spyOn(input, 'blur');

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(blurSpy).toHaveBeenCalledTimes(1);
      expect(setShowSeed).toHaveBeenCalledWith(false);
    });

    it('removes the window blur listener on unmount when the seed was shown', () => {
      const removeSpy = jest.spyOn(window, 'removeEventListener');
      const { unmount, setShowSeed } = renderInput({ value: 'apple', showSeed: true });

      unmount();

      expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));

      // After cleanup, a later window blur must not fire the handler again.
      setShowSeed.mockClear();
      window.dispatchEvent(new Event('blur'));
      expect(setShowSeed).not.toHaveBeenCalled();

      removeSpy.mockRestore();
    });

    it('does not register a window blur listener when the seed is hidden', () => {
      const { setShowSeed } = renderInput({ value: 'apple', showSeed: false });

      setShowSeed.mockClear();
      window.dispatchEvent(new Event('blur'));

      expect(setShowSeed).not.toHaveBeenCalled();
    });

    it('tears down the listener when showSeed flips from true to false', () => {
      const setShowSeed = jest.fn();
      const { rerender } = render(
        <SeedWordInput id={0} submitted={false} showSeed value="apple" setShowSeed={setShowSeed} />
      );

      rerender(
        <SeedWordInput
          id={0}
          submitted={false}
          showSeed={false}
          value="apple"
          setShowSeed={setShowSeed}
        />
      );

      setShowSeed.mockClear();
      window.dispatchEvent(new Event('blur'));

      expect(setShowSeed).not.toHaveBeenCalled();
    });
  });
});
