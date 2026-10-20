import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve((request: Request) => {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const url = new URL(request.url);
  const operation = url.searchParams.get('payment') ?? '';
  if (!uuid.test(operation)) return new Response('Richiesta non valida.', { status: 400 });

  // Hosted Supabase serves Edge Function responses on *.supabase.co as text/plain (HTML is
  // only rendered on a custom domain), so the guest gets a readable plain-text message.
  const body =
    'Plateform\n\nIl pagamento è in fase di verifica.\n' +
    'Puoi tornare a Plateform: lo stato definitivo viene confermato dal server.\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
