import * as propsWithChildrenModule from './props-with-children';
import type { PropsWithChildren } from './props-with-children';

// `props-with-children.ts` is a type-only module: a single exported interface
// plus a type-only `react` import, both of which are erased at compile time. It
// has no runtime members, so the meaningful assertions are (1) that importing
// it is side-effect-free and produces no runtime exports, and (2) that values
// satisfying the `PropsWithChildren` contract behave as expected at runtime.
describe('props-with-children module', () => {
  it('imports without side effects and exposes no runtime members', () => {
    expect(propsWithChildrenModule).toBeDefined();
    expect(Object.keys(propsWithChildrenModule)).toHaveLength(0);
  });
});

describe('PropsWithChildren contract', () => {
  it('accepts a plain string child', () => {
    const props: PropsWithChildren = { children: 'hello' };
    expect(props.children).toBe('hello');
  });

  it('accepts a numeric child', () => {
    const props: PropsWithChildren = { children: 42 };
    expect(props.children).toBe(42);
  });

  it('accepts nullish and boolean ReactNode children', () => {
    const nullChild: PropsWithChildren = { children: null };
    const undefinedChild: PropsWithChildren = { children: undefined };
    const booleanChild: PropsWithChildren = { children: false };

    expect(nullChild.children).toBeNull();
    expect(undefinedChild.children).toBeUndefined();
    expect(booleanChild.children).toBe(false);
  });

  it('accepts an array of children', () => {
    const props: PropsWithChildren = { children: ['a', 'b', 'c'] };
    expect(props.children).toEqual(['a', 'b', 'c']);
  });

  it('is structurally satisfied by objects carrying extra fields', () => {
    const extended: PropsWithChildren & { label: string } = {
      children: 'body',
      label: 'extra'
    };
    // Widening to the base interface keeps the `children` field intact.
    const base: PropsWithChildren = extended;
    expect(base.children).toBe('body');
    expect(extended.label).toBe('extra');
  });
});
