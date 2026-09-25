import React, { createRef, useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import TextFieldDefault, { SECRET_REVEAL_MS, TextField } from './TextField';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('TextField — exports & defaults', () => {
  it('exposes the same component as the default and named export', () => {
    expect(TextFieldDefault).toBe(TextField);
  });

  it('renders a single-line <input> by default', () => {
    render(<TextField value="hi" onChange={jest.fn()} />);
    const field = screen.getByRole('textbox') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.value).toBe('hi');
  });

  it('renders a <textarea> when multiline is set', () => {
    render(<TextField multiline value="hi" onChange={jest.fn()} />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value).toBe('hi');
  });
});

describe('TextField — label association', () => {
  it('associates the label with the field via htmlFor/id, so it is queryable by accessible name', () => {
    render(<TextField label="Address" value="" onChange={jest.fn()} />);
    const field = screen.getByLabelText('Address');
    expect(field.tagName).toBe('INPUT');
  });

  it('associates the label on a multiline field the same way', () => {
    render(<TextField multiline label="Address" value="" onChange={jest.fn()} />);
    const field = screen.getByLabelText('Address');
    expect(field.tagName).toBe('TEXTAREA');
  });

  it('honours a caller-supplied id instead of the generated one', () => {
    render(<TextField label="Name" id="contact-name" value="" onChange={jest.fn()} />);
    const field = screen.getByLabelText('Name');
    expect(field.id).toBe('contact-name');
  });

  it('renders no label element when label is omitted', () => {
    const { container } = render(<TextField value="" onChange={jest.fn()} />);
    expect(container.querySelector('label')).toBeNull();
  });
});

describe('TextField — sizes and anatomy', () => {
  it('draws a 52px pill for a single-line field', () => {
    render(<TextField value="" onChange={jest.fn()} />);
    const box = screen.getByRole('textbox').parentElement as HTMLElement;
    expect(box.className).toContain('h-[52px]');
    expect(box.className).toContain('rounded-full');
    expect(box.className).toContain('bg-fill');
  });

  it('draws a 16px-radius auto-height box for a multiline field', () => {
    render(<TextField multiline value="" onChange={jest.fn()} />);
    const box = screen.getByRole('textbox').parentElement as HTMLElement;
    expect(box.className).toContain('rounded-lg-token');
    expect(box.className).not.toContain('h-[52px]');
    expect(box.className).toContain('bg-fill');
  });

  it('keeps field text at 16px so iOS does not zoom on focus', () => {
    render(<TextField value="" onChange={jest.fn()} />);
    expect(screen.getByRole('textbox')).toHaveClass('text-body');
  });

  it('defaults a multiline field to 2 rows and honours a caller override', () => {
    const { rerender } = render(<TextField multiline value="" onChange={jest.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).rows).toBe(2);

    rerender(<TextField multiline rows={4} value="" onChange={jest.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).rows).toBe(4);
  });
});

describe('TextField — trailing slot', () => {
  it('renders trailing content inside the field', () => {
    render(<TextField value="" onChange={jest.fn()} trailing={<button data-testid="paste-pill">Paste</button>} />);
    const field = screen.getByRole('textbox');
    const pill = screen.getByTestId('paste-pill');
    // Same field box contains both the input and the trailing pill.
    expect(field.parentElement).toBe(pill.parentElement?.parentElement);
  });

  it('renders nothing extra when trailing is omitted', () => {
    render(<TextField value="" onChange={jest.fn()} />);
    const box = screen.getByRole('textbox').parentElement as HTMLElement;
    expect(box.children).toHaveLength(1);
  });
});

