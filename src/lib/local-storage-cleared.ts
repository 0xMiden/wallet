import { createListenerSet } from 'lib/listener-set';

// A document's own localStorage.clear() fires no storage event in that document, so reset.ts
// announces its clears here for the modules that cache a localStorage value. React-free on purpose:
// the service worker imports reset.ts.
const { subscribe, notify } = createListenerSet();

export const onLocalStorageCleared = subscribe;
export const localStorageCleared = notify;
