export async function testRequestSha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1_048_576)
    throw new Error('Invalid native request byte size');
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
