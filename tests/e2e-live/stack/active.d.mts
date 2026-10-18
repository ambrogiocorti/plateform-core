export const active: {
  mode: 'native' | 'supabase';
  supabaseUrl: string;
  kongUrl?: string;
  dbUrl?: string;
  anonKey?: string;
  serviceKey?: string;
};
export function reset(): Promise<void>;
