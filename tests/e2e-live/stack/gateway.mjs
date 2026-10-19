// Minimal local stand-in for the Supabase API gateway (Kong) on the disposable e2e stack.
// Routes /rest/v1 -> PostgREST, /auth/v1 -> GoTrue and /functions/v1/<name> -> that Edge Function
// when the stack serves it (E2E_FUNCTION_PORTS), and /storage/v1 -> storage-api when the stack runs
// it (E2E_STORAGE_PORT). Realtime is not served here: the browser suite must not claim to exercise it.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const port = Number(process.env.E2E_GATEWAY_PORT ?? 54321);
const routes = [
  ['/rest/v1', Number(process.env.E2E_POSTGREST_PORT ?? 54330)],
  ['/auth/v1', Number(process.env.E2E_GOTRUE_PORT ?? 9999)],
];
for (const [name, target] of Object.entries(JSON.parse(process.env.E2E_FUNCTION_PORTS ?? '{}')))
  routes.push([`/functions/v1/${name}`, target]);
if (process.env.E2E_STORAGE_PORT)
  routes.push(['/storage/v1', Number(process.env.E2E_STORAGE_PORT)]);
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, x-client-info, apikey, content-type, prefer, accept-profile, content-profile, range, x-plateform-request-id, x-plateform-impersonation, x-supabase-api-version, x-plateform-client, x-plateform-release',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD',
  'access-control-expose-headers': 'content-range, x-supabase-api-version',
};

function handle(request, response) {
  const route = routes.find(
    ([prefix]) => request.url?.startsWith(prefix + '/') || request.url === prefix,
  );
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...cors,
      'access-control-allow-headers':
        request.headers['access-control-request-headers'] ?? cors['access-control-allow-headers'],
    });
    response.end();
    return;
  }
  if (!route) {
    response.writeHead(404, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'not served by local e2e gateway' }));
    return;
  }
  const [prefix, target] = route;
  const headers = {
    ...request.headers,
    host: `127.0.0.1:${target}`,
    'x-forwarded-for': '127.0.0.1',
  };
  delete headers.apikey;
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: target,
      method: request.method,
      path: request.url.slice(prefix.length) || '/',
      headers,
    },
    (reply) => {
      const out = { ...reply.headers, ...cors };
      response.writeHead(reply.statusCode ?? 502, out);
      reply.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    response.writeHead(502, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: error.message }));
  });
  request.pipe(upstream);
}

http.createServer(handle).listen(port, '127.0.0.1', () => console.log(`e2e gateway on ${port}`));
// Same routes over HTTPS (self-signed, this stack only): asset URLs must be https:// to be saved.
if (process.env.E2E_TLS_PORT)
  https
    .createServer(
      {
        cert: readFileSync(process.env.E2E_TLS_CERT ?? ''),
        key: readFileSync(process.env.E2E_TLS_KEY ?? ''),
      },
      handle,
    )
    .listen(Number(process.env.E2E_TLS_PORT), '127.0.0.1', () =>
      console.log(`e2e gateway (TLS) on ${process.env.E2E_TLS_PORT}`),
    );
