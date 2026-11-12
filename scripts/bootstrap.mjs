import { createClient } from '@supabase/supabase-js';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BOOTSTRAP_EMAIL',
  'BOOTSTRAP_PASSWORD',
  'BOOTSTRAP_NAME',
];
for (const key of required)
  if (!process.env[key]) throw new Error(`Variabile server mancante: ${key}`);
if (process.env.BOOTSTRAP_PASSWORD.length < 12)
  throw new Error('La password deve contenere almeno 12 caratteri.');
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await client.auth.admin.createUser({
  email: process.env.BOOTSTRAP_EMAIL,
  password: process.env.BOOTSTRAP_PASSWORD,
  email_confirm: true,
});
if (error || !data.user)
  throw new Error(
    'Creazione account tecnico non riuscita. Verifica configurazione e identificativo.',
  );
const { error: profileError } = await client.rpc('bootstrap_technical_user', {
  p_user: data.user.id,
  p_name: process.env.BOOTSTRAP_NAME,
});
if (profileError) {
  await client.auth.admin.deleteUser(data.user.id);
  throw new Error(
    'Bootstrap non riuscito o già eseguito. Nessun nuovo profilo tecnico è stato creato.',
  );
}
console.log('Account tecnico creato. Accedi al dominio staff, configura TOTP e completa il setup.');
