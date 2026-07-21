import React, { useRef } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import AssetField from './AssetField';

// react-i18next isn't globally mocked; sibling tests stub it so `t` echoes the key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// FormField is a heavy sibling atom (pulls in CopyButton/useTippy/analytics/icons).
// AssetField only relies on it to (a) render an <input> wired to
// onChange/onFocus/onBlur, (b) forward its ref, (c) render `extraInner`, and
// (d) spread the remaining props onto the field. A lightweight forwardRef stub
// reproduces exactly that contract and isolates AssetField's own logic.
jest.mock('app/atoms/FormField', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ReactLib.forwardRef((props: any, ref: any) => {
      const {
        value,
        onChange,
        onFocus,
        onBlur,
        extraInner,
        type,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        useDefaultInnerWrapper,
        ...rest
      } = props;
      return ReactLib.createElement(
        'div',
        null,
        ReactLib.createElement('input', {
          ref,
          type,
          value,
          onChange,
          onFocus,
          onBlur,
          'data-testid': 'asset-input',
          ...rest
        }),
        extraInner
      );
    })
  };
});

const getInput = () => screen.getByTestId('asset-input') as HTMLInputElement;

describe('AssetField', () => {
  describe('value / valueStr memo + sync effect', () => {
    it('renders empty when value is undefined', () => {
      render(<AssetField />);
      expect(getInput().value).toBe('');
    });

    it('formats a numeric value via BigNumber.toFixed', () => {
      render(<AssetField value={1000} />);
      expect(getInput().value).toBe('1000');
    });

    it('formats a string value via BigNumber.toFixed', () => {
      render(<AssetField value="123.45" />);
      expect(getInput().value).toBe('123.45');
    });

    it('syncs local value from prop while not focused', () => {
      const { rerender } = render(<AssetField value={1} />);
      expect(getInput().value).toBe('1');

      rerender(<AssetField value={5} />);
      expect(getInput().value).toBe('5');
    });

    it('does NOT sync from prop while focused', () => {
      const { rerender } = render(<AssetField value={1} />);
      const input = getInput();
      fireEvent.focus(input);

      rerender(<AssetField value={9} />);
      // focused => effect skips setLocalValue, input keeps prior value
      expect(getInput().value).toBe('1');
    });
  });

  describe('handleChange', () => {
    it('accepts a plain valid number and reports the fixed value', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '5' } });

      expect(onChange).toHaveBeenLastCalledWith('5');
      expect(getInput().value).toBe('5');
    });

    it('normalises commas to dots and strips spaces', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '1 2,5' } });

      // '1 2,5' -> '12.5'
      expect(onChange).toHaveBeenLastCalledWith('12.5');
      expect(getInput().value).toBe('12.5');
    });

    it('truncates decimals beyond assetDecimals', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} assetDecimals={6} />);

      fireEvent.change(getInput(), { target: { value: '1.1234567' } });

      expect(onChange).toHaveBeenLastCalledWith('1.123456');
      expect(getInput().value).toBe('1.123456');
    });

    it('honours a custom assetDecimals when truncating', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} assetDecimals={2} />);

      fireEvent.change(getInput(), { target: { value: '3.14159' } });

      expect(onChange).toHaveBeenLastCalledWith('3.14');
      expect(getInput().value).toBe('3.14');
    });

    it('rewrites a lone dot to "0." locally while reporting "0"', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '.' } });

      expect(onChange).toHaveBeenLastCalledWith('0');
      expect(getInput().value).toBe('0.');
    });

    it('reports undefined when cleared to empty string', () => {
      const onChange = jest.fn();
      render(<AssetField value={5} onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '' } });

      expect(onChange).toHaveBeenLastCalledWith(undefined);
      expect(getInput().value).toBe('');
    });

    it('rejects non-numeric input (NaN) without calling onChange', () => {
      const onChange = jest.fn();
      render(<AssetField value={2} onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: 'abc' } });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('rejects values above max', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} max={10} />);

      fireEvent.change(getInput(), { target: { value: '20' } });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('rejects values below min', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} min={5} />);

      fireEvent.change(getInput(), { target: { value: '3' } });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not throw when onChange is omitted', () => {
      render(<AssetField />);

      expect(() => fireEvent.change(getInput(), { target: { value: '7' } })).not.toThrow();
      expect(getInput().value).toBe('7');
    });
  });

  describe('setMax', () => {
    it('renders the max button by default and sets the fixed max value', () => {
      const onChange = jest.fn();
      render(<AssetField onChange={onChange} max={10} assetDecimals={6} assetSymbol="ETH" />);

      const maxBtn = screen.getByRole('button', { name: 'max' });
      fireEvent.click(maxBtn);

      expect(onChange).toHaveBeenCalledWith('10.000000');
      expect(getInput().value).toBe('10.000000');
    });

    it('does not throw when max clicked without onChange', () => {
      render(<AssetField max={4} />);

      const maxBtn = screen.getByRole('button', { name: 'max' });
      expect(() => fireEvent.click(maxBtn)).not.toThrow();
      expect(getInput().value).toBe('4.000000');
    });

    it('hides the max button when showMax is false', () => {
      render(<AssetField showMax={false} assetSymbol="BTC" />);

      expect(screen.queryByRole('button', { name: 'max' })).not.toBeInTheDocument();
      expect(screen.getByText('BTC')).toBeInTheDocument();
    });
  });

  describe('handleFocus / handleBlur', () => {
    it('handles focus and blur without external handlers', () => {
      render(<AssetField value={1} />);
      const input = getInput();

      expect(() => {
        fireEvent.focus(input);
        fireEvent.blur(input);
      }).not.toThrow();
    });

    it('invokes onFocus / onBlur when not default-prevented', () => {
      const onFocus = jest.fn();
      const onBlur = jest.fn();
      render(<AssetField onFocus={onFocus} onBlur={onBlur} />);
      const input = getInput();

      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('returns early when onFocus / onBlur call preventDefault', () => {
      const onFocus = jest.fn((e: React.FocusEvent) => e.preventDefault());
      const onBlur = jest.fn((e: React.FocusEvent) => e.preventDefault());
      render(<AssetField onFocus={onFocus} onBlur={onBlur} />);
      const input = getInput();

      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('keeps focused-state edits after blur re-enables prop sync', () => {
      const { rerender } = render(<AssetField value={1} />);
      const input = getInput();

      fireEvent.focus(input);
      rerender(<AssetField value={2} />);
      expect(getInput().value).toBe('1'); // still focused -> no sync

      fireEvent.blur(input);
      rerender(<AssetField value={3} />);
      expect(getInput().value).toBe('3'); // unfocused -> sync resumes
    });
  });

  describe('ref forwarding & pass-through props', () => {
    it('forwards the ref to the underlying input', () => {
      const Wrapper = () => {
        const ref = useRef<HTMLInputElement>(null);
        return (
          <>
            <AssetField ref={ref} />
            <button onClick={() => ref.current?.setAttribute('data-ref-ok', 'yes')}>touch</button>
          </>
        );
      };
      render(<Wrapper />);

      fireEvent.click(screen.getByRole('button', { name: 'touch' }));
      expect(getInput().getAttribute('data-ref-ok')).toBe('yes');
    });

    it('spreads remaining props onto FormField', () => {
      render(<AssetField placeholder="0.00" assetSymbol="MIDEN" />);

      expect(getInput()).toHaveAttribute('placeholder', '0.00');
      expect(screen.getByText('MIDEN')).toBeInTheDocument();
    });
  });
});
