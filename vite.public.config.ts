import { defineConfig, loadEnv } from 'vite';
import { plateformPwa } from './vite.pwa.ts';
import { plateformSecurity } from './vite.security.ts';
import { commercialEditionMetadata } from './vite.edition.ts';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base =
    command === 'build' && env.VITE_PUBLIC_BASE_URL
      ? new URL(env.VITE_PUBLIC_BASE_URL).pathname.replace(/\/?$/, '/')
      : '/';
  const staffBase = env.VITE_STAFF_BASE_URL
    ? new URL(env.VITE_STAFF_BASE_URL).pathname.replace(/\/?$/, '/')
    : '/staff/';
  return {
    base,
    define: { 'import.meta.env.PLATEFORM_AREA': JSON.stringify('public') },
    plugins: [
      commercialEditionMetadata(env),
      plateformPwa('public', base, staffBase),
      plateformSecurity('public', env),
    ],
    root: fileURLToPath(new URL('./apps/public', import.meta.url)),
    // Dynamic staff/public views must not trigger new dependency hashes while
    // an operational dialog is loading in a browser.
    optimizeDeps: {
      noDiscovery: true,
      include: ['@supabase/supabase-js', 'idb', 'qrcode', 'saxes', 'zod'],
    },
    envDir: '../..',
    publicDir: '../../assets/public',
    server: { port: 5173, strictPort: true, fs: { allow: ['../..'] } },
    build: { outDir: '../../dist/public', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  };
});
