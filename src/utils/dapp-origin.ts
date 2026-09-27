import { getDomain } from 'tldts';

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

  const registrable = getDomain(hostname, { allowPrivateDomains: true });
  let kept = hostname;
  if (registrable) {
    const index = hostname.lastIndexOf(registrable);
    if (index === -1) return whole;
    kept = hostname.slice(index);
  }
  const tail = port ? `${kept}:${port}` : kept;
  if (!origin.endsWith(tail)) return whole;

  const cut = origin.length - tail.length;
  return { lead: origin.slice(0, cut), domain: origin.slice(cut) };
}
