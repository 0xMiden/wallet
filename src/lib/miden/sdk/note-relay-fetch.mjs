/**
 * Let Rust retire a relay outbox entry when SendNoteWithProof (SDK 0.17) proves the transport
 * already has it. The 0.17 transport stores a duplicate as `AlreadyPresent` and answers OK
 * ("A retry with the same note ID keeps the first envelope", note_transport.proto), so this
 * guards a transport that still answers a duplicate with the old error.
 * Inlined into the SDK glue by scripts/generate-note-relay-patch.mjs, including classic workers.
 */
export async function normalizeNoteRelayFetch(request, options, pendingResponse) {
  const response = await pendingResponse;
  try {
    const method = options?.method ?? request.method ?? 'GET';
    const url = typeof request === 'string' ? request : (request.url ?? request.href);
    if (
      method.toUpperCase() !== 'POST' ||
      !new URL(url).pathname.endsWith('/miden.note_transport.v1.NoteTransportService/SendNoteWithProof') ||
      response.status !== 200 ||
      !/^application\/grpc-web(?:\+proto)?(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      return response;
    }

    // The transport sends an error as headers only, and tonic takes a header status without
    // reading the body, so neither does this.
    const status = response.headers.get('grpc-status');
    if (status !== '6' && status !== '13') return response;
    const raw = response.headers.get('grpc-message') ?? '';
    let message = null;
    try {
      message = decodeURIComponent(raw);
    } catch {
      // Reported below with the raw text.
    }
    // `notes.id` is the only unique note key (`seq` is the row id), so only a violation that
    // names it proves this note is stored.
    const duplicate =
      message !== null &&
      (status === '6' ||
        /^Failed to store note: ConstraintViolation\("(?:Unique constraint violation: )?UNIQUE constraint failed: notes\.id"\)$/.test(
          message
        ));
    if (!duplicate) {
      // The outbox resends this on every sync, so a changed transport message shows up here.
      console.warn('[noteRelay] SendNote rejection left for the outbox to retry', { status, message: raw });
      return response;
    }
    console.info('[noteRelay] SendNote duplicate acknowledged', { status, message });

    // SendNoteWithProofResponse is empty, but tonic still requires a unary protobuf data frame.
    const ack = new Uint8Array(26);
    ack[5] = 128;
    ack[9] = 16;
    ack.set(new TextEncoder().encode('grpc-status: 0\r\n'), 10);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/grpc-web+proto');
    headers.set('grpc-status', '0');
    for (const key of [
      'grpc-message',
      'grpc-status-details-bin',
      'content-length',
      'content-encoding',
      'grpc-encoding'
    ]) {
      headers.delete(key);
    }
    return new Response(ack, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}
