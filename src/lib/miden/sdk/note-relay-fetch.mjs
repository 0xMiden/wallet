/**
 * Let Rust retire a relay outbox entry when SendNote proves the transport already has it.
 * Inlined into the SDK glue by scripts/generate-note-relay-patch.mjs, including classic workers.
 */
export async function normalizeNoteRelayFetch(request, options, pendingResponse) {
  const response = await pendingResponse;
  const method = options?.method ?? request.method ?? 'GET';
  const url = typeof request === 'string' ? request : (request.url ?? request.href);
  try {
    if (
      method.toUpperCase() !== 'POST' ||
      new URL(url).pathname !== '/miden_note_transport.MidenNoteTransport/SendNote' ||
      response.status !== 200 ||
      !/^application\/grpc-web(?:\+proto)?(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      return response;
    }

    const headerStatus = response.headers.get('grpc-status');
    if (headerStatus !== null && headerStatus !== '13' && headerStatus !== '6') return response;
    if (response.headers.has('grpc-status-details-bin')) return response;

    // Keep the original stream and metadata untouched unless the entire unary error is recognized.
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    let trailerFields = null;
    let dataFrames = 0;
    for (let offset = 0; offset < bytes.length; ) {
      if (bytes.length - offset < 5) return response;
      const flag = bytes[offset];
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
      const end = offset + 5 + length;
      if (end > bytes.length) return response;
      if (flag === 128) {
        if (trailerFields !== null || end !== bytes.length) return response;
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset + 5, end));
        if (!text.endsWith('\r\n')) return response;
        trailerFields = new Map();
        for (const line of text.slice(0, -2).split('\r\n')) {
          const field = /^([a-z0-9-]+):[ \t]*(.*)$/i.exec(line);
          // eslint-disable-next-line no-control-regex -- Rust rejects these bytes in HTTP header values.
          const forbiddenValueBytes = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
          if (!field || forbiddenValueBytes.test(field[2]) || trailerFields.has(field[1].toLowerCase())) {
            return response;
          }
          trailerFields.set(field[1].toLowerCase(), field[2]);
          if (trailerFields.size > 64 || trailerFields.has('grpc-status-details-bin')) return response;
        }
        if (!trailerFields.has('grpc-status')) return response;
      } else if (flag !== 0 || length !== 0 || ++dataFrames > 1) {
        return response;
      }
      offset = end;
    }

    const trailerStatus = trailerFields?.get('grpc-status') ?? null;
    if (headerStatus !== null && trailerStatus !== null && headerStatus !== trailerStatus) return response;
    const headerMessage = response.headers.get('grpc-message');
    const trailerMessage = trailerFields?.get('grpc-message') ?? null;
    if (
      headerMessage !== null &&
      trailerMessage !== null &&
      decodeURIComponent(headerMessage) !== decodeURIComponent(trailerMessage)
    ) {
      return response;
    }
    const status = trailerStatus ?? headerStatus;
    const message = decodeURIComponent(trailerMessage ?? headerMessage ?? '');
    const constraint = /^Failed to store note: ConstraintViolation\((["']?)(.+)\1\)$/.exec(message);
    const duplicate =
      (status === '13' &&
        constraint !== null &&
        /^(?:Unique constraint violation|UNIQUE constraint failed: notes\.id)$/.test(constraint[2])) ||
      (status === '6' && /^note already exists(?:[.:]?|: 0x[0-9a-f]+)$/i.test(message));
    if (!duplicate) return response;

    // SendNoteResponse is empty, but tonic still requires a unary protobuf data frame.
    const ack = new Uint8Array(26);
    ack[5] = 128;
    ack[9] = 16;
    ack.set(new TextEncoder().encode('grpc-status: 0\r\n'), 10);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/grpc-web+proto');
    headers.set('grpc-status', '0');
    for (const key of ['grpc-message', 'content-length', 'content-encoding', 'grpc-encoding']) headers.delete(key);
    return new Response(ack, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}
