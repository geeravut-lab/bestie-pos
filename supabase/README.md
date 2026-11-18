# supabase/

Database, Auth, Storage and Realtime for Bestie POS.

- `config.toml` — local stack (`supabase start`). Hosted project: `https://pqomylchauwecpgqxoad.supabase.co`.
- `migrations/` — SQL migrations, applied in filename order. Applied to the hosted project so far:
  - `20261117233030_foundation.sql` — profiles (+ auto-create on signup), orgs, legal_entities, stores, roles, staff,
    platform_admins, platform_settings, RLS helper functions, `create_org()` onboarding RPC, guards (last owner,
    no self-promotion, legal sign-off server-only).
  - `20261117234934_aivora_links.sql` — `aivora_links` (hub user id ↔ Supabase user), server-only.
  - `20261117235800_audit_trail.sql` — append-only `audit_log`, event catalogue, per-org switches (`set_audit_settings`), `write_audit` RPC, DB triggers on staff / orgs / stores.
  - `20261118000210_live_sync.sql` — content-free Realtime pings from DB triggers + `live_can_listen` policy on `realtime.messages`.
  - `20261118001123_branding.sql` — private `brand-assets` bucket (platform-admin-only policies, no SVG), brand JSON shape guard.
  - `20261118001756_ai_settings.sql` — `ai_settings`, insert-only `ai_prompt_versions`, server-written `ai_events` (platform-admin policies).
- `tests/` — `local_stub.sql` (Supabase look-alike roles + `auth` schema) and `*.test.sql` (RLS / guard assertions).
  Run `pnpm test:db` (needs PostgreSQL 14+ binaries; CI runs it too). The same assertions were dry-run inside a rolled-back
  transaction on the hosted project before applying.

Rules every migration must follow (docs/CLAUDE.md rules 5–7, docs/KNOWLEDGE-MAPPING.md):

1. Every table has `org_id` and `store_id` (multi-tenant from day one) and **RLS enabled** with explicit policies.
2. Money columns are `bigint` satang. Never `numeric`/`float` for money.
3. Offline-first: client-generated `uuid` primary keys, `updated_at`, soft delete (`deleted_at`) so queued writes can sync later.
4. Code must tolerate a deploy that runs before its migration (catch `42703` / `PGRST204` / `23514`, degrade gracefully).
5. Never write `service_role` keys into this repo.

How a migration reaches the hosted project (done by Claude through the Management API with the owner's token, or `supabase db push`):
1. write it, add RLS + tests, `pnpm test:db` locally; 2. dry-run on the hosted project inside `begin; … rollback;`;
3. apply via `POST /v1/projects/<ref>/database/migrations` (records history) and rename the file to the returned version;
4. never edit an applied migration — add a new one. New tables must `revoke all … from anon, authenticated` and grant only what is needed.

Every new table that a screen shows live needs: `create trigger … after insert or update or delete … execute function public.live_ping_row('store:{store_id}')` (and, if it should be heard org-wide, `'org:{org_id}'`).
