import type { Plugin } from 'vite';
import { securityHeaders, validateEnvironment } from './shared/deployment.ts';

export function plateformSecurity(
  area: 'public' | 'staff',
  values: Record<string, string>,
): Plugin {
  return {
    name: 'plateform-security',
    apply: 'build',
    generateBundle() {
      // An unconfigured local build is allowed, but is explicitly not deployable.
      if (
        !values.VITE_SUPABASE_PUBLISHABLE_KEY &&
        (values.VITE_ENVIRONMENT ?? 'development') === 'development'
      ) {
        this.emitFile({
          type: 'asset',
          fileName: 'DEPLOYMENT_UNCONFIGURED.txt',
          source: 'Configure the environment and rebuild before deployment.\n',
        });
        return;
      }
      const config = validateEnvironment({
        environment: values.VITE_ENVIRONMENT ?? 'development',
        publicBaseUrl: values.VITE_PUBLIC_BASE_URL,
        staffBaseUrl: values.VITE_STAFF_BASE_URL,
        supabaseUrl: values.VITE_SUPABASE_URL,
        publishableKey: values.VITE_SUPABASE_PUBLISHABLE_KEY,
        releaseVersion: values.VITE_RELEASE_VERSION ?? '0.1.0',
      });
      const list = (name: string) =>
        (values[name] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      const headers = securityHeaders(config, area, {
        imageOrigins: list('VITE_IMAGE_ORIGINS'),
        connectOrigins: list('VITE_CONNECT_ORIGINS'),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'security-headers.json',
        source: JSON.stringify(headers, null, 2) + '\n',
      });
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source:
          '/*\n' +
          Object.entries(headers)
            .map(([name, value]) => `  ${name}: ${value}`)
            .join('\n') +
          '\n',
      });
    },
  };
}
