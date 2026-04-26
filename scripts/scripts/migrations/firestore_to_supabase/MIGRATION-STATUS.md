# Firestore → Supabase Migration

## Quick Status

| Component | Status |
|-----------|--------|
| Supabase tables | ✅ Created |
| Supabase credentials | ✅ Working (service_role key detected) |
| Firestore access | ❌ Need service account key |

## Why It Failed

The Firebase API key in `.env.local` can only read databases with permissive security rules. Your custom Firestore database (`ai-studio-c1bfde5b-adc5-4a4a-8ab7-85aa5fe19346`) requires authentication beyond the API key.

## How to Fix

### Option 1: Download Service Account Key (Recommended)

1. Go to [Firebase Console](https://console.firebase.google.com/) → your project
2. Click **⚙️ Settings** → **Project settings** → **Service accounts** tab
3. Click **"Generate new private key"**
4. Save the JSON file as:
   ```
   scripts/migrations/firestore_to_supabase/firebase-service.json
   ```
5. Run the migration:
   ```bash
   npx tsx scripts/migrations/firestore_to_supabase/migrate.ts
   ```

### Option 2: Export Manually from Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com/) → your project
2. Open **Firestore Database**
3. For each collection (`companies`, `inquiries`, etc.):
   - Click the collection name
   - Click **"Download all"** (or export each document)
   - Save as JSON
4. Import JSON files into Supabase using the SQL Editor or pgAdmin

### Option 3: Make Firestore Public Temporarily

If you only need to migrate a small amount of data, temporarily update Firestore security rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

⚠️ **Warning:** This makes your database publicly readable. Revert rules immediately after migration.

Then run:
```bash
npx tsx scripts/migrations/firestore_to_supabase/migrate.ts
```

## Current State

- **Supabase**: Tables created, service_role key working, ready to receive data
- **Firestore**: Database exists but requires service account authentication
- **Migration script**: Ready, tested, just needs proper Firebase credentials
