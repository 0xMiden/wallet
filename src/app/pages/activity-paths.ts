/** The Activity tab's own route, and the fallback a group's page goes back to. */
export const ACTIVITY_PATH = '/history';

/**
 * The Activity tab with its Pending filter already chosen: where anything that used to open the
 * "Pending notes" page now goes — the home prompt, a received-transfer notification on iOS,
 * Android and the extension, and the claim link on a transaction's own page.
 *
 * `AllHistory` reads `filter` off the location, so this works both as a deep link into a cold
 * start and as a navigation onto the tab while it is already mounted.
 */
export const ACTIVITY_PENDING_PATH = `${ACTIVITY_PATH}?filter=pending`;
