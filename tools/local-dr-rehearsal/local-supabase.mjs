// Minimal local stand-in for the two Supabase HTTP surfaces the continuity
// workers use, bound to 127.0.0.1 and backed by a disposable PostgreSQL:
//   * PostgREST: POST /rest/v1/rpc/<fn> and GET /rest/v1/backup_metadata
//     executed as service_role, so the real SECURITY DEFINER control plane
//     (claim/finish/enqueue/verify) runs unchanged;
//   * Storage: bucket list/create/update and object list/download/upload,
//     bytes on a local directory, metadata rows in storage.objects.
// It is a test double for the transport only. It never proves GoTrue, the
// hosted Storage service, PostgREST configuration or network policy.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const literal = (value) =>
  value === null || value === undefined
    ? 'null'
    : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;

function safeParts(value) {
  const parts = String(value ?? '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
    throw Object.assign(new Error('INVALID_PATH'), { status: 400 });
  return parts;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function startLocalSupabase({ cluster, database, storeRoot, name }) {
  const serviceKey = `sb_secret_local_${randomBytes(18).toString('hex')}`;
  const calls = [];
  const sql = async (text, { asService = true, requestId } = {}) => {
    const prefix = asService
      ? `begin;
set local role service_role;
set local request.jwt.claims to ${literal({ role: 'service_role' })};
set local request.headers to ${literal({ 'x-request-id': requestId ?? crypto.randomUUID() })};
`
      : 'begin;\n';
    const result = await cluster.psql(database, `${prefix}${text};\ncommit;`, {
      allowFailure: true,
    });
    if (result.code !== 0) {
      const message = (result.stderr.match(/ERROR:\s+(.*)/)?.[1] ?? 'SQL_FAILED').trim();
      throw Object.assign(new Error(message), { status: 400 });
    }
    return result.stdout.trim();
  };
  const json = (response, status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  };
  const objectPath = (bucket, name) => join(storeRoot, ...safeParts(bucket), ...safeParts(name));

  async function rpc(fn, args, requestId) {
    if (!IDENT.test(fn)) throw Object.assign(new Error('INVALID_RPC'), { status: 404 });
    const named = Object.entries(args ?? {}).map(([key, value]) => {
      if (!IDENT.test(key)) throw Object.assign(new Error('INVALID_ARG'), { status: 400 });
      return `${key} => ${literal(value)}`;
    });
    calls.push(fn);
    const out = await sql(`select public.${fn}(${named.join(',')})`, { requestId });
    if (!out) return null;
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  }

  async function storageBuckets() {
    const out = await sql(
      `select coalesce(json_agg(json_build_object('id',id,'name',name,'public',public,
        'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types) order by id),'[]')
       from storage.buckets`,
      { asService: false },
    );
    return JSON.parse(out);
  }

  async function storageList(bucket, prefix, limit, offset) {
    const names = JSON.parse(
      await sql(
        `select coalesce(json_agg(json_build_object('id',id,'name',name,'metadata',metadata) order by name),'[]')
         from storage.objects where bucket_id=${literal(bucket)}`,
        { asService: false },
      ),
    );
    const base = prefix ? `${prefix}/` : '';
    const entries = new Map();
    for (const row of names) {
      if (!row.name.startsWith(base)) continue;
      const rest = row.name.slice(base.length);
      const [head, ...tail] = rest.split('/');
      if (tail.length) entries.set(head, { name: head, id: null, metadata: null });
      else entries.set(head, { name: head, id: row.id, metadata: row.metadata ?? {} });
    }
    return [...entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(offset, offset + limit);
  }

  async function storageUpload(bucket, name, bytes, headers) {
    const target = objectPath(bucket, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    // Like the hosted service, an upsert rewrites the object row metadata
    // (eTag, size, lastModified). Restore must therefore re-apply the backed
    // up metadata after uploading bytes; see restore-test-worker/storage.mjs.
    const metadata = {
      eTag: `"${createHash('md5').update(bytes).digest('hex')}"`,
      size: bytes.length,
      mimetype: headers['content-type'] ?? 'application/octet-stream',
      cacheControl: headers['cache-control'] ?? 'no-cache',
      lastModified: new Date().toISOString(),
      contentLength: bytes.length,
      httpStatusCode: 200,
    };
    await sql(
      `insert into storage.objects(bucket_id,name,metadata,path_tokens)
       values(${literal(bucket)},${literal(name)},${literal(metadata)},string_to_array(${literal(name)},'/'))
       on conflict(bucket_id,name) do update set metadata=excluded.metadata`,
      { asService: false },
    );
  }

  const server = createServer(async (request, response) => {
    try {
      const auth = request.headers.authorization ?? '';
      if (auth !== `Bearer ${serviceKey}` || request.headers.apikey !== serviceKey)
        return json(response, 401, { message: 'UNAUTHORIZED' });
      const url = new URL(request.url ?? '/', 'http://local');
      const path = decodeURIComponent(url.pathname);
      const requestId = request.headers['x-request-id'];
      let match;
      if (request.method === 'POST' && (match = path.match(/^\/rest\/v1\/rpc\/([^/]+)$/))) {
        const raw = (await body(request)).toString('utf8');
        return json(response, 200, await rpc(match[1], raw ? JSON.parse(raw) : {}, requestId));
      }
      if (request.method === 'GET' && path === '/rest/v1/backup_metadata') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '') ?? '';
        const columns = (url.searchParams.get('select') ?? 'id').split(',');
        if (!columns.every((c) => IDENT.test(c)))
          return json(response, 400, { message: 'INVALID_SELECT' });
        const out = await sql(
          `select coalesce(json_agg(json_build_object(${columns.map((c) => `'${c}',${c}`).join(',')})),'[]')
           from public.backup_metadata where id=${literal(id)}::uuid`,
        );
        return json(response, 200, JSON.parse(out));
      }
      if (request.method === 'GET' && path === '/storage/v1/bucket')
        return json(response, 200, await storageBuckets());
      if (request.method === 'POST' && path === '/storage/v1/bucket') {
        const b = JSON.parse((await body(request)).toString('utf8'));
        await sql(
          `insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
           values(${literal(b.id)},${literal(b.name ?? b.id)},${literal(Boolean(b.public))},${literal(b.file_size_limit ?? null)},${b.allowed_mime_types ? `${literal(`{${b.allowed_mime_types.join(',')}}`)}::text[]` : 'null'})`,
          { asService: false },
        );
        return json(response, 200, { name: b.id });
      }
      if (request.method === 'PUT' && (match = path.match(/^\/storage\/v1\/bucket\/([^/]+)$/))) {
        const b = JSON.parse((await body(request)).toString('utf8'));
        await sql(
          `update storage.buckets set public=${literal(Boolean(b.public))} where id=${literal(match[1])}`,
          { asService: false },
        );
        return json(response, 200, { message: 'Successfully updated' });
      }
      if (
        request.method === 'POST' &&
        (match = path.match(/^\/storage\/v1\/object\/list\/(.+)$/))
      ) {
        const b = JSON.parse((await body(request)).toString('utf8'));
        return json(
          response,
          200,
          await storageList(match[1], b.prefix ?? '', b.limit ?? 100, b.offset ?? 0),
        );
      }
      if ((match = path.match(/^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/))) {
        const [, bucket, name] = match;
        if (request.method === 'GET') {
          let bytes;
          try {
            bytes = await readFile(objectPath(bucket, name));
          } catch {
            return json(response, 404, { message: 'Object not found' });
          }
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          return response.end(bytes);
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          await storageUpload(bucket, name, await body(request), request.headers);
          return json(response, 200, { Id: crypto.randomUUID(), Key: `${bucket}/${name}` });
        }
      }
      return json(response, 404, { message: 'NOT_FOUND' });
    } catch (error) {
      return json(response, error.status ?? 500, { message: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    name,
    url: `http://127.0.0.1:${port}`,
    serviceKey,
    calls,
    sql,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
