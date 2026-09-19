/**
 * Whether the launcher has played its entrance reveal this session.
 *
 * The launcher unmounts while a dApp is in the foreground and mounts again when it is closed or
 * minimized, and the capsule then morphs back into the card. Replaying the reveal there would
 * fight that morph, so the reveal plays on the launcher's first mount only. (Tab revisits never
 * remount it: tab panes stay mounted.)
 */

let revealed = false;

export function hasRevealed(): boolean {
  return revealed;
}

export function markRevealed(): void {
  revealed = true;
}

/** For tests: forget that the reveal played. */
export function resetRevealed(): void {
  revealed = false;
}
