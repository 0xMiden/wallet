/**
 * What Explore's header search does with Enter / the go key: a URL (typed or pasted) opens as
 * that URL; anything else opens the first catalog match; with no match it is treated as a host, the
 * way the old search bar treated every input.
 */

/** `https://` in front of anything without a scheme. Empty for blank input. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** A scheme, a dotted host, an IPv4 address or localhost, with no spaces. */
export function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  if (!value || /\s/.test(value)) return false;
  return (
    /^https?:\/\//i.test(value) ||
    /^localhost(:\d+)?(\/|$)/i.test(value) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value) ||
    /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(value)
  );
}

/** The URL a submitted query opens, or `null` when there is nothing to open. */
export function urlForQuery(query: string, firstMatchUrl: string | undefined): string | null {
  if (!query.trim()) return null;
  if (looksLikeUrl(query)) return normalizeUrl(query);
  return firstMatchUrl ?? normalizeUrl(query);
}
