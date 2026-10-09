export function nativeDatabaseEnvironment(input?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function nativeAPIURL(status: {
  API_URL?: string;
  ANON_KEY?: string;
  SERVICE_ROLE_KEY?: string;
}): URL;
export function nativeFetch(api: URL, transport?: typeof fetch): typeof fetch;
export function nativeTOTP(secret: string, timestamp?: number): string;
