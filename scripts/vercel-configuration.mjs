/** Vercel static routing for an isolated Plateform installation. No Node deps. */
export function createVercelConfiguration({ supabaseUrl, mode = 'staging' }) {
  if (!['staging', 'production'].includes(mode)) throw new Error('INVALID_VERCEL_MODE');
  const raw = new URL(supabaseUrl);
  if (
    raw.protocol !== 'https:' ||
    raw.username ||
    raw.password ||
    raw.search ||
    raw.hash ||
    raw.pathname !== '/' ||
    !/^[a-z0-9.-]+$/.test(raw.hostname) ||
    raw.hostname === 'localhost'
  )
    throw new Error('INVALID_VERCEL_SUPABASE_ORIGIN');
  if (mode === 'production' && process.env.PLATEFORM_AUTHORIZE_PRODUCTION_CONFIG !== 'yes')
    throw new Error('PRODUCTION_CONFIG_REQUIRES_EXPLICIT_AUTHORIZATION');
  const backend = raw.origin;
  const websocket = `wss://${raw.host}`;
  const csp = [
    "default-src 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${backend}`,
    "font-src 'self'",
    `connect-src 'self' ${backend} ${websocket}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
  const common = [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  ];
  // Do not use a wildcard SPA rewrite. An asset that does not exist MUST get a 404,
  // not HTML with status 200. Vercel checks real files before rewrites.
  const publicRoutes = ['/menu', '/ristorante', '/gallery', '/prenota', '/contatti', '/sedi'];
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: 'npm run build:pages',
    installCommand: 'npm ci',
    outputDirectory: 'dist/site',
    rewrites: [
      { source: '/staff', destination: '/staff/index.html' },
      { source: '/staff/:page([a-z0-9-]+)', destination: '/staff/index.html' },
      { source: '/menu/:slug([a-z0-9-]+)', destination: '/index.html' },
      { source: '/sedi/:slug([a-z0-9-]+)', destination: '/index.html' },
      { source: '/tavolo/:token([a-zA-Z0-9-]+)', destination: '/index.html' },
      ...publicRoutes.map((source) => ({ source, destination: '/index.html' })),
    ],
    headers: [
      {
        source: '/(.*)',
        headers: [
          ...common,
          ...(mode === 'staging' ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
        ],
      },
      {
        source: '/staff/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
      {
        source: '/staff',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ],
  };
}
