# supabase/

Database, Auth, Storage and Realtime for Bestie POS.

- `config.toml` — local stack (`supabase start`). Hosted project: `https://pqomylchauwecpgqxoad.supabase.co`.
- `migrations/` — SQL migrations, applied in filename order. **Empty on purpose after the Foundation task**;
  the first migration arrives with Phase 1 task 1/2 (orgs, stores, profiles, `platform_settings`).

Rules every migration must follow (docs/CLAUDE.md rules 5–7, docs/KNOWLEDGE-MAPPING.md):

1. Every table has `org_id` and `store_id` (multi-tenant from day one) and **RLS enabled** with explicit policies.
2. Money columns are `bigint` satang. Never `numeric`/`float` for money.
3. Offline-first: client-generated `uuid` primary keys, `updated_at`, soft delete (`deleted_at`) so queued writes can sync later.
4. Code must tolerate a deploy that runs before its migration (catch `42703` / `PGRST204` / `23514`, degrade gracefully).
5. Never write `service_role` keys into this repo.
