export function normalizeNoteRelayFetch(
  request: RequestInfo | URL,
  options: RequestInit | undefined,
  pendingResponse: Promise<Response>
): Promise<Response>;
