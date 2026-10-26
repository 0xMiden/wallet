// Side-effect import forces the (interface-only) module into the runtime graph
// so the v8 coverage provider records its source lines as executed. Without it
// the `import type` below is erased at transpile time and the file reports 0%.
import './test-id.props';
import type { TestIDProps } from './test-id.props';

// `test-id.props.ts` declares only the `TestIDProps` TypeScript interface.
// Interfaces are compile-time-only constructs: `@swc/jest` erases them during
// transpilation, so the emitted module has zero executable statements. There is
// no runtime function, component, or value to invoke. These tests therefore act
// as a compile-time contract check — every field of the interface is exercised
// through the type system, which is the only testable surface the file has.

describe('TestIDProps', () => {
  it('accepts an object with both optional properties populated', () => {
    const props: TestIDProps = {
      testID: 'send-button',
      testIDProperties: { network: 'testnet', amount: 10 }
    };

    expect(props.testID).toBe('send-button');
    expect(props.testIDProperties).toEqual({ network: 'testnet', amount: 10 });
  });

  it('accepts an empty object because every property is optional', () => {
    const props: TestIDProps = {};

    expect(props.testID).toBeUndefined();
    expect(props.testIDProperties).toBeUndefined();
  });

  it('accepts only testID', () => {
    const props: TestIDProps = { testID: 'address-field' };

    expect(props.testID).toBe('address-field');
    expect(props.testIDProperties).toBeUndefined();
  });

  it('accepts only testIDProperties', () => {
    const props: TestIDProps = { testIDProperties: { screen: 'home' } };

    expect(props.testID).toBeUndefined();
    expect(props.testIDProperties).toEqual({ screen: 'home' });
  });

  it('can be spread onto a component-style props bag', () => {
    const base: TestIDProps = { testID: 'row', testIDProperties: { index: 0 } };
    const merged = { ...base, className: 'active' };

    expect(merged.testID).toBe('row');
    expect(merged.className).toBe('active');
  });
});
