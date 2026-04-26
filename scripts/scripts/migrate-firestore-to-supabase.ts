/**
 * Firestore → Supabase Full Data Migration
 *
 * Uses Firebase Admin SDK (bypasses Firestore security rules) + Supabase service_role key.
 *
 * Run: npx tsx scripts/migrate-firestore-to-supabase.ts
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ============================================================
// Initialize Firebase Admin (bypasses Firestore rules)
// ============================================================

const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'firebase-service.json'), 'utf-8')
);

const FIREBASE_DATABASE_ID = process.env.VITE_FIREBASE_DATABASE_ID || process.env.FIREBASE_FIRESTORE_DATABASE_ID || '(default)';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

const db = admin.firestore().database(FIREBASE_DATABASE_ID);
console.log(`✅ Firebase Admin initialized (project: ${serviceAccount.project_id}, database: ${FIREBASE_DATABASE_ID})`);

// ============================================================
// Initialize Supabase (service_role bypasses RLS)
// ============================================================

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log(`✅ Supabase client initialized (${supabaseUrl})`);

// ============================================================
// Collections to migrate
// ============================================================

const COLLECTIONS = ['companies', 'inquiries', 'claim_requests', 'crawl_schedules', 'ai_logs'];

// ============================================================
// Transform Firestore Timestamp → ISO string
// ============================================================

function transformDoc(docSnap: admin.firestore.DocumentSnapshot): Record<string, unknown> {
  const data = docSnap.data();
  if (!data) return { id: docSnap.id };

  const row: Record<string, unknown> = { id: docSnap.id };

  for (const [key, value] of Object.entries(data)) {
    if (value instanceof admin.firestore.Timestamp) {
      row[key] = value.toDate().toISOString();
    } else if (value && typeof value === 'object' && 'seconds' in value && 'nanoseconds' in value) {
      // Plain Firestore timestamp object
      row[key] = new Date((value as any).seconds * 1000).toISOString();
    } else {
      row[key] = value;
    }
  }

  return row;
}

// ============================================================
// Migrate a single collection
// ============================================================

async function migrateCollection(
  collectionName: string
): Promise<{ migrated: number; errors: number; totalCount: number }> {
  console.log(`\n📦 Migrating: ${collectionName}`);

  // Fetch all documents with pagination
  const allDocs: admin.firestore.DocumentSnapshot[] = [];
  let lastDoc: admin.firestore.DocumentSnapshot | null = null;

  while (true) {
    let query: admin.firestore.CollectionReference | admin.firestore.Query = db.collection(collectionName);
    query = query.orderBy('__name__').limit(500);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    allDocs.push(...snapshot.docs);
    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (snapshot.docs.length < 500) break;
  }

  console.log(`  Found ${allDocs.length} documents in Firestore`);

  if (allDocs.length === 0) {
    console.log('  ⏭️  Skipping (empty)');
    return { migrated: 0, errors: 0, totalCount: 0 };
  }

  // Transform to Supabase rows
  const rows = allDocs.map(transformDoc);

  // Upsert in batches of 100
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
        const sample = { ...batch[0] };
        for (const [k, v] of Object.entries(sample)) {
          if (typeof v === 'string' && v.length > 100) {
            (sample as any)[k] = v.substring(0, 100) + '...';
          }
        }
        console.error('  Sample row:', JSON.stringify(sample, null, 2));
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

  for (const col of COLLECTIONS) {
    const { count, error } = await supabase
      .from(col)
      .select('*', { count: 'exact', head: true });

    if (error && !error.message.includes('does not exist')) {
      console.log(`  ${col}: ❌ Error: ${error.message}`);
    } else {
      console.log(`  ${col}: ${count || 0} rows`);
    }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('🚀 Firestore → Supabase Full Migration\n');
  console.log(`Firebase Project: ${serviceAccount.project_id}`);
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
    console.log(
      `  ${r.collection}: ${r.totalCount} in Firestore → ${r.migrated} in Supabase, ${r.errors} errors`
    );
    totalMigrated += r.migrated;
    totalErrors += Math.max(0, r.errors);
    totalInFirestore += r.totalCount;
  }

  console.log(`\n  Total: ${totalInFirestore} → ${totalMigrated} migrated, ${totalErrors} errors`);
  console.log('='.repeat(60));

  if (totalMigrated > 0) {
    await validate();
    console.log('\n✅ Migration complete. Review data in your Supabase dashboard.');
  } else {
    console.log('\n⚠️  No data was migrated. Check Firestore collections exist.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
