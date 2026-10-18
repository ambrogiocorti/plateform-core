import { expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { active } from '../stack/active.mjs';
import { anonKey, password, stack } from '../stack/seed.mjs';
import type { Member } from './devices';

export interface ApiResult {
  status: number;
  body: unknown;
}

/**
 * A staff member talking to the real HTTP surface without the UI: GoTrue password login,
 * `complete_staff_login`, then RPC/table/Edge Function calls with the member's own JWT.
 */
export async function session(member: Member) {
  const base = stack.gateway;
  const functions = active.supabaseUrl;
  const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email, password }),
  });
  expect(login.status).toBe(200);
  const { access_token: token } = (await login.json()) as { access_token: string };
  const headers = {
    apikey: anonKey,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const parse = async (response: Response): Promise<ApiResult> => {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: response.status, body };
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    parse(
      await fetch(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      }),
    );
  const read = async (table: string) =>
    parse(await fetch(`${base}/rest/v1/${table}?select=id`, { headers }));
  const invoke = async (name: string, body: Record<string, unknown>) =>
    parse(
      await fetch(`${functions}/functions/v1/${name}`, {
        method: 'POST',
        headers: { ...headers, origin: 'http://localhost:5174' },
        body: JSON.stringify(body),
      }),
    );
  const completed = await call('complete_staff_login', {
    p_device_name: `${member.role} e2e`,
    p_platform: 'Linux',
    p_app_version: '0.1.0',
    p_device: null,
    p_device_token: randomBytes(32).toString('base64url'),
  });
  expect(completed.status).toBe(200);
  return { call, read, invoke, token };
}
