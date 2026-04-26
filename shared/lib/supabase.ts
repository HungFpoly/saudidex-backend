import { createClient } from '@supabase/supabase-js';

const stripQuotes = (v: string) => v.replace(/^["']|["']$/g, '').trim();

const supabaseUrl = stripQuotes(import.meta.env?.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '');
const supabaseAnonKey = stripQuotes(import.meta.env?.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '');
const isBrowser = typeof window !== 'undefined';
const supabaseServiceKey = isBrowser
  ? ''
  : stripQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — Supabase will be unavailable.');
}

/**
 * Public (browser-safe) client — respects Row Level Security.
 * Use for all client-side reads and auth flows.
 */
export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  })
  : null;

/**
 * Server-side admin client — bypasses RLS.
 * Only use in server.ts / API routes — never import in browser bundles.
 */
export const supabaseAdmin = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
  : null;

export const isSupabaseConfigured = (): boolean => supabase !== null;

/** Helper — throws if supabase is not configured */
export function requireSupabase() {
  if (!supabase) throw new Error('[Supabase] Client not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  return supabase;
}

/** Helper — throws if supabaseAdmin is not configured */
export function requireSupabaseAdmin() {
  if (!supabaseAdmin) throw new Error('[Supabase] Admin client not configured. Check SUPABASE_SERVICE_ROLE_KEY.');
  return supabaseAdmin;
}
