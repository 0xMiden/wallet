import { createListenerSet } from 'lib/listener-set';

// openExternalUrl announces here that a page it opened failed to load and its overlay has closed.
// The notice is shown by a component under DialogsProvider, which a plain module cannot reach.
const { subscribe, notify } = createListenerSet();

export const onExternalPageFailed = subscribe;
export const externalPageFailed = notify;
