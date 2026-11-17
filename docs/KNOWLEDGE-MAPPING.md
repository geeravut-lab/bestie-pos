# Knowledge files → Bestie POS features

Source: the RooSuk knowledge files in this folder (index: `Knowledge-Index.md`). RooSuk = Next.js + Supabase + Vercel; Bestie = Vite SPA + Supabase +
Vercel Functions, so we **keep the ideas, tables and rules, and translate the API names** (server actions → Vercel Functions / Supabase RPC,
`router.refresh()` → refetch, middleware → function guards). Bestie adds what RooSuk never had: multi-store tenancy (`org_id` + `store_id` on every row),
offline-first, money rules.

Status legend: ✅ built in Foundation PR · 📋 queued (task id in PHASE1_TASKS.md) · 🔮 later phase.

## Cross-cutting rules we adopt verbatim (Knowledge-Index §"กฎข้ามทุกเรื่อง")

1. An UPDATE that matches no row is "success" to PostgREST → every important write does `.select('id')` and counts rows.
2. Hiding a button is not disabling a feature → check on the server (function/RLS) every time.
3. Admin-settable values are never hard-coded twice in the UI.
4. Never record "passed" for something not yet checked (money, documents, identity) → a real "pending review" state exists in the DB.
5. Anything leaving the app (LINE, receipts) must answer who / what / when on its own.
6. Fallback default = keep working (flag unreadable → on; settings unreadable → code defaults; rule unreadable → run with old values). **POS exception:** money paths fail closed.
7. Migration and deploy are not simultaneous → tolerate missing columns (`42703` / `PGRST204` / `23514`).
8. Every user-visible error is a sentence in the user's language, never a code or stack.

## Mapping table

