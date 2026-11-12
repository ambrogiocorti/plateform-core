// Preloaded into each Edge Function when served outside the Supabase edge runtime (local e2e only):
// binds Deno.serve to FUNCTION_PORT on 127.0.0.1 instead of the runtime-managed listener.
// Runs under Deno; the minimal shape below keeps it valid for the Node TypeScript project too.
type Serve = (options: Record<string, unknown>, handler: unknown) => unknown;
const runtime = (
  globalThis as unknown as { Deno: { env: { get(key: string): string | undefined }; serve: Serve } }
).Deno;
const port = Number(runtime.env.get('FUNCTION_PORT'));
const original = runtime.serve.bind(runtime);
runtime.serve = (first: unknown, second?: unknown) => {
  const handler = typeof first === 'function' ? first : second;
  const options = typeof first === 'object' && first ? (first as Record<string, unknown>) : {};
  return original({ ...options, port, hostname: '127.0.0.1', onListen: () => {} }, handler);
};
