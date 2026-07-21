import { blurHandler, checkedHandler, focusHandler } from './inputHandlers';

describe('inputHandlers', () => {
  describe('focusHandler', () => {
    it('invokes onFocus and sets focus true when not prevented', () => {
      const evt = { defaultPrevented: false };
      const onFocus = jest.fn();
      const setFocus = jest.fn();

      focusHandler(evt, onFocus as any, setFocus);

      expect(onFocus).toHaveBeenCalledWith(evt);
      expect(setFocus).toHaveBeenCalledWith(true);
    });

    it('returns early without setting focus when the event is defaultPrevented', () => {
      const evt = { defaultPrevented: true };
      const onFocus = jest.fn();
      const setFocus = jest.fn();

      focusHandler(evt, onFocus as any, setFocus);

      expect(onFocus).toHaveBeenCalledWith(evt);
      expect(setFocus).not.toHaveBeenCalled();
    });

    it('sets focus true when no onFocus handler is provided', () => {
      const evt = { defaultPrevented: false };
      const setFocus = jest.fn();

      focusHandler(evt, undefined as any, setFocus);

      expect(setFocus).toHaveBeenCalledWith(true);
    });
  });

  describe('checkedHandler', () => {
    it('invokes onChange and sets the checked value when not prevented', () => {
      const evt = { defaultPrevented: false, target: { checked: true } };
      const onChange = jest.fn();
      const setValue = jest.fn();

      checkedHandler(evt, onChange as any, setValue);

      expect(onChange).toHaveBeenCalledWith(evt);
      expect(setValue).toHaveBeenCalledWith(true);
    });

    it('returns early without setting the value when the event is defaultPrevented', () => {
      const evt = { defaultPrevented: true, target: { checked: true } };
      const onChange = jest.fn();
      const setValue = jest.fn();

      checkedHandler(evt, onChange as any, setValue);

      expect(onChange).toHaveBeenCalledWith(evt);
      expect(setValue).not.toHaveBeenCalled();
    });

    it('sets the checked value when no onChange handler is provided', () => {
      const evt = { defaultPrevented: false, target: { checked: false } };
      const setValue = jest.fn();

      checkedHandler(evt, undefined as any, setValue);

      expect(setValue).toHaveBeenCalledWith(false);
    });
  });

  describe('blurHandler', () => {
    it('invokes onBlur and sets focus false when not prevented', () => {
      const evt = { defaultPrevented: false };
      const onBlur = jest.fn();
      const setFocus = jest.fn();

      blurHandler(evt, onBlur as any, setFocus);

      expect(onBlur).toHaveBeenCalledWith(evt);
      expect(setFocus).toHaveBeenCalledWith(false);
    });

    it('returns early without setting focus when the event is defaultPrevented', () => {
      const evt = { defaultPrevented: true };
      const onBlur = jest.fn();
      const setFocus = jest.fn();

      blurHandler(evt, onBlur as any, setFocus);

      expect(onBlur).toHaveBeenCalledWith(evt);
      expect(setFocus).not.toHaveBeenCalled();
    });

    it('sets focus false when no onBlur handler is provided', () => {
      const evt = { defaultPrevented: false };
      const setFocus = jest.fn();

      blurHandler(evt, undefined as any, setFocus);

      expect(setFocus).toHaveBeenCalledWith(false);
    });
  });
});
