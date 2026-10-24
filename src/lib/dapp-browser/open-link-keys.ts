// A leaf, so the recovery wipe can keep open-link's records without bundling the Capacitor app plugin.
// A reload starts open-link afresh; sessionStorage keeps the held link, the links already taken and the last launch
// link seen.
export const OPEN_LINK_PENDING_KEY = 'open-link:pending';
export const OPEN_LINK_TAKEN_KEY = 'open-link:taken';
export const OPEN_LINK_LAUNCH_KEY = 'open-link:launch';
export const OPEN_LINK_SESSION_KEYS: readonly string[] = [
  OPEN_LINK_PENDING_KEY,
  OPEN_LINK_TAKEN_KEY,
  OPEN_LINK_LAUNCH_KEY
];
