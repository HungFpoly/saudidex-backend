# Firestore → Supabase Migration Runbook

This project uses the community tool:

- <https://github.com/supabase-community/firebase-to-supabase>

This runbook migrates the active Firestore collections used by Saudidex:

- `companies`
- `inquiries`
- `claim_requests`
- `crawl_schedules`
- `ai_logs`

## Quick answer: how to use the data migration tool

Use `firebase-to-supabase/firestore` in this order:

1. **Export** Firestore collection to JSON (`firestore2json.js`).
2. **Prepare** your SQL schema in Supabase first (run the migration SQL in this repo).
3. **(Optional) Transform field names** in JSON if Firestore names differ from SQL columns.
4. **Upload** JSON to Postgres (`json2supabase.js`).

Example for `companies`:

```bash
# 1) Export
node firestore2json.js companies 1000

# 2) (Optional) rename company_name -> name if your SQL schema expects `name`
jq 'map(if has("company_name") then . + {name: .company_name} | del(.company_name) else . end)' \
  companies.json > companies.mapped.json

# 3) Upload to Supabase (keep Firestore id as PK)
node json2supabase.js ./companies.mapped.json none
```

## 1) Clone and configure the migration tool

```bash
git clone https://github.com/supabase-community/firebase-to-supabase.git
cd firebase-to-supabase/firestore
```

Create credentials files expected by the tool:

- `firebase-service.json` (Firebase Admin service account key)
- `supabase-service.json` (database host/user/password/port/db)

`supabase-service.json` format:

```json
{
  "host": "db.<project-ref>.supabase.co",
  "password": "<your-db-password>",
  "user": "postgres",
  "database": "postgres",
  "port": 5432
}
```

## 2) Create the relational schema first

From your Saudidex repo root:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260413_001_firestore_baseline.sql
```

This creates target tables matching the Firestore collections and preserves nested fields with `jsonb` columns where needed.

## 3) Export Firestore collections to JSON

From `firebase-to-supabase/firestore`:

```bash
node collections.js
node firestore2json.js companies 1000
node firestore2json.js inquiries 1000
node firestore2json.js claim_requests 1000
node firestore2json.js crawl_schedules 1000
node firestore2json.js ai_logs 1000
```

## 4) Import JSON into Supabase Postgres

Use `none` PK strategy because this project keeps Firestore `id` as the primary key.

```bash
node json2supabase.js ./companies.json none
node json2supabase.js ./inquiries.json none
node json2supabase.js ./claim_requests.json none
node json2supabase.js ./crawl_schedules.json none
node json2supabase.js ./ai_logs.json none
```

## 5) Post-migration validation

Run quick row-count checks in Supabase:

```sql
select 'companies' as table, count(*) from public.companies
union all select 'inquiries', count(*) from public.inquiries
union all select 'claim_requests', count(*) from public.claim_requests
union all select 'crawl_schedules', count(*) from public.crawl_schedules
union all select 'ai_logs', count(*) from public.ai_logs;
```

## 6) Field mapping notes

See `scripts/migrations/firestore_to_supabase/collection-map.json` for collection/table mapping and PK strategy notes.

## 7) Automated migration script (alternative)

A Node.js migration script is available at `scripts/migrations/firestore_to_supabase/migrate.ts`.

**Prerequisites:**

1. Download Firebase Admin service account JSON:
   - Go to Firebase Console → Project Settings → Service Accounts
   - Click "Generate new private key"
   - Save as `scripts/migrations/firestore_to_supabase/firebase-service.json`

2. Create Supabase tables first (step 2 above)

3. Run:

```bash
npx tsx scripts/migrations/firestore_to_supabase/migrate.ts
```

This will:

- Connect to Firestore via Admin SDK (bypasses security rules)
- Read all documents with pagination
- Transform Firestore Timestamps → ISO strings
- Upsert into Supabase in batches of 100
- Validate row counts match

## 8) Firebase Storage

**Note:** This Firebase project does not have Cloud Storage enabled. The Storage bucket (`gen-lang-client-0148972742.firebasestorage.app`) does not exist. No file downloads are needed.

If you need file storage, enable Cloud Storage in Firebase Console first, then run:

```bash
npx tsx scripts/migrations/download-storage.ts
```

## 9) Field mapping notes

See `scripts/migrations/firestore_to_supabase/collection-map.json` for collection/table mapping and PK strategy notes.
