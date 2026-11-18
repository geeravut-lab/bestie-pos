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
  - `20261118002504_line_linking.sql` — `notification_channels` (server-only; one active LINE account per user) and `message_log`.
  - `20261118002917_lock_function_privileges.sql` + `…2950_auth_admin_trigger_grant.sql` — security fix found by the Supabase advisor: internal SECURITY DEFINER functions were callable by `anon`; now locked, and **new functions get no grants by default**.
  - `20261118023656_billing_options.sql` — `stores.bill_options`, `orgs.points_rule` with shape guards; billing/points changes audited as `settings.change`.
  - `20261118035444_back_office.sql` — `create_store()`, module-override guard (known ids, booleans, crypto only with the legal sign-off), `staff_invites` (hash only, 7 days, single use) + `create/accept/revoke_staff_invite`, `staff_pins` (bcrypt, 5 wrong tries lock 15 min) + `set_staff_pin` / `verify_staff_pin`, `devices` (role, KDS station, Revenue Dept POS ID; audited, live-pinged).
  - `20261118054428_card_payments.sql` — online payments: `payment_attempts`, `begin / cancel_payment_attempt` (the till asks), server-only `attach_payment_intent`, `fail_payment_attempt`, `record_stripe_event`, `confirm_payment_attempt` (the provider's signed webhook closes the bill, or parks it as `needs_review` when amount / currency / bill do not match); the shared closing code `finalize_order_payment`; receipts of server-confirmed payments use their own consecutive `A+000001` series per device; `devices.stripe_reader_id`.
  - `20261118052533_payments.sql` — `receipts` (full seller / tax / POS ID snapshot, frozen history), `payments`, and `close_order()`: the only way to close a bill; checks permission, receipt series of the device, lines vs totals, cash amounts; replaying the same close is a no-op. Only cash from the till — PromptPay / card / Credit / Points are confirmed by the server.
  - `20261118051055_orders.sql` — `dining_tables`, `orders`, `order_lines` (+ a short code per device for order numbers A001…): lines are frozen once sent, voiding a sent line needs `order.void` (audited), an order is closed only by the payment function, per-shop uniqueness of numbers, live pings.
  - `20261118045446_device_lock.sql` — `staff_with_pin(org)`: which active people have a PIN (for the till's lock screen); the PIN table stays unreadable.
  - `20261118041518_menu.sql` — `menu_categories`, `menu_items`, `modifier_groups`, `modifier_options`: shape-guarded names / prices (satang, per channel), same-shop checks, soft delete, `menu.edit` to write, price & item changes audited, live pings.
- `tests/` — `local_stub.sql` (Supabase look-alike roles + `auth` schema) and `*.test.sql` (RLS / guard assertions).
  Run `pnpm test:db` (needs PostgreSQL 14+ binaries; CI runs it too). The same assertions were dry-run inside a rolled-back
  transaction on the hosted project before applying.

Rules every migration must follow (docs/CLAUDE.md rules 5–7, docs/KNOWLEDGE-MAPPING.md):

1. Every table has `org_id` and `store_id` (multi-tenant from day one) and **RLS enabled** with explicit policies.
2. Money columns are `bigint` satang. Never `numeric`/`float` for money.
3. Offline-first: client-generated `uuid` primary keys, `updated_at`, soft delete (`deleted_at`) so queued writes can sync later.
4. Code must tolerate a deploy that runs before its migration (catch `42703` / `PGRST204` / `23514`, degrade gracefully).
5. Never write `service_role` keys into this repo.
6. **Functions have no default grants** (migration 8): every new function must `grant execute … to authenticated` (RLS helpers / RPCs) or `service_role` (internal) explicitly. Run the Supabase security advisor after each migration (`GET /v1/projects/<ref>/advisors/security`).

How a migration reaches the hosted project (done by Claude through the Management API with the owner's token, or `supabase db push`):
1. write it, add RLS + tests, `pnpm test:db` locally; 2. dry-run on the hosted project inside `begin; … rollback;`;
3. apply via `POST /v1/projects/<ref>/database/migrations` (records history) and rename the file to the returned version;
4. never edit an applied migration — add a new one. New tables must `revoke all … from anon, authenticated` and grant only what is needed.

Every new table that a screen shows live needs: `create trigger … after insert or update or delete … execute function public.live_ping_row('store:{store_id}')` (and, if it should be heard org-wide, `'org:{org_id}'`).
