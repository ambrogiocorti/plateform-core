#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createVercelConfiguration } from './vercel-configuration.mjs';
const config = createVercelConfiguration({
  supabaseUrl: process.env.VITE_SUPABASE_URL,
  mode: process.env.PLATEFORM_VERCEL_MODE || 'staging',
});
const destination = process.env.PLATEFORM_VERCEL_OUTPUT || 'vercel.json';
await writeFile(destination, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
console.log(`Generated ${destination} for ${process.env.PLATEFORM_VERCEL_MODE || 'staging'} (no credentials written).`);
