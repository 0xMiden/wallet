// A leaf, so the recovery wipe can keep these records without bundling the Capacitor app plugin.
// The platform keeps reporting the launch link for the rest of the app session, so the ids of the request links
// already taken outlive a reload.
export const BREAD_CONNECT_TAKEN_KEY = 'bread-connect:taken';
export const BREAD_CONNECT_SESSION_KEYS: readonly string[] = [BREAD_CONNECT_TAKEN_KEY];
// In localStorage, so the request links Bread holds until it can answer them outlive the system stopping the app.
export const BREAD_CONNECT_QUEUE_KEY = 'bread-connect:queue';
