export interface RequestContext {
  requestId: string;
  correlationId: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiers are diagnostics only; they never authorize a request. */
export function requestContext(headers: Headers): RequestContext {
  const incomingRequest = headers.get('x-request-id');
  const incomingCorrelation = headers.get('x-correlation-id');
  const requestId =
    incomingRequest && uuid.test(incomingRequest)
      ? incomingRequest.toLowerCase()
      : crypto.randomUUID();
  return {
    requestId,
    correlationId:
      incomingCorrelation && uuid.test(incomingCorrelation)
        ? incomingCorrelation.toLowerCase()
        : requestId,
  };
}

export function contextualHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  const context = requestContext(headers);
  headers.set('x-request-id', context.requestId);
  headers.set('x-correlation-id', context.correlationId);
  return headers;
}
