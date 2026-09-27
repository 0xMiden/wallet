import { parse } from 'tldts';

/**
 * Splits a dApp origin for display on an approval surface: `lead` (the scheme and leading labels)
 * may be elided when space runs short, `domain` (the registrable domain, plus port) may not, because
 * it is the part that says who is asking. `lead + domain` is always the input.
 *
 * The registrable domain comes from the public suffix list with private suffixes included, so
 * `evil.github.io` keeps all three labels. A host with none (an IP address, `localhost`) is kept
 * whole. Anything that is not an origin this can split is returned entirely as `domain`, so an
 * unrecognised value is never shortened from its end.
 */
export function splitDappOrigin(origin: string): { lead: string; domain: string } {
  const whole = { lead: '', domain: origin };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return whole;
  }
  const { hostname, port } = url;
  if (!hostname) return whole;

  const registrable = parse(hostname, { allowPrivateDomains: true }).domain;
  let kept = hostname;
  if (registrable) {
    // tldts always lowercases; the host keeps its original case for a non-special scheme
    // (the URL parser only lowercases http/https/etc), so the search has to ignore case too,
    // or a case mismatch finds no match (-1) and slice(-1) keeps one character of the host.
    const index = hostname.toLowerCase().lastIndexOf(registrable);
    if (index === -1) return whole;
    kept = hostname.slice(index);
  }
  const tail = port ? `${kept}:${port}` : kept;
  // `kept` can carry the host's original case (see above), so this comparison is
  // case-insensitive on both sides; the slice below still returns origin's own text.
  if (!origin.toLowerCase().endsWith(tail.toLowerCase())) return whole;

  const cut = origin.length - tail.length;
  return { lead: origin.slice(0, cut), domain: origin.slice(cut) };
}
