/**
 * Firebase compatibility shim — re-exports Supabase equivalents.
 *
 * This file exists so that legacy imports like:
 *   import { db, auth } from '@/lib/firebase';
 * continue to work during the migration.
 *
 * New code should import directly from:
 *   import { supabase } from '@/lib/supabase';
 *   import { useAuth } from '@/contexts/AuthContext';
 */
import { supabase } from './supabase';
import { supabase as supabaseClient } from './supabase';

// Export supabase client as `db` for legacy Firestore-style imports
export { supabaseClient as db };

// Export auth-compatible from Supabase
export const auth = {
  /** Supabase auth instance wrapper mimicking firebase/auth's auth */
  currentUser: null as any,

  /** Listen to auth state changes */
  onAuthStateChanged: (callback: (user: any) => void) => {
    if (!supabase) {
      callback(null);
      return () => { };
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      callback(session?.user ?? null);
    });

    // Subscribe to future changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      callback(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  },
};

// Re-export User type compatibility
export type FirebaseUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
};

// Note: onAuthStateChanged is now provided via the `auth` object above
// Legacy code using `import { onAuthStateChanged } from '@/lib/firebase'`
// should instead use the auth.onAuthStateChanged method or AuthContext.