describe('TextField — hint and error', () => {
  it('shows the hint when there is no error', () => {
    render(<TextField value="" onChange={jest.fn()} hint="We never share this" />);
    expect(screen.getByText('We never share this')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error instead of the hint, as role="alert"', () => {
    render(<TextField value="" onChange={jest.fn()} hint="hint text" error="Invalid address" />);
    expect(screen.queryByText('hint text')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid address');
  });

  it('applies the negative-ink color and a stable testid to the error message', () => {
    render(<TextField value="" onChange={jest.fn()} error="Invalid address" errorTestId="my-error" />);
    const message = screen.getByTestId('my-error');
    expect(message).toHaveTextContent('Invalid address');
    expect(message.className).toContain('text-negative-ink');
    expect(message.getAttribute('role')).toBe('alert');
  });

  it('rings the field negative and sets aria-invalid while there is an error', () => {
    render(<TextField value="" onChange={jest.fn()} error="Invalid" />);
    const box = screen.getByRole('textbox').parentElement as HTMLElement;
    expect(box.className).toContain('ring-status-negative');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('leaves aria-invalid false and no negative ring when there is no error', () => {
    render(<TextField value="" onChange={jest.fn()} />);
    const box = screen.getByRole('textbox').parentElement as HTMLElement;
    expect(box.className).not.toContain('ring-status-negative');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
  });

  it('draws both rings inset so a scrolling or clipping parent cannot cut them off', () => {
    const { rerender } = render(<TextField value="" onChange={jest.fn()} />);
    expect(screen.getByRole('textbox').parentElement).toHaveClass('focus-within:ring-2', 'focus-within:ring-inset');

    rerender(<TextField value="" onChange={jest.fn()} error="Invalid" />);
    expect(screen.getByRole('textbox').parentElement).toHaveClass('ring-2', 'ring-inset', 'ring-status-negative');

    rerender(<TextField value="" onChange={jest.fn()} multiline />);
    expect(screen.getByRole('textbox').parentElement).toHaveClass('focus-within:ring-inset');
  });

  it('describes the field by the error message id when present', () => {
    render(<TextField value="" onChange={jest.fn()} error="Invalid" />);
    const field = screen.getByRole('textbox');
    const message = screen.getByRole('alert');
    expect(field.getAttribute('aria-describedby')).toBe(message.id);
  });

  it('describes the field by the hint id when there is no error', () => {
    render(<TextField value="" onChange={jest.fn()} hint="Helper text" />);
    const field = screen.getByRole('textbox');
    expect(field.getAttribute('aria-describedby')).toBe(`${field.id}-hint`);
  });
});

describe('TextField — forwards native props, a ref, and events', () => {
  it('forwards a ref to the underlying <input>', () => {
    const ref = createRef<HTMLInputElement | HTMLTextAreaElement>();
    render(<TextField ref={ref} value="" onChange={jest.fn()} />);
    expect(ref.current?.tagName).toBe('INPUT');
  });

  it('forwards a ref to the underlying <textarea> when multiline', () => {
    const ref = createRef<HTMLInputElement | HTMLTextAreaElement>();
    render(<TextField ref={ref} multiline value="" onChange={jest.fn()} />);
    expect(ref.current?.tagName).toBe('TEXTAREA');
  });

  it('forwards native attributes such as placeholder, maxLength and disabled', () => {
    render(<TextField value="" onChange={jest.fn()} placeholder="Enter address" maxLength={50} disabled />);
    const field = screen.getByRole('textbox') as HTMLInputElement;
    expect(field.placeholder).toBe('Enter address');
    expect(field.maxLength).toBe(50);
    expect(field.disabled).toBe(true);
  });

  it('calls onChange with the native change event on every change', () => {
    const onChange = jest.fn();
    // A controlled field that never accepts the new value would revert the DOM before this test
    // can read it back off the (live) event target, so drive it through a small stateful wrapper
    // instead — the same shape every real caller uses.
    const Wrapper = () => {
      const [value, setValue] = useState('');
      return (
        <TextField
          value={value}
          onChange={event => {
            onChange(event.target.value);
            setValue(event.target.value);
          }}
        />
      );
    };
    render(<Wrapper />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('abc');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('abc');
  });

  it('forwards data-testid to the field element', () => {
    render(<TextField value="" onChange={jest.fn()} data-testid="address-input" />);
    expect(screen.getByTestId('address-input')).toBe(screen.getByRole('textbox'));
  });

  // A vault secret must not reach the browser password manager. The wallet's password fields moved
  // onto this component without carrying `autoComplete` across, so they silently reverted to the
  // browser default; `FormField`, which this replaces, has defaulted it since it was written.
  describe('autoComplete', () => {
    it('suppresses the password manager on a password field', () => {
      render(<TextField type="password" value="" onChange={jest.fn()} data-testid="secret" />);

      // `off` is the one value browsers override on a password-type input, so it has to be
      // `new-password` here specifically.
      expect(screen.getByTestId('secret')).toHaveAttribute('autocomplete', 'new-password');
    });

    it('still suppresses it while the password is revealed', () => {
      // Callers toggle visibility by flipping `type` to 'text'. Plain `off` IS honoured there, so
      // the suppression survives the toggle rather than switching off with it.
      render(<TextField type="text" value="" onChange={jest.fn()} data-testid="secret" />);

      expect(screen.getByTestId('secret')).toHaveAttribute('autocomplete', 'off');
    });

    it('does not claim a non-secret field is a new password', () => {
      // The file-name field next to the export password is a bare TextField with no type, and a
      // blanket `new-password` default would have landed on it.
      render(<TextField value="" onChange={jest.fn()} data-testid="file-name" />);

      expect(screen.getByTestId('file-name')).toHaveAttribute('autocomplete', 'off');
    });

    it('lets a caller that wants autofill override it', () => {
      render(<TextField autoComplete="username" value="" onChange={jest.fn()} data-testid="who" />);

      expect(screen.getByTestId('who')).toHaveAttribute('autocomplete', 'username');
    });
  });
});

describe('TextField — leading prefix', () => {
  it('draws a muted, decorative prefix before a single-line input', () => {
    render(<TextField id="word-1" leading="1." value="" onChange={() => undefined} />);
    const prefix = screen.getByText('1.');
    expect(prefix).toHaveAttribute('aria-hidden', 'true');
    expect(prefix).toHaveClass('text-muted');
    expect(prefix.nextElementSibling).toBe(document.getElementById('word-1'));
  });

  it('ignores the prefix on a multi-line field', () => {
    render(<TextField multiline leading="1." value="" onChange={() => undefined} />);
    expect(screen.queryByText('1.')).not.toBeInTheDocument();
  });
});

describe('TextField — secret', () => {
  const cover = () => document.querySelector('[data-slot="secret-cover"]');

  it('covers a filled secret until it is focused, and again when focus leaves', () => {
    render(<TextField secret multiline value="my private key" onChange={jest.fn()} />);
    const field = screen.getByRole('textbox');

    expect(cover()).toBeInTheDocument();
    fireEvent.focus(field);
    expect(cover()).toBeNull();
    fireEvent.blur(field);
    expect(cover()).toBeInTheDocument();
  });

  it('covers nothing while the field is empty, and covers what was typed into an uncontrolled one', () => {
    render(<TextField secret data-testid="key" />);
    const field = screen.getByTestId('key');

    expect(cover()).toBeNull();
    fireEvent.change(field, { target: { value: 'aabb' } });
    fireEvent.blur(field);
    expect(cover()).toBeInTheDocument();

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(cover()).toBeNull();
  });

  it('covers a secret seeded from defaultValue, and uncovers once it is cleared', () => {
    render(<TextField secret defaultValue="my private key" data-testid="key" />);
    const field = screen.getByTestId('key');

    expect(cover()).toBeInTheDocument();

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(cover()).toBeNull();
  });

  describe('once revealed', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const revealed = () => {
      render(<TextField secret value="my private key" onChange={jest.fn()} />);
      const field = screen.getByRole('textbox');
      act(() => field.focus());
      expect(field).toHaveFocus();
      expect(cover()).toBeNull();
      return field;
    };

    it('covers the secret again after the reveal window, not a millisecond before', () => {
      const field = revealed();
      act(() => {
        jest.advanceTimersByTime(SECRET_REVEAL_MS - 1);
      });
      expect(field).toHaveFocus();
      expect(cover()).toBeNull();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(field).not.toHaveFocus();
      expect(cover()).toBeInTheDocument();
    });

    it('covers the secret again when the window goes away', () => {
      const field = revealed();
      act(() => {
        jest.advanceTimersByTime(SECRET_REVEAL_MS - 1);
      });
      expect(cover()).toBeNull();

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(field).not.toHaveFocus();
      expect(cover()).toBeInTheDocument();
    });
  });

  it('keeps autofill off a secret input and textarea, whatever the caller asks for', () => {
    const { unmount } = render(<TextField secret autoComplete="on" value="k" onChange={jest.fn()} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('autocomplete', 'off');
    unmount();
    render(<TextField secret multiline autoComplete="on" value="k" onChange={jest.fn()} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('autocomplete', 'off');
  });

  it('keeps spellcheck, autocorrect and autocapitalize off a secret input and textarea, whatever the caller asks for', () => {
    const asked = { spellCheck: true, autoCorrect: 'on', autoCapitalize: 'sentences' } as const;
    render(
      <>
        <TextField secret {...asked} value="k" onChange={jest.fn()} />
        <TextField secret multiline {...asked} value="k" onChange={jest.fn()} />
      </>
    );
    const fields = screen.getAllByRole('textbox');
    expect(fields.map(field => field.tagName)).toEqual(['INPUT', 'TEXTAREA']);
    for (const field of fields) {
      expect(field).toHaveAttribute('spellcheck', 'false');
      expect(field).toHaveAttribute('autocorrect', 'off');
      expect(field).toHaveAttribute('autocapitalize', 'none');
    }
  });

  it("leaves an ordinary field's spellcheck, autocorrect and autocapitalize to the caller", () => {
    render(<TextField spellCheck autoCorrect="on" autoCapitalize="sentences" value="k" onChange={jest.fn()} />);
    const field = screen.getByRole('textbox');
    expect(field).toHaveAttribute('spellcheck', 'true');
    expect(field).toHaveAttribute('autocorrect', 'on');
    expect(field).toHaveAttribute('autocapitalize', 'sentences');
  });

  describe('when the document is hidden', () => {
    const setVisibility = (state: DocumentVisibilityState) =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

    afterEach(() => {
      setVisibility('visible');
      jest.restoreAllMocks();
    });

    const revealed = () => {
      const view = render(<TextField secret value="my private key" onChange={jest.fn()} />);
      const field = screen.getByRole('textbox');
      act(() => field.focus());
      expect(field).toHaveFocus();
      expect(cover()).toBeNull();
      return { ...view, field };
    };

    it('covers a revealed secret again when the document becomes hidden', () => {
      const { field } = revealed();
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(field).toHaveFocus();

      setVisibility('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(field).not.toHaveFocus();
      expect(cover()).toBeInTheDocument();
    });

    it('covers a revealed secret again on pagehide', () => {
      const { field } = revealed();
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(field).not.toHaveFocus();
      expect(cover()).toBeInTheDocument();
    });

    // Chromium fires the field's focusout before the window blur on a window switch, and the
    // browser hands focus back to the same element on return, uncovering it without a tap.
    describe('when focus leaves before the window event', () => {
      it.each([
        ['on the window blur', () => window.dispatchEvent(new Event('blur'))],
        ['on pagehide', () => window.dispatchEvent(new Event('pagehide'))],
        [
          'when the document becomes hidden',
          () => {
            setVisibility('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
          }
        ]
      ])('gives focus back %s', (_, windowEvent) => {
        const { field } = revealed();
        act(() => {
          fireEvent.focusOut(field);
        });
        expect(field).toHaveFocus();
        act(() => {
          windowEvent();
        });
        expect(field).not.toHaveFocus();
        expect(cover()).toBeInTheDocument();
      });
    });

    it('removes every listener, and the timer, once the field leaves secret mode or unmounts', () => {
      jest.useFakeTimers();
      try {
        const windowAdd = jest.spyOn(window, 'addEventListener');
        const windowRemove = jest.spyOn(window, 'removeEventListener');
        const documentAdd = jest.spyOn(document, 'addEventListener');
        const documentRemove = jest.spyOn(document, 'removeEventListener');
        const { field, rerender, unmount } = revealed();
        const added = (spy: jest.SpyInstance, type: string) =>
          spy.mock.calls.filter(([name]) => name === type).at(-1)?.[1];
        const blur = added(windowAdd, 'blur');
        const pagehide = added(windowAdd, 'pagehide');
        const visibility = added(documentAdd, 'visibilitychange');
        expect([blur, pagehide, visibility]).toEqual([
          expect.any(Function),
          expect.any(Function),
          expect.any(Function)
        ]);

        rerender(<TextField value="my private key" onChange={jest.fn()} />);
        expect(windowRemove).toHaveBeenCalledWith('blur', blur);
        expect(windowRemove).toHaveBeenCalledWith('pagehide', pagehide);
        expect(documentRemove).toHaveBeenCalledWith('visibilitychange', visibility);

        setVisibility('hidden');
        act(() => {
          window.dispatchEvent(new Event('blur'));
          window.dispatchEvent(new Event('pagehide'));
          document.dispatchEvent(new Event('visibilitychange'));
          jest.advanceTimersByTime(SECRET_REVEAL_MS);
        });
        expect(field).toHaveFocus();

        setVisibility('visible');
        rerender(<TextField secret value="my private key" onChange={jest.fn()} />);
        act(() => field.focus());
        const blurAgain = added(windowAdd, 'blur');
        const pagehideAgain = added(windowAdd, 'pagehide');
        const visibilityAgain = added(documentAdd, 'visibilitychange');
        unmount();
        expect(windowRemove).toHaveBeenCalledWith('blur', blurAgain);
        expect(windowRemove).toHaveBeenCalledWith('pagehide', pagehideAgain);
        expect(documentRemove).toHaveBeenCalledWith('visibilitychange', visibilityAgain);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('still reports focus and blur to the caller', () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    render(<TextField secret value="x" onChange={jest.fn()} onFocus={onFocus} onBlur={onBlur} />);

    fireEvent.focus(screen.getByRole('textbox'));
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary field uncovered', () => {
    render(<TextField value="not a secret" onChange={jest.fn()} />);
    expect(cover()).toBeNull();
  });
});
