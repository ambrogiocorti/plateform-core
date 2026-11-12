import { validateEnvironment } from '../../shared/deployment';
import type { Environment } from '../../shared/deployment';
export type { Environment } from '../../shared/deployment';
let loaded: Environment | undefined;

export function environment(): Environment {
  if (loaded) return loaded;
  const config = validateEnvironment({
    environment: import.meta.env.VITE_ENVIRONMENT ?? 'development',
    publicBaseUrl: import.meta.env.VITE_PUBLIC_BASE_URL,
    staffBaseUrl: import.meta.env.VITE_STAFF_BASE_URL,
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    releaseVersion: import.meta.env.VITE_RELEASE_VERSION ?? '0.1.0',
  });
  loaded = config;
  return config;
}

export function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' || (url.origin === location.origin && url.protocol === 'http:')
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
