import { createListenerSet } from 'lib/listener-set';

// A document's own wipe of localStorage or the platform key-value store fires no event in that
// document, so reset.ts announces it here. Its own module so storage.ts, reset.ts and
// activity-read.ts can share it without importing one another. React-free on purpose: the service
// worker imports reset.ts.
const { subscribe, notify } = createListenerSet();

export const onStorageCleared = subscribe;
export const storageCleared = notify;
