/** The full-screen contact pages. The Address Book list itself stays a Settings page. */
export const ADDRESS_BOOK_PATH = '/settings/address-book';
export const NEW_CONTACT_PATH = '/contacts/new';

export function contactPath(address: string): string {
  return `/contacts/${encodeURIComponent(address)}`;
}
