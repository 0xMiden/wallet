import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

import FormField, { PASSWORD_ERROR_CAPTION } from './FormField';

// i18n: return the key so we can assert on stable strings.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// FormField calls useCopyToClipboard() directly and forwards `copy` to the
// CopyIcon onClick. A stable jest.fn (captured in the factory closure) lets us
// assert it was invoked without depending on the real clipboard plumbing.
jest.mock('lib/ui/useCopyToClipboard', () => {
  const copy = jest.fn();
  return {
    __esModule: true,
    default: jest.fn(() => ({ copy, fieldRef: { current: null }, copied: false, setCopied: jest.fn() }))
  };
});

// Stub the child atoms so the test exercises FormField's own branches without
// dragging in tippy / analytics / haptics. The stubs preserve the props
// FormField relies on (onClick, style, text, children).
jest.mock('app/atoms/CleanButton', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ({ onClick }: { onClick: () => void }) =>
      ReactLib.createElement('button', { type: 'button', 'data-testid': 'clean-button', onClick })
  };
});

jest.mock('app/atoms/CopyButton', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ({ children, text, style }: any) =>
      ReactLib.createElement(
        'div',
        {
          'data-testid': 'copy-button',
          'data-text': String(text),
          'data-bottom': style?.bottom,
          'data-right': style?.right
        },
        children
      )
  };
});

const getInput = (container: HTMLElement) => container.querySelector('input') as HTMLInputElement;
const getTextarea = (container: HTMLElement) => container.querySelector('textarea') as HTMLTextAreaElement;