| # | Knowledge file | Becomes in Bestie POS | Where / who | Status |
|---|---|---|---|---|
| 1 | **I18N** | Typed TH/EN dictionary, `err_*` codes, receipts/menus/QR pages in the *customer's* language, LINE messages in the *recipient's* language | `packages/i18n` (all apps) | ✅ dict + provider + tests · 📋 receipt/guest language (tasks §3, §5) |
| 2 | **TYPOGRAPHY-COLOR** | Island Breeze tokens, contrast tests, 5-colour per-store theme | `packages/ui/theme.css`, store settings | ✅ tokens · 📋 per-store theme (§9) |
| 3 | **RESPONSIVE-WEB** | One shell: bottom bar (phone) / rail (tablet) / sidebar (desktop), safe-area, 44 px targets, 390×844 + 1280×800 Playwright + axe | `apps/*` shell | 📋 §9 |
| 4 | **NAVIGATION** | Single `nav` list → sidebar, bottom bar, "More" sheet, role home cards | `packages/ui` + `packages/core` nav registry | 📋 §9 |
| 5 | **BACK-BUTTON** | "Back to <parent>" link on every non-menu page; sheet reserves one history entry (matters: PWA on iPad has no Back) | shell | 📋 §9 |
| 6 | **FEATURE-FLAGS** | The **module registry** (CLAUDE rule 6): store → device → role toggles; flags stored as *disabled-only*; three-layer off (menu grey, page 404, function `assertModule`); admin page marks disabled ones orange | `packages/core/modules`, `platform_settings`, admin | 📋 §1 registry · §2 toggle screen |
| 7 | **BRANDING** | Admin uploads logo/icon/name; `/brand/logo`, `/brand/favicon`, dynamic manifest + `<title>`; name only in dictionary; defaults = our logo | admin → Storage bucket `brand-assets`; Vercel function serves | ✅ default assets + `LogoMark` hook · 📋 §9 upload |
| 8 | **LIVE-SYNC** | Supabase Realtime private channel "ping" (no payload) → refetch with the viewer's own RLS rights. Topics: `u:<user>`, `store:<store>`, `kds:<store>:<station>`, `org:<org>`, `admin`. Fallback polling fingerprint. Never refresh under a typing user / open payment dialog | KDS, floor plan, order status, queue screen, guest "order ready" | 📋 §10 |
| 9 | **AUDIT-TRAIL** | Append-only `audit_log` (who/what/which/store, no PII) written by functions *and* DB triggers on money tables. **Admin can switch auditing on/off and tick which event types are recorded** (design below). Money-critical events cannot be turned off (see below) | `/admin/audit` | 📋 §11 |
| 10 | **ADMINS** | Platform-admin = row in `admins`, grant/revoke by SQL function only, owner cannot be removed, admin pages 404 for others, `requireAdmin()` first line | admin app | 📋 §2 / §11 |
| 11 | **CHANGE-PASSWORD** | Owner/manager password change (re-auth, sign out other devices, audit + notify). Staff use PIN (separate flow, lockout after N tries) | account page | 📋 §12 |
| 12 | **USAGE-ANALYTICS** | First-party `product_events` (no GA/pixel), no content in events; feeds admin "which modules do pilot shops actually use" → pricing tiers | admin dashboard | 🔮 after pilot starts |
| 13 | **AUTOMATION-RULES** | Rules table = *whether to run + numbers*, conditions in typed code; one tick (Vercel Cron) → low-stock, unpaid-bill-open > N min, shift not closed, Credit liability threshold, daily summary → LINE | functions + admin "rules" | 🔮 Phase 1 end / 2 |
| 14 | **AI-PROVIDER-MODEL** | Admin picks provider + model per **task** with fallback, capability registry (images/pdf/audio), keys in Vercel env, cheap default (never the dearest model by default). **The model never decides money/tax/permissions — code does.** | `/admin/ai` | 📋 §13 |
| 15 | **AI-PROMPTS-RULES** | Admin can *append* instructions + rules per task (can't remove built-in rules), two-gate screening (code screener + AI reviewer, fail closed), versioned insert-only history, shows the real prompt | `/admin/prompts` | 📋 §13 |
| 16 | **LINE-ACCOUNT-LINKING** | Staff/owner/customer links LINE with a one-time 8-char code sent to the OA (works for tourists using any web login) | account → "Connect LINE" | 📋 §14 |
| 17 | **LINE-NOTIFICATIONS** | `notify()` single writer → in-app inbox + LINE queue, dedupe keys, own monthly quota with reserve, retry table (401/403 stops all + alerts admin, 400 = blocked, 429, 5xx), per-user opt-in | functions | 📋 §14 |
| 18 | **LINE-FLEX-CARD** | One Flex bubble per notice: title → ≤ 8 `label: value` lines → coral "Open app" button, rich `altText`, truncation limits, internal-path-only links, Bestie colours | functions | 📋 §14 |
| 19 | **SSO-Aivora-Supabase** | "Sign in with LINE (Aivora)" via hub ticket → `/api/sso-exchange` → Supabase session; link by `aivora_user_id` **never by email**; SSO gives identity, **never a role**; call bootstrap directly after `setSession` | login page, Vercel Function | 📋 §12 (needs `APP_SLUG`) |

## Feature designs that go beyond copying the file

### A. Audit trail with admin switches (task §11)

- `audit_settings` (one row per org): `enabled boolean`, `disabled_events text[]` (store the **unticked** ones, same "store only what's off" rule as flags so new events default to recorded).
- Event registry in code, grouped for the admin tick-list (each has a TH/EN label):
  `auth.*` (login, failed login, password change, PIN lockout) · `staff.*` (role/permission change) · `menu.*` (item/price change) ·
  `order.*` (void, discount, price override, reopen) · `payment.*` (tender, refund, split) · `credit.*` / `points.*` (top-up, spend, void, adjust) ·
  `shift.*` (open/close, cash variance) · `device.*` (register, POS ID change) · `module.*` (toggle) · `brand.*` · `ai.*` · `settings.*` · `export.*`.
- Admin screen `/admin/audit/settings`: master switch + a checkbox per event type (grouped, "tick all in group"), and a viewer/filter/CSV export (export is audited).
- **Guard rails (decision for owner, see "Questions")**: changing the audit settings is *always* recorded; events tagged `critical` (refund, void, Credit/Points ledger changes, role changes, audit-settings change) are written by DB triggers and **cannot** be unticked — switching them off would hide fraud and break tax/AML evidence. Ordinary events obey the switches.
- `audit()` never throws; no PII in `detail`; append-only (UPDATE/DELETE blocked by trigger); purge only by a logged function after the retention period.

### B. AI assistant — which roles, which jobs (task §13)

| Role | Needs an AI assistant? | Jobs (each = one admin-routable "task") |
|---|---|---|
| **Owner / Manager** | **Yes — highest value** | "Ask my shop": natural-language questions over reports (sales yesterday vs last Sunday, slow items, payment mix); daily/weekly summary text; menu description & price-idea drafts; stock reorder suggestions; explain a Credit/Points ledger line. Read-only on reports — numbers come from SQL, the model only words them. |
| **Menu/back-office staff** | Yes | Translate menu to EN/RU/HE/DE/ZH (PRODUCT_SPEC "AI menu translation"), write item descriptions, suggest modifiers/categories from a menu photo (later). |
| **Cashier / Waiter** | Light | Tiny "how do I…" help for POS flows; allergen/ingredient Q&A from the recipe data; **never** touches payment actions. Off by default per store. |
| **Kitchen (KDS)** | **No** | A KDS must be instant, offline-capable and unambiguous — no assistant. |
| **Customer (guest pages)** | Optional, later | Menu Q&A / recommendations in the guest's language, only from the published menu. |
| **Platform admin** | Yes | Configure providers/models/prompts; see usage & cost per task. |

Hard rules from the knowledge files: the model **reads and explains, code decides** (prices, VAT, points, Credit balances, permissions are computed in `packages/core`); every answer passes the code-side output checks; admin extra instructions can only *add* to built-in rules; the screening/safety tasks are not editable; provider keys only in Vercel env; usage logged per task for cost control; assistant is a module (`ai.assistant`) with store/role toggles.

### C. LINE linking + Flex cards for Bestie (task §14)

- Use **method A** (one-time code sent to the OA) — tourists and staff reach us through different web logins; no LIFF/LINE-Login channel needed for notifications.
- Notifications Bestie sends (each = Flex bubble): *PromptPay confirmed / bill closed*, *order ready (guest)*, *low stock*, *shift closed with cash variance*, *daily summary*, *booking reminder (Phase 2)*, *password changed*, *new device registered*.
- Flex bubble content in Bestie colours (teal header, ink text, coral button) from the dictionary of the **recipient**; links are internal paths only.

## Questions parked in DECISIONS.md (owner decides)

Which events are `critical` and un-tickable (above is a proposal) · retention period · AI default providers/cost owner · roles list for home cards · SSO `APP_SLUG`.
