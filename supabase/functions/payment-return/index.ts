import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve((request: Request) => {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const url = new URL(request.url);
  const operation = url.searchParams.get('payment') ?? '';
  if (!uuid.test(operation)) return new Response('Richiesta non valida.', { status: 400 });

  const body = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plateform &middot; Pagamento</title></head><body><main><h1>Plateform</h1><p>Il pagamento &egrave; in fase di verifica.</p><p>Puoi tornare a Plateform: lo stato definitivo viene confermato dal server.</p></main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