describe('FormField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a plain text input with the repo defaults', () => {
    const { container } = render(<FormField />);

    const input = getInput(container);
    expect(input).toBeInTheDocument();
    // spellCheck / autoComplete defaults
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    // non-password + no extraInner -> pr-4
    expect(input.className).toContain('pr-4');
    // no error -> gray border, bottom margin present by default
    expect(input.className).toContain('border-gray-100');
    // no label rendered
    expect(container.querySelector('label')).not.toBeInTheDocument();
  });

  it('honours fieldWrapperBottomMargin=false and passes through arbitrary props', () => {
    const { container } = render(
      <FormField fieldWrapperBottomMargin={false} placeholder="type here" name="myfield" data-testid="ff" />
    );

    const input = getInput(container);
    expect(input).toHaveAttribute('placeholder', 'type here');
    expect(input).toHaveAttribute('name', 'myfield');
    expect(screen.getByTestId('ff')).toBe(input);

    const fieldWrapper = input.parentElement as HTMLElement;
    expect(fieldWrapper.className).not.toContain('mb-2');
  });

  it('renders a textarea when the textarea prop is set', () => {
    const { container } = render(<FormField textarea />);

    expect(getTextarea(container)).toBeInTheDocument();
    expect(container.querySelector('input')).not.toBeInTheDocument();
  });

  it('applies container className / style to the root element', () => {
    const { container } = render(
      <FormField containerClassName="my-container" containerStyle={{ marginTop: 8 }} />
    );

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('my-container');
    expect(root).toHaveStyle({ marginTop: '8px' });
  });

  it('forwards the ref to the underlying field element', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<FormField ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  describe('LabelComponent', () => {
    it('renders label, description and warning wired to the field id', () => {
      render(
        <FormField
          id="field-id"
          label="My label"
          labelDescription="Some description"
          labelWarning="Careful!"
          labelPaddingClassName="pad-class"
          labelClassName="label-class"
          labelDescriptionClassName="desc-class"
        />
      );

      const label = screen.getByText('My label');
      expect(label).toBeInTheDocument();
      expect(label).toHaveClass('pad-class', 'label-class');
      expect(label.closest('label')).toHaveAttribute('for', 'field-id');

      const description = screen.getByText('Some description');
      expect(description).toBeInTheDocument();
      expect(description).toHaveClass('desc-class');

      expect(screen.getByText('Careful!')).toBeInTheDocument();
    });

    it('renders a label without description/warning', () => {
      const { container } = render(<FormField label="Only label" />);

      expect(screen.getByText('Only label')).toBeInTheDocument();
      // no description / warning spans
      expect(container.querySelectorAll('label span')).toHaveLength(1);
    });
  });

  describe('password handling', () => {
    it('shows the password toggle when a value is present and toggles the input type', () => {
      const { container } = render(<FormField type="password" defaultValue="secret" />);

      const input = getInput(container);
      // isPasswordInput -> pr-12
      expect(input.className).toContain('pr-12');
      expect(input.getAttribute('type')).toBe('password');

      const toggle = screen.getByRole('button');
      act(() => {
        fireEvent.click(toggle);
      });
      expect(getInput(container).getAttribute('type')).toBe('text');

      act(() => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(getInput(container).getAttribute('type')).toBe('password');
    });

    it('hides the password toggle when the value is empty', () => {
      render(<FormField type="password" />);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('ErrorCaption', () => {
    it('renders a normal error caption and a red border', () => {
      const { container } = render(<FormField errorCaption="Required field" />);

      expect(screen.getByText('Required field')).toBeInTheDocument();
      expect(getInput(container).className).toContain('border-red-500');
    });

    it('does not render the caption for the password-strength sentinel', () => {
      render(<FormField errorCaption={PASSWORD_ERROR_CAPTION} />);

      expect(screen.queryByText(PASSWORD_ERROR_CAPTION)).not.toBeInTheDocument();
    });

    it('renders no caption when errorCaption is absent', () => {
      const { container } = render(<FormField />);

      expect(container.querySelector('.text-red-500')).not.toBeInTheDocument();
    });
  });

  describe('secret textarea banner', () => {
    it('shows the banner for a secret textarea with a value and focuses the field on click', () => {
      const { container } = render(<FormField textarea secret defaultValue="mnemonic words" />);

      const textarea = getTextarea(container);
      expect(textarea.className).toContain('border-border-light');

      const banner = screen.getByText('clickToRevealField');
      expect(banner).toBeInTheDocument();

      act(() => {
        fireEvent.click(banner);
      });
      // handleSecretBannerClick -> getFieldEl().focus()
      expect(document.activeElement).toBe(textarea);
    });

    it('derives the initial value from `value` when provided', () => {
      render(<FormField textarea secret value="controlled" onChange={() => undefined} />);

      expect(screen.getByText('clickToRevealField')).toBeInTheDocument();
    });

    it('does not show the banner when secret is set but textarea is not', () => {
      render(<FormField secret defaultValue="not a textarea" />);

      expect(screen.queryByText('clickToRevealField')).not.toBeInTheDocument();
    });

    it('does not show the banner for an empty secret textarea', () => {
      render(<FormField textarea secret />);

      expect(screen.queryByText('clickToRevealField')).not.toBeInTheDocument();
    });
  });

  describe('secret textarea auto-blur effect', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('registers a window blur listener and a 30s timeout, then cleans up', () => {
      const addSpy = jest.spyOn(window, 'addEventListener');
      const removeSpy = jest.spyOn(window, 'removeEventListener');

      const { container, unmount } = render(<FormField textarea secret defaultValue="secret value" />);
      const textarea = getTextarea(container);

      act(() => {
        fireEvent.focus(textarea);
      });
      expect(addSpy).toHaveBeenCalledWith('blur', expect.any(Function));

      // window-blur path -> handleLocalBlur -> getFieldEl().blur()
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      // let the 30s timeout fire -> handleLocalBlur again
      act(() => {
        jest.advanceTimersByTime(30_000);
      });

      // unmount tears the effect down -> clearTimeout + removeEventListener
      unmount();
      expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });
  });

  describe('change / focus / blur handlers', () => {
    it('invokes the provided onChange / onFocus / onBlur callbacks', () => {
      const onChange = jest.fn();
      const onFocus = jest.fn();
      const onBlur = jest.fn();
      const { container } = render(
        <FormField defaultValue="x" onChange={onChange} onFocus={onFocus} onBlur={onBlur} />
      );

      const input = getInput(container);
      act(() => {
        fireEvent.change(input, { target: { value: 'abc' } });
      });
      act(() => {
        fireEvent.focus(input);
      });
      act(() => {
        fireEvent.blur(input);
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('does not throw when change / focus / blur fire without user callbacks', () => {
      const { container } = render(<FormField />);
      const input = getInput(container);

      expect(() => {
        act(() => {
          fireEvent.change(input, { target: { value: 'abc' } });
          fireEvent.focus(input);
          fireEvent.blur(input);
        });
      }).not.toThrow();
    });
  });

  describe('Cleanable', () => {
    it('renders a clean button that calls onClean', () => {
      const onClean = jest.fn();
      render(<FormField cleanable onClean={onClean} />);

      act(() => {
        fireEvent.click(screen.getByTestId('clean-button'));
      });
      expect(onClean).toHaveBeenCalledTimes(1);
    });

    it('renders a clean button that is a no-op when onClean is omitted', () => {
      render(<FormField cleanable />);

      expect(() => {
        act(() => {
          fireEvent.click(screen.getByTestId('clean-button'));
        });
      }).not.toThrow();
    });

    it('renders no clean button when cleanable is false', () => {
      render(<FormField />);

      expect(screen.queryByTestId('clean-button')).not.toBeInTheDocument();
    });
  });

  describe('Copyable', () => {
    it('renders a copy button and invokes copy() when the icon is clicked (no cleanable offset)', () => {
      const copy = (useCopyToClipboard as unknown as jest.Mock)().copy;

      render(<FormField copyable value="copy me" onChange={() => undefined} />);

      const copyButton = screen.getByTestId('copy-button');
      expect(copyButton).toHaveAttribute('data-text', 'copy me');
      // cleanable falsy -> bottom 0px / right 5px
      expect(copyButton).toHaveAttribute('data-bottom', '0px');
      expect(copyButton).toHaveAttribute('data-right', '5px');

      const icon = copyButton.querySelector('svg') as SVGElement;
      act(() => {
        fireEvent.click(icon);
      });
      expect(copy).toHaveBeenCalled();
    });

    it('offsets the copy button when the field is also cleanable', () => {
      render(<FormField copyable cleanable value="copy me" onChange={() => undefined} />);

      const copyButton = screen.getByTestId('copy-button');
      expect(copyButton).toHaveAttribute('data-bottom', '3px');
      expect(copyButton).toHaveAttribute('data-right', '30px');
    });

    it('renders no copy button when copyable is false', () => {
      render(<FormField />);

      expect(screen.queryByTestId('copy-button')).not.toBeInTheDocument();
    });
  });

  describe('ExtraInner', () => {
    it('wraps the inner component in the default wrapper and applies pr-20', () => {
      const { container } = render(<FormField extraInner={<span data-testid="inner">inside</span>} />);

      const inner = screen.getByTestId('inner');
      expect(inner).toBeInTheDocument();
      // default wrapper present (div.pointer-events-none > span.mx-4 > innerComponent)
      expect(inner.closest('.pointer-events-none')).not.toBeNull();
      // extraInner truthy -> pr-20
      expect(getInput(container).className).toContain('pr-20');
    });

    it('renders the inner component directly when useDefaultInnerWrapper is false', () => {
      render(
        <FormField useDefaultInnerWrapper={false} extraInner={<span data-testid="inner-bare">bare</span>} />
      );

      const inner = screen.getByTestId('inner-bare');
      expect(inner).toBeInTheDocument();
      // not wrapped in the pointer-events-none default wrapper
      expect(inner.closest('.pointer-events-none')).toBeNull();
    });
  });

  it('renders extraSection, dropdownInner and extraButton slots', () => {
    render(
      <FormField
        extraSection={<div data-testid="extra-section" />}
        dropdownInner={<div data-testid="dropdown-inner" />}
        extraButton={<div data-testid="extra-button" />}
      />
    );

    expect(screen.getByTestId('extra-section')).toBeInTheDocument();
    expect(screen.getByTestId('dropdown-inner')).toBeInTheDocument();
    expect(screen.getByTestId('extra-button')).toBeInTheDocument();
  });
});
