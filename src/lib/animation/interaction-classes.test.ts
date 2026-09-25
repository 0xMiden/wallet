import { colorTransitionClass } from './interaction-classes';

it('is the shared hover/press color-transition utility, not a literal duration a component redeclares', () => {
  expect(colorTransitionClass).toBe('transition-colors duration-150 ease-hover');
});
