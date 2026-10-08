import { z } from 'zod';

export const environmentSchema = z.object({
  environment: z.enum(['development', 'staging', 'production']),
  publicBaseUrl: z.url(),
  staffBaseUrl: z.url(),
  supabaseUrl: z.url(),
  publishableKey: z.string().min(20),
  releaseVersion: z.string().min(1).max(50),
});
export type Environment = z.infer<typeof environmentSchema>;

function applicationUrl(value: string, development: boolean): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.includes('*') ||
    /%(?:2f|5c)/i.test(url.pathname)
  )
    throw new Error('INVALID_APPLICATION_URL');
  if (!development && url.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
  return url;
}

export function validateEnvironment(input: unknown): Environment {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) throw new Error('CONFIGURATION_REQUIRED');
  const config = parsed.data;
  const development = config.environment === 'development';
  const publicUrl = applicationUrl(config.publicBaseUrl, development);
  const staffUrl = applicationUrl(config.staffBaseUrl, development);
  const backendUrl = applicationUrl(config.supabaseUrl, development);
  const publicPath = publicUrl.pathname.replace(/\/$/, '');
  const staffPath = staffUrl.pathname.replace(/\/$/, '');
  if (publicUrl.origin === staffUrl.origin && staffPath !== `${publicPath}/staff`)
    throw new Error('STAFF_PATH_ISOLATION_REQUIRED');
  if (backendUrl.pathname !== '/') throw new Error('INVALID_SUPABASE_URL');
  if (/^(sb_secret_|sk_(?:live|test)_)/.test(config.publishableKey))
    throw new Error('SERVER_SECRET_IN_BROWSER_CONFIG');
  if (config.publishableKey.split('.').length === 3) {
    try {
      const encoded = config.publishableKey.split('.')[1] ?? '';
      const claims: unknown = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')));
      if (!z.object({ role: z.literal('anon') }).safeParse(claims).success)
        throw new Error('INVALID_PUBLIC_KEY');
    } catch {
      throw new Error('INVALID_PUBLIC_KEY');
    }
  } else if (
    !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(config.publishableKey) &&
    !(development && config.publishableKey === 'local-browser-contract-test-key')
  )
    throw new Error('INVALID_PUBLIC_KEY');
  return config;
}

function permittedOrigins(values: readonly string[], development: boolean): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const url = applicationUrl(value, development);
        if (url.pathname !== '/') throw new Error('ORIGIN_REQUIRED');
        return url.origin;
      }),
    ),
  ];
}

/** No credentials, wildcard origins, inline scripts, or public source maps. */
export function securityHeaders(
  config: Environment,
  area: 'public' | 'staff',
  additions: { imageOrigins?: readonly string[]; connectOrigins?: readonly string[] } = {},
): Record<string, string> {
  validateEnvironment(config);
  const backend = new URL(config.supabaseUrl);
  const realtime = `${backend.protocol === 'https:' ? 'wss:' : 'ws:'}//${backend.host}`;
  const connections = permittedOrigins(
    additions.connectOrigins ?? [],
    config.environment === 'development',
  );
  const images = permittedOrigins(
    additions.imageOrigins ?? [],
    config.environment === 'development',
  );
  const csp = [
    "default-src 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${backend.origin} ${images.join(' ')}`.trim(),
    "font-src 'self'",
    `connect-src 'self' ${backend.origin} ${realtime} ${connections.join(' ')}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    ...(config.environment === 'development' ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-cache',
    ...(area === 'staff' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    ...(config.environment === 'development'
      ? {}
      : { 'Strict-Transport-Security': 'max-age=31536000' }),
  };
}
