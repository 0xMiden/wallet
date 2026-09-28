import { runLockUpChecks } from './checks';

if (window.location.href.includes('extension://') === false)
  throw new Error('Lock-up checks are meant for extension pages only.');

// Top-level await: the pages that import this module render only after the lock check.
await runLockUpChecks();
