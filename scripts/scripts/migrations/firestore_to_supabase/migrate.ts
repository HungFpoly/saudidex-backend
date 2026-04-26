/**
 * Firestore → Supabase Migration Script
 *
 * Uses Firebase client SDK (already configured) + Supabase JS client.
 * No additional credentials needed — reads from .env.local
 *
 * Run with: npx tsx scripts/migrations/firestore_to_supabase/migrate.ts
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, orderBy, limit as limitFn, QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local from project root (this script is in scripts/migrations/)
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env.local') });

// ============================================================
// Configuration (from .env.local)
// ============================================================

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
// Service role key is preferred (bypasses RLS), but anon key works if RLS allows writes
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || '';

const COLLECTIONS = ['companies', 'inquiries', 'claim_requests', 'crawl_schedules', 'ai_logs'];

// ============================================================
// Initialize
// ============================================================

console.log('🔧 Initializing Firebase and Supabase...\n');

const app = initializeApp(firebaseConfig);

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in .env.local');
  console.error('Need: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Check which key we're using by decoding the JWT payload
function getJwtRole(key: string): string {
  try {
    const parts = key.split('.');
    if (parts.length >= 2) {
      const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
      const data = JSON.parse(payload);
      return data.role || 'unknown';
    }
  } catch { /* ignore */ }
  return 'unknown';
}

const keyRole = getJwtRole(supabaseKey);
console.log(`🔑 Using Supabase key role: ${keyRole}`);
if (keyRole === 'anon') {
  console.log('⚠️  Using anon key — may be limited by RLS policies');
  console.log('   For full access, set SUPABASE_SERVICE_ROLE_KEY in .env.local');
} else if (keyRole === 'service_role') {
  console.log('✅ Using service_role key — full access (bypasses RLS)');
}

// Initialize Firestore with the custom database ID
const firestoreDatabaseId = process.env.VITE_FIREBASE_DATABASE_ID || '(default)';
const db = getFirestore(app, firestoreDatabaseId);
console.log(`✅ Firestore initialized (database: ${firestoreDatabaseId})`);

// ============================================================
// Transform Firestore doc → Supabase row
// ============================================================

function transformDoc(docSnap: QueryDocumentSnapshot<DocumentData>): Record<string, unknown> {
  const data = docSnap.data();
  const row: Record<string, unknown> = { id: docSnap.id };

  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'toDate' in value) {
      // Firestore Timestamp → ISO string
      row[key] = (value as any).toDate().toISOString();
    } else {
      row[key] = value;
    }
  }

  return row;
}

// ============================================================
// Migrate a collection
// ============================================================

async function migrateCollection(collectionName: string): Promise<{ migrated: number; errors: number; totalCount: number }> {
  console.log(`\n📦 Migrating: ${collectionName}`);

  // Read ALL documents (paginate with limit)
  const allDocs: QueryDocumentSnapshot<DocumentData>[] = [];
  let lastDoc: QueryDocumentSnapshot<DocumentData> | undefined;

  while (true) {
    let q = query(collection(db, collectionName), orderBy('__name__'), limitFn(500));
    // Note: orderBy __name__ may not work on all collections, try without
    try {
      const snap = await getDocs(q);
      if (snap.empty) break;
      allDocs.push(...snap.docs);
      if (snap.docs.length < 500) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    } catch {
      // Fallback: simple query without ordering
      const snap = await getDocs(query(collection(db, collectionName), limitFn(500)));
      if (snap.empty) break;
      allDocs.push(...snap.docs);
      if (snap.docs.length < 500) break;
      break; // Can't paginate without lastDoc reference in simple query
    }
  }

  console.log(`  Found ${allDocs.length} documents in Firestore`);

  if (allDocs.length === 0) {
    console.log('  ⏭️  Skipping (empty collection)');
    return { migrated: 0, errors: 0, totalCount: 0 };
  }

  // Transform to Supabase rows
  const rows = allDocs.map(transformDoc);

  // Upsert into Supabase (batches of 100)
  let migrated = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);

    const { error } = await supabase
      .from(collectionName)
      .upsert(batch, { onConflict: 'id' });

    if (error) {
      console.error(`  ❌ Batch ${Math.floor(i / 100) + 1}: ${error.message}`);
      if (i === 0) {
        // Show sample row for debugging
        const sample = { ...batch[0] };
        // Truncate large fields for display
        for (const [k, v] of Object.entries(sample)) {
          if (typeof v === 'string' && v.length > 200) {
            sample[k] = v.substring(0, 200) + '...';
          }
        }
        console.error(`  Sample row:`, JSON.stringify(sample, null, 2));
      }
      errors += batch.length;
    } else {
      migrated += batch.length;
      console.log(`  ✅ Batch ${Math.floor(i / 100) + 1}: ${batch.length} rows upserted`);
    }
  }

  console.log(`  📊 ${migrated} migrated, ${errors} errors`);
  return { migrated, errors, totalCount: allDocs.length };
}

// ============================================================
// Validate
// ============================================================

async function validate(): Promise<void> {
  console.log('\n🔍 Validating Supabase row counts...\n');

  let allOk = true;

  for (const col of COLLECTIONS) {
    const { count, error } = await supabase
      .from(col)
      .select('*', { count: 'exact', head: true });

    if (error && !error.message.includes('does not exist') && !error.message.includes('relation')) {
      console.log(`  ${col}: ❌ Error: ${error.message}`);
      allOk = false;
    } else {
      const status = (count || 0) > 0 ? '✅' : '⏭️';
      console.log(`  ${col}: ${count || 0} rows ${status}`);
      if ((count || 0) === 0) allOk = false;
    }
  }

  console.log('');
  if (allOk) {
    console.log('🎉 All collections have data in Supabase!');
  } else {
    console.log('⚠️  Some collections may be empty. Check Supabase dashboard.');
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('🚀 Firestore → Supabase Migration\n');
  console.log(`Firebase Project: ${firebaseConfig.projectId}`);
  console.log(`Supabase URL: ${supabaseUrl}`);
  console.log(`Collections: ${COLLECTIONS.join(', ')}\n`);

  const results: Array<{ collection: string; migrated: number; errors: number; totalCount: number }> = [];

  for (const col of COLLECTIONS) {
    try {
      const result = await migrateCollection(col);
      results.push({ collection: col, ...result });
    } catch (err: any) {
      console.error(`❌ Failed to migrate ${col}:`, err.message);
      results.push({ collection: col, migrated: 0, errors: -1, totalCount: 0 });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 Migration Summary');
  console.log('='.repeat(60));

  let totalMigrated = 0;
  let totalErrors = 0;
  let totalInFirestore = 0;

  for (const r of results) {
    console.log(`  ${r.collection}: ${r.totalCount} in Firestore → ${r.migrated} in Supabase, ${r.errors} errors`);
    totalMigrated += r.migrated;
    totalErrors += Math.max(0, r.errors);
    totalInFirestore += r.totalCount;
  }

  console.log(`\n  Total: ${totalInFirestore} in Firestore → ${totalMigrated} migrated, ${totalErrors} errors`);
  console.log('='.repeat(60));

  // Validate
  if (totalErrors === 0 && totalMigrated > 0) {
    await validate();
  }

  console.log('\n✅ Migration complete.');
  if (totalMigrated > 0) {
    console.log('\nNext steps:');
    console.log('1. Review Supabase dashboard to verify data');
    console.log('2. Update app code to use Supabase client instead of Firebase');
    console.log('3. Switch DATA_LAYER to "supabase" in src/lib/dataLayer.ts');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
