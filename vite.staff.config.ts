import { defineConfig, loadEnv } from 'vite';
import { plateformPwa } from './vite.pwa.ts';
import { plateformSecurity } from './vite.security.ts';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base =
    command === 'build' && env.VITE_STAFF_BASE_URL
      ? new URL(env.VITE_STAFF_BASE_URL).pathname.replace(/\/?$/, '/')
      : '/';
  const staffBase = env.VITE_STAFF_BASE_URL
    ? new URL(env.VITE_STAFF_BASE_URL).pathname.replace(/\/?$/, '/')
    : '/staff/';
  return {
    base,
    define: { 'import.meta.env.PLATEFORM_AREA': JSON.stringify('staff') },
    plugins: [plateformPwa('staff', base, staffBase), plateformSecurity('staff', env)],
    root: fileURLToPath(new URL('./apps/staff', import.meta.url)),
    envDir: '../..',
    publicDir: '../../assets/staff',
    server: { port: 5174, strictPort: true, fs: { allow: ['../..'] } },
    build: { outDir: '../../dist/staff', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  };
});
