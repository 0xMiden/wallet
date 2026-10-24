/**
 * The app's record of one native dApp morph (#1817) and how a `presentationMorph` event moves it.
 *
 * The plugin runs the motion and reports it; the provider holds a `DappMotion` while one runs and asks
 * `classifyMorphEvent` what each event means before it commits anything. Pure functions, no React.
 */

import type { MorphCard, MorphTarget, PresentationMorphEvent } from '@miden/dapp-browser';

/** A native morph the provider is following; the provider holds `null` at rest. */
export interface DappMotion {
  /** Session id of the dApp being moved. */
  id: string;
  /** Its managed lifetime token; an event of another lifetime is ignored. */
  lifetime: string;
  /** The newest morph id JS sent; an event of an older id is ignored. */
  morphId: string;
  target: MorphTarget;
  /** The foreground an expand replaces, kept visible until the expand settles. */
  outgoingId: string | null;
  /** True once native reported this morph moving (a `started` or `retargeted` event). */
  started: boolean;
  /** A settled collapse waiting for its card to paint before the hide acknowledges it. */
  acknowledging: boolean;
  /** p of the latest event: 0 card, 1 slot. */
  progress: number;
  /** dp/dt of the latest event, per second. */
  velocity: number;
  /** Whether a finger held the page at the latest event. */
  tracking: boolean;
  /** Increments on every accepted event, so effects can key on it. */
  eventSeq: number;
}

export type MorphEventAction =
  | { kind: 'ignore' }
  | { kind: 'start' }
  | { kind: 'retarget'; target: MorphTarget; tracking: boolean }
  | { kind: 'settle'; target: MorphTarget }
  | { kind: 'cancel' };

const IGNORE: MorphEventAction = { kind: 'ignore' };

/**
 * What `event` means for `motion`. Anything but the held session, lifetime and morph id is ignored,
 * which is how a superseded morph's late events fall away: JS swaps in the new id when it sends the
 * newer morph. A malformed event from the bridge is ignored too.
 */
export function classifyMorphEvent(motion: DappMotion | null, event: PresentationMorphEvent): MorphEventAction {
  if (
    !motion ||
    event.id !== motion.id ||
    event.managedHostCloseToken !== motion.lifetime ||
    event.morphId !== motion.morphId ||
    // Native data crosses the bridge untyped, and a NaN progress would reach every companion animation.
    !isFiniteNumber(event.progress) ||
    !isFiniteNumber(event.velocity) ||
    typeof event.tracking !== 'boolean'
  )
    return IGNORE;
  switch (event.phase) {
    case 'started':
      return { kind: 'start' };
    case 'retargeted':
      return isMorphTarget(event.target)
        ? { kind: 'retarget', target: event.target, tracking: event.tracking }
        : IGNORE;
    case 'settled':
      return isMorphTarget(event.target) ? { kind: 'settle', target: event.target } : IGNORE;
    case 'cancelled':
      return { kind: 'cancel' };
    default:
      return IGNORE;
  }
}

/**
 * `motion` after an accepted `event`: the latest progress, velocity and tracking, a retarget's target,
 * and the next `eventSeq`. Returns `motion` itself for an event `classifyMorphEvent` ignores.
 */
export function applyMorphEvent(motion: DappMotion, event: PresentationMorphEvent): DappMotion {
  const action = classifyMorphEvent(motion, event);
  if (action.kind === 'ignore') return motion;
  return {
    ...motion,
    target: action.kind === 'retarget' ? action.target : motion.target,
    // A morph that retargets a running one never gets a `started`; its first retarget says it moves.
    started: motion.started || action.kind === 'start' || action.kind === 'retarget',
    progress: event.progress,
    velocity: event.velocity,
    tracking: event.tracking,
    eventSeq: motion.eventSeq + 1
  };
}

/** Whether `value` is a landing card native can use: finite, with a positive size. */
export function isMorphCard(value: unknown): value is MorphCard {
  if (typeof value !== 'object' || value === null) return false;
  if (!('x' in value && 'y' in value && 'width' in value && 'height' in value && 'cornerRadius' in value)) return false;
  const { x, y, width, height, cornerRadius } = value;
  return (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    isFiniteNumber(width) &&
    width > 0 &&
    isFiniteNumber(height) &&
    height > 0 &&
    isFiniteNumber(cornerRadius) &&
    cornerRadius >= 0
  );
}

function isMorphTarget(value: unknown): value is MorphTarget {
  return value === 'collapsed' || value === 'expanded';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
