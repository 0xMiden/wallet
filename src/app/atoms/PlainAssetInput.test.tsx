import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import PlainAssetInput from './PlainAssetInput';

// PlainAssetInput renders a bare controlled <input type="text">. It has no
// i18n / store / native dependencies, so it can be exercised directly with no
// mocks — every branch lives in its own change/focus/blur handlers.
const getInput = () => screen.getByRole('textbox') as HTMLInputElement;

describe('PlainAssetInput', () => {
  describe('valueStr memo + prop-sync effect', () => {
    it('renders empty when value is undefined', () => {
      render(<PlainAssetInput />);
      expect(getInput().value).toBe('');
    });

    it('formats a numeric value via BigNumber.toFixed', () => {
      render(<PlainAssetInput value={1000} />);
      expect(getInput().value).toBe('1000');
    });

    it('formats a string value via BigNumber.toFixed', () => {
      render(<PlainAssetInput value="123.45" />);
      expect(getInput().value).toBe('123.45');
    });

    it('syncs local value from the prop while not focused', () => {
      const { rerender } = render(<PlainAssetInput value={1} />);
      expect(getInput().value).toBe('1');

      rerender(<PlainAssetInput value={5} />);
      expect(getInput().value).toBe('5');
    });

    it('does NOT sync from the prop while focused', () => {
      const { rerender } = render(<PlainAssetInput value={1} />);
      const input = getInput();
      fireEvent.focus(input);

      rerender(<PlainAssetInput value={9} />);
      // focused => effect skips setLocalValue, input keeps the prior value
      expect(getInput().value).toBe('1');
    });
  });

  describe('handleChange', () => {
    it('accepts a plain valid number and reports the fixed value', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '5' } });

      expect(onChange).toHaveBeenLastCalledWith('5');
      expect(getInput().value).toBe('5');
    });

    it('normalises commas to dots and strips spaces', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '1 2,5' } });

      // '1 2,5' -> '12.5'
      expect(onChange).toHaveBeenLastCalledWith('12.5');
      expect(getInput().value).toBe('12.5');
    });

    it('truncates decimals beyond the default assetDecimals (6)', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '1.1234567' } });

      expect(onChange).toHaveBeenLastCalledWith('1.123456');
      expect(getInput().value).toBe('1.123456');
    });

    it('honours a custom assetDecimals when truncating', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} assetDecimals={2} />);

      fireEvent.change(getInput(), { target: { value: '3.14159' } });

      expect(onChange).toHaveBeenLastCalledWith('3.14');
      expect(getInput().value).toBe('3.14');
    });

    it('does NOT truncate when decimals are within the limit', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} assetDecimals={6} />);

      fireEvent.change(getInput(), { target: { value: '1.5' } });

      expect(onChange).toHaveBeenLastCalledWith('1.5');
      expect(getInput().value).toBe('1.5');
    });

    it('reports undefined when cleared to an empty string', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput value={5} onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '' } });

      expect(onChange).toHaveBeenLastCalledWith(undefined);
      expect(getInput().value).toBe('');
    });

    it('reports undefined when the input reduces to empty after stripping spaces', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput value={5} onChange={onChange} />);

      // '   ' -> '' after the space strip, BigNumber('' || 0) === 0 (accepted),
      // but val === '' so undefined is reported.
      fireEvent.change(getInput(), { target: { value: '   ' } });

      expect(onChange).toHaveBeenLastCalledWith(undefined);
      expect(getInput().value).toBe('');
    });

    it('rejects non-numeric input (NaN) without calling onChange and keeps the value', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput value={2} onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: 'abc' } });

      expect(onChange).not.toHaveBeenCalled();
      expect(getInput().value).toBe('2');
    });

    it('rejects a lone dot (BigNumber NaN)', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput value={2} onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '.' } });

      expect(onChange).not.toHaveBeenCalled();
      expect(getInput().value).toBe('2');
    });

    it('rejects values above max', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} max={10} />);

      fireEvent.change(getInput(), { target: { value: '20' } });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('rejects values below min', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} min={5} />);

      fireEvent.change(getInput(), { target: { value: '3' } });

      expect(onChange).not.toHaveBeenCalled();
    });

    it('accepts a value equal to min (default 0)', () => {
      const onChange = jest.fn();
      render(<PlainAssetInput onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '0' } });

      expect(onChange).toHaveBeenLastCalledWith('0');
      expect(getInput().value).toBe('0');
    });

    it('does not throw and still updates locally when onChange is omitted', () => {
      render(<PlainAssetInput />);

      expect(() => fireEvent.change(getInput(), { target: { value: '7' } })).not.toThrow();
      expect(getInput().value).toBe('7');
    });

    it('updates locally to empty without onChange (empty branch, no handler)', () => {
      render(<PlainAssetInput value={4} />);

      expect(() => fireEvent.change(getInput(), { target: { value: '' } })).not.toThrow();
      expect(getInput().value).toBe('');
    });
  });

  describe('handleFocus / handleBlur', () => {
    it('handles focus and blur without external handlers', () => {
      render(<PlainAssetInput value={1} />);
      const input = getInput();

      expect(() => {
        fireEvent.focus(input);
        fireEvent.blur(input);
      }).not.toThrow();
    });

    it('invokes onFocus / onBlur when not default-prevented', () => {
      const onFocus = jest.fn();
      const onBlur = jest.fn();
      render(<PlainAssetInput onFocus={onFocus} onBlur={onBlur} />);
      const input = getInput();

      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('returns early when onFocus / onBlur call preventDefault', () => {
      const onFocus = jest.fn((e: React.FocusEvent) => e.preventDefault());
      const onBlur = jest.fn((e: React.FocusEvent) => e.preventDefault());
      render(<PlainAssetInput onFocus={onFocus} onBlur={onBlur} />);
      const input = getInput();

      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(onFocus).toHaveBeenCalledTimes(1);
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('keeps focused-state edits after blur re-enables prop sync', () => {
      const { rerender } = render(<PlainAssetInput value={1} />);
      const input = getInput();

      fireEvent.focus(input);
      rerender(<PlainAssetInput value={2} />);
      expect(getInput().value).toBe('1'); // still focused -> no sync

      fireEvent.blur(input);
      rerender(<PlainAssetInput value={3} />);
      expect(getInput().value).toBe('3'); // unfocused -> sync resumes
    });
  });

  describe('pass-through props', () => {
    it('spreads the remaining props onto the underlying input', () => {
      render(<PlainAssetInput placeholder="0.00" className="my-input" data-testid="plain" name="amount" disabled />);
      const input = getInput();

      expect(input).toHaveAttribute('placeholder', '0.00');
      expect(input).toHaveClass('my-input');
      expect(input).toHaveAttribute('data-testid', 'plain');
      expect(input).toHaveAttribute('name', 'amount');
      expect(input).toBeDisabled();
      expect(input).toHaveAttribute('type', 'text');
    });
  });
});
