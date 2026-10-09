import postgres from 'npm:postgres@3.4.9';
import config from './deployment.json' with { type: 'json' };
import payload from './payload.json' with { type: 'json' };
import { createInstallerHandler } from './handler.mjs';

Deno.serve(
  createInstallerHandler({
    config,
    payload,
    env: {
      SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
      SUPABASE_DB_URL: Deno.env.get('SUPABASE_DB_URL'),
    },
    connect: async (url: string) => {
      const client = postgres(url, {
        max: 1,
        prepare: false,
        ssl: 'require',
        connect_timeout: 10,
        onnotice: () => {},
        debug: false,
      });
      let connection;
      try {
        connection = await client.reserve();
      } catch {
        await client.end({ timeout: 5 }).catch(() => {});
        throw new Error('STAGING_INSTALL_DATABASE_CONNECTION_FAILED');
      }
      return {
        query: (sql: string) => connection.unsafe(sql).simple(),
        close: async () => {
          connection.release();
          await client.end({ timeout: 5 });
        },
      };
    },
  }),
);
