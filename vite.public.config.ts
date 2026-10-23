import { defineConfig, loadEnv } from 'vite';
import { plateformPwa } from './vite.pwa.ts';
import { plateformSecurity } from './vite.security.ts';
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
    plugins: [plateformPwa('public', base, staffBase), plateformSecurity('public', env)],
    root: fileURLToPath(new URL('./apps/public', import.meta.url)),
    envDir: '../..',
    // Separate dependency caches: staff and public dev servers run together in the live suite and
    // a shared node_modules/.vite makes each one invalidate the other's pre-bundled modules.
    cacheDir: fileURLToPath(new URL('./node_modules/.vite/public', import.meta.url)),
    publicDir: '../../assets/public',
    server: { port: 5173, strictPort: true, fs: { allow: ['../..'] } },
    build: { outDir: '../../dist/public', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  };
});
