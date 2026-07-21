import React, { useRef } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import NoSpaceField from './NoSpaceField';

// FormField is a heavy sibling atom (pulls in CopyButton / useTippy / analytics /
// icons). NoSpaceField only relies on it to (a) render a field wired to
// `value` + `onChange`, (b) forward its ref, and (c) spread the remaining props
// onto the field. A lightweight forwardRef stub reproduces exactly that contract
// and isolates NoSpaceField's own whitespace-stripping logic.
jest.mock('app/atoms/FormField', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ReactLib.forwardRef((props: any, ref: any) => {
      const { value, onChange, ...rest } = props;
      return ReactLib.createElement('input', {
        ref,
        value,
        onChange,
        'data-testid': 'nospace-input',
        ...rest
      });
    })
  };
});

const getInput = () => screen.getByTestId('nospace-input') as HTMLInputElement;

describe('NoSpaceField', () => {
  describe('value pass-through', () => {
    it('renders empty when value is undefined', () => {
      render(<NoSpaceField onChange={() => undefined} />);
      expect(getInput().value).toBe('');
    });

    it('forwards the controlled value straight through to FormField', () => {
      render(<NoSpaceField value="abc123" onChange={() => undefined} />);
      expect(getInput().value).toBe('abc123');
    });
  });

  describe('handleChange -> format', () => {
    it('strips a single interior space and reports the stripped value', () => {
      const onChange = jest.fn();
      render(<NoSpaceField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: 'ab cd' } });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith('abcd');
    });

    it('strips every kind of whitespace (spaces, tabs, newlines, CR)', () => {
      const onChange = jest.fn();
      render(<NoSpaceField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: ' a\tb\nc\r d ' } });

      expect(onChange).toHaveBeenLastCalledWith('abcd');
    });

    it('leaves a value with no whitespace unchanged', () => {
      const onChange = jest.fn();
      render(<NoSpaceField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: 'nospacehere' } });

      expect(onChange).toHaveBeenLastCalledWith('nospacehere');
    });

    it('collapses an all-whitespace value to an empty string', () => {
      const onChange = jest.fn();
      render(<NoSpaceField onChange={onChange} />);

      fireEvent.change(getInput(), { target: { value: '   \t\n  ' } });

      expect(onChange).toHaveBeenLastCalledWith('');
    });

    it('does NOT throw and skips reporting when onChange is omitted (falsy branch)', () => {
      render(<NoSpaceField />);

      expect(() => fireEvent.change(getInput(), { target: { value: 'a b c' } })).not.toThrow();
    });
  });

  describe('ref forwarding & pass-through props', () => {
    it('forwards the ref down to the underlying field element', () => {
      const Wrapper = () => {
        const ref = useRef<HTMLTextAreaElement>(null);
        return (
          <>
            <NoSpaceField ref={ref} onChange={() => undefined} />
            <button onClick={() => ref.current?.setAttribute('data-ref-ok', 'yes')}>touch</button>
          </>
        );
      };
      render(<Wrapper />);

      fireEvent.click(screen.getByRole('button', { name: 'touch' }));
      expect(getInput().getAttribute('data-ref-ok')).toBe('yes');
    });

    it('spreads remaining props onto FormField', () => {
      render(<NoSpaceField placeholder="paste seed" name="seedField" onChange={() => undefined} />);

      const input = getInput();
      expect(input).toHaveAttribute('placeholder', 'paste seed');
      expect(input).toHaveAttribute('name', 'seedField');
    });
  });
});
