/**
 * Stepper — a presentational atom that renders a horizontal list of labelled
 * steps. Each step shows a circle (active / passed / upcoming) and, for passed
 * steps, an "ok" checkmark svg; a connector line is drawn between every pair of
 * adjacent steps (i.e. for all but the last step) and turns "active" once the
 * step it starts from has been passed.
 *
 * The component imports a `.module.css` file, which jest cannot transform
 * (there is no css transform/mapper in jest.config.ts — importing it raw throws
 * `SyntaxError: Unexpected token '.'`). We mock the css module so the source's
 * `styles['...']` lookups resolve to stable, assertable class strings. The
 * `ok.svg` import resolves to the global svg mock (`ReactComponent === 'svg'`),
 * so the checkmark renders as a plain <svg> element.
 */
import React from 'react';

import { render } from '@testing-library/react';

// Mock the co-located CSS module: each key maps to its own name so we can assert
// on the resulting class strings, and jest never evaluates the raw CSS as JS.
jest.mock('./Stepper.module.css', () => ({
  __esModule: true,
  default: {
    stepperWrapper: 'stepperWrapper',
    stepWrapper: 'stepWrapper',
    circle: 'circle',
    'circle-active': 'circle-active',
    'circle-passed': 'circle-passed',
    line: 'line',
    'line-active': 'line-active'
  }
}));

import Stepper from './Stepper';

const getWrapper = (container: HTMLElement) => container.firstChild as HTMLElement;
const getStepBlocks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.stepBlock')) as HTMLElement[];
const getCircle = (block: HTMLElement) => block.querySelector('.circle') as HTMLElement;
const getLine = (block: HTMLElement) => block.querySelector('.line') as HTMLElement | null;
const getCheck = (block: HTMLElement) => block.querySelector('svg') as SVGElement | null;

describe('Stepper', () => {
  it('renders the wrapper with the base class and forwards the style prop', () => {
    const style: React.CSSProperties = { color: 'red', marginTop: '8px' };
    const { container } = render(<Stepper style={style} steps={['One', 'Two']} currentStep={0} />);

    const wrapper = getWrapper(container);
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('stepperWrapper');
    // Assert against the inline style object (not getComputedStyle) so the
    // check is robust to jsdom's partial computed-style support.
    expect(wrapper.style.color).toBe('red');
    expect(wrapper.style.marginTop).toBe('8px');
  });

  it('renders one stepBlock per step, each with its label text', () => {
    const steps = ['Alpha', 'Beta', 'Gamma'];
    const { container } = render(<Stepper style={{}} steps={steps} currentStep={0} />);

    const blocks = getStepBlocks(container);
    expect(blocks).toHaveLength(steps.length);
    blocks.forEach((block, i) => {
      expect(block.querySelector('p')).toHaveTextContent(steps[i]);
      // Every step always has a circle.
      expect(getCircle(block)).toBeInTheDocument();
    });
  });

  it('marks the current step as active (no passed styling, no checkmark)', () => {
    // currentStep === index → circle-active branch true; currentStep > index
    // false → no circle-passed class and no ok-icon svg.
    const { container } = render(<Stepper style={{}} steps={['A', 'B', 'C']} currentStep={0} />);

    const [first] = getStepBlocks(container);
    const circle = getCircle(first);
    expect(circle).toHaveClass('circle', 'circle-active');
    expect(circle).not.toHaveClass('circle-passed');
    expect(getCheck(first)).toBeNull();
  });

  it('marks passed steps with the passed class and renders the 14px checkmark svg', () => {
    // currentStep > index → circle-passed branch true and the OkIcon renders.
    const { container } = render(<Stepper style={{}} steps={['A', 'B', 'C']} currentStep={1} />);

    const [first] = getStepBlocks(container);
    const circle = getCircle(first);
    expect(circle).toHaveClass('circle', 'circle-passed');
    // currentStep (1) !== index (0) → circle-active branch is false.
    expect(circle).not.toHaveClass('circle-active');

    const check = getCheck(first);
    expect(check).toBeInTheDocument();
    expect(check).toHaveStyle({ width: '14px', height: '14px' });
  });

  it('marks upcoming steps as neither active nor passed and shows no checkmark', () => {
    // For index 2 with currentStep 1: currentStep === index false AND
    // currentStep > index false → bare circle, no checkmark.
    const { container } = render(<Stepper style={{}} steps={['A', 'B', 'C']} currentStep={1} />);

    const last = getStepBlocks(container)[2];
    const circle = getCircle(last);
    expect(circle).toHaveClass('circle');
    expect(circle).not.toHaveClass('circle-active');
    expect(circle).not.toHaveClass('circle-passed');
    expect(getCheck(last)).toBeNull();
  });

  it('draws a connector line for every step except the last', () => {
    // index !== steps.length - 1 → line rendered for the first two, omitted for
    // the final step.
    const { container } = render(<Stepper style={{}} steps={['A', 'B', 'C']} currentStep={0} />);

    const blocks = getStepBlocks(container);
    expect(getLine(blocks[0])).toBeInTheDocument();
    expect(getLine(blocks[1])).toBeInTheDocument();
    // Last step: the `index !== steps.length - 1` branch is false → no line.
    expect(getLine(blocks[2])).toBeNull();

    // Total lines = steps - 1.
    expect(container.querySelectorAll('.line')).toHaveLength(blocks.length - 1);
  });

  it('activates the connector line only for lines starting from a passed step', () => {
    // currentStep = 1 → line from step 0 is active (currentStep > 0), line from
    // step 1 is not (currentStep > 1 is false).
    const { container } = render(<Stepper style={{}} steps={['A', 'B', 'C']} currentStep={1} />);

    const blocks = getStepBlocks(container);
    expect(getLine(blocks[0])).toHaveClass('line', 'line-active');
    expect(getLine(blocks[1])).toHaveClass('line');
    expect(getLine(blocks[1])).not.toHaveClass('line-active');
  });

  it('renders an empty wrapper (no step blocks) when given no steps', () => {
    // Guards the empty-array path: map produces nothing, so there are no
    // blocks, circles, lines or checkmarks — just the styled wrapper.
    const { container } = render(<Stepper style={{ padding: '4px' }} steps={[]} currentStep={0} />);

    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('stepperWrapper');
    expect(wrapper.style.padding).toBe('4px');
    expect(getStepBlocks(container)).toHaveLength(0);
    expect(container.querySelectorAll('.line')).toHaveLength(0);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a single step with an active circle and no connector line', () => {
    // Single-step edge: index (0) === steps.length - 1 (0) → no line at all.
    const { container } = render(<Stepper style={{}} steps={['Only']} currentStep={0} />);

    const [block] = getStepBlocks(container);
    expect(getCircle(block)).toHaveClass('circle', 'circle-active');
    expect(getLine(block)).toBeNull();
    expect(container.querySelectorAll('.line')).toHaveLength(0);
  });
});
