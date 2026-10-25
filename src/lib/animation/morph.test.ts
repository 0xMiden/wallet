import type { Transition } from 'framer-motion';

import { springProgressAt, springTimeToReach } from './morph';
import { springs } from './springs';

type MorphSpring = 'morphExpand' | 'morphCollapse' | 'morphRelease';

function riseSamples(name: MorphSpring): number[] {
  return Array.from({ length: 2001 }, (_, ms) => springProgressAt(springs[name], ms / 1000, 0, 1, 0).value);
}

it.each([
  ['morphExpand', 0.42, 0.88, 223.8, 26.3],
  ['morphCollapse', 0.38, 0.9, 273.4, 29.8],
  ['morphRelease', 0.4, 0.82, 246.7, 25.8]
] as const)('derives %s from response %s and damping ratio %s', (name, response, zeta, k, c) => {
  const { stiffness, damping, mass } = springs[name];
  expect(stiffness).toBeCloseTo(((2 * Math.PI) / response) ** 2, 1);
  expect(damping).toBeCloseTo((4 * Math.PI * zeta) / response, 1);
  expect(stiffness).toBeCloseTo(k, 1);
  expect(damping).toBeCloseTo(c, 1);
  expect(mass).toBe(1);
});

it.each([
  ['morphExpand', 0.58],
  ['morphCollapse', 0.506],
  ['morphRelease', 0.548]
] as const)('%s last leaves a thousandth of its target at %s s', (name, seconds) => {
  const lastOutside = riseSamples(name).reduce((last, value, ms) => (Math.abs(1 - value) > 0.001 ? ms : last), 0);
  expect(Math.abs(lastOutside / 1000 - seconds)).toBeLessThanOrEqual(0.005);
});

it.each([
  ['morphExpand', 0.003],
  ['morphCollapse', 0.0015],
  ['morphRelease', 0.011]
] as const)('%s overshoots by %s', (name, overshoot) => {
  expect(Math.abs(Math.max(...riseSamples(name)) - 1 - overshoot)).toBeLessThanOrEqual(0.0005);
});

it('finds the time the expand spring first reaches 0.6', () => {
  const seconds = springTimeToReach(springs.morphExpand, 0, 1, 0, 0.6);
  expect(seconds).not.toBeNull();
  expect(Math.abs((seconds ?? 0) - 0.125)).toBeLessThanOrEqual(0.002);
  // Interpolated between the 1 ms samples, so the spring sits on the value itself, not up to a sample past it.
  expect(Math.abs(springProgressAt(springs.morphExpand, seconds ?? 0, 0, 1, 0).value - 0.6)).toBeLessThanOrEqual(1e-4);
});

it('finds the collapse crossing of 0.35', () => {
  const seconds = springTimeToReach(springs.morphCollapse, 1, 0, 0, 0.35);
  expect(Math.abs((seconds ?? 0) - 0.125)).toBeLessThanOrEqual(0.002);
  expect(Math.abs(springProgressAt(springs.morphCollapse, seconds ?? 0, 1, 0, 0).value - 0.35)).toBeLessThanOrEqual(
    1e-4
  );
});

it('waits for the return onto the target side when a reversal first carries the spring away', () => {
  // An expand caught at 0.7 falling at the clamped 8/s dips below 0.6 before it turns back up.
  const seconds = springTimeToReach(springs.morphExpand, 0.7, 1, -8, 0.6);
  expect(Math.abs((seconds ?? 0) - 0.082)).toBeLessThanOrEqual(0.002);
  const sample = springProgressAt(springs.morphExpand, seconds ?? 0, 0.7, 1, -8);
  expect(Math.abs(sample.value - 0.6)).toBeLessThanOrEqual(1e-4);
  expect(sample.velocity).toBeGreaterThan(0);
  expect(springTimeToReach(springs.morphExpand, 0.7, 1, -4, 0.6)).toBeNull();
});

it.each([
  ['an overshoot threshold', 0, 1, 0, 1.002],
  ['a launch from rest at the target, upward', 0, 0, 1, 0.01],
  ['a launch from rest at the target, downward', 0, 0, -1, -0.01]
] as const)('keeps the first arrival at %s', (_, from, to, velocity, value) => {
  const seconds = springTimeToReach(springs.morphExpand, from, to, velocity, value);
  expect(seconds).not.toBeNull();
  const sample = springProgressAt(springs.morphExpand, seconds ?? 0, from, to, velocity);
  expect(Math.abs(sample.value - value)).toBeLessThanOrEqual(1e-4);
  expect(Math.sign(sample.velocity)).toBe(Math.sign(value - from));
});

it('keeps the first arrival at a value behind a launch from rest at the target', () => {
  // Launched up from rest at 0, the release spring swings back below 0 before it settles.
  const seconds = springTimeToReach(springs.morphRelease, 0, 0, 8, -0.0005);
  expect(seconds).not.toBeNull();
  const sample = springProgressAt(springs.morphRelease, seconds ?? 0, 0, 0, 8);
  expect(Math.abs(sample.value + 0.0005)).toBeLessThanOrEqual(1e-4);
  expect(sample.velocity).toBeLessThan(0);
});

it('returns null for a value the spring never reaches', () => {
  expect(springTimeToReach(springs.morphExpand, 0, 1, 0, 1.5)).toBeNull();
});

it('reaches its starting value at once', () => {
  expect(springTimeToReach(springs.morphExpand, 0.4, 1, 2, 0.4)).toBe(0);
});

it('carries the start velocity and keeps moving toward a reversed target', () => {
  // A collapse caught at 0.7 moving down at 2/s, retargeted to expand: it keeps falling before it turns.
  const start = springProgressAt(springs.morphExpand, 0, 0.7, 1, -2);
  expect(start.value).toBeCloseTo(0.7, 9);
  expect(start.velocity).toBeCloseTo(-2, 9);
  expect(springProgressAt(springs.morphExpand, 0.01, 0.7, 1, -2).value).toBeLessThan(0.7);
});

it.each([
  ['underdamped', springs.morphRelease],
  ['critically damped', { type: 'spring', stiffness: 100, damping: 20, mass: 1 }],
  ['overdamped', { type: 'spring', stiffness: 100, damping: 40, mass: 2 }]
] as const)('starts where it was told and reports the analytic velocity of a %s spring', (_, transition) => {
  const start = springProgressAt(transition, 0, 0.2, 1, 3);
  expect(start.value).toBeCloseTo(0.2, 9);
  expect(start.velocity).toBeCloseTo(3, 9);
  const h = 1e-5;
  for (const t of [0.05, 0.2, 0.6]) {
    const slope =
      (springProgressAt(transition, t + h, 0.2, 1, 3).value - springProgressAt(transition, t - h, 0.2, 1, 3).value) /
      (2 * h);
    expect(springProgressAt(transition, t, 0.2, 1, 3).velocity).toBeCloseTo(slope, 3);
  }
});

it('treats a transition without spring physics as already arrived', () => {
  const tween: Transition = { duration: 0.2 };
  expect(springProgressAt(tween, 0, 0, 1, 0)).toEqual({ value: 1, velocity: 0 });
  expect(springTimeToReach(tween, 0, 1, 0, 0.5)).toBeNull();
});

it('defaults a missing mass to 1', () => {
  const withMass = springProgressAt({ type: 'spring', stiffness: 100, damping: 20, mass: 1 }, 0.1, 0, 1, 0);
  expect(springProgressAt({ type: 'spring', stiffness: 100, damping: 20 }, 0.1, 0, 1, 0)).toEqual(withMass);
});
