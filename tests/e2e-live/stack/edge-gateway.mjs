// Front door for the Supabase CLI e2e stack. Everything goes to Kong (Auth, REST, Realtime
// WebSocket, Storage) except /functions/v1/<name>, which goes to that Edge Function served by
// the host Deno (the edge-runtime container cannot reach deno.land/npm from this sandbox).
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.E2E_GATEWAY_PORT ?? 54320);
const kong = Number(process.env.E2E_KONG_PORT ?? 54321);
const functions = JSON.parse(process.env.E2E_FUNCTION_PORTS ?? '{}');

function target(url) {
  const match = /^\/functions\/v1\/([a-z-]+)(\/.*|\?.*)?$/.exec(url ?? '');
  if (!match) return { port: kong, path: url };
  const fn = functions[match[1]];
  return fn ? { port: fn, path: match[2] ?? '/' } : null;
}

const server = http.createServer((request, response) => {
  const destination = target(request.url);
  if (!destination) {
    response.writeHead(404, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify({ message: 'function not served by local e2e stack' }));
    return;
  }
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: destination.port,
      method: request.method,
      path: destination.path,
      headers: { ...request.headers, 'x-forwarded-for': '127.0.0.1' },
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: error.message }));
  });
  request.pipe(upstream);
});

// Realtime WebSocket: raw TCP passthrough of the upgrade to Kong.
server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(kong, '127.0.0.1', () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`e2e edge gateway on ${port}`));
