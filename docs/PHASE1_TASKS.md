# Phase 1 — MVP task list

Goal: Core + Restaurant and Cafe profiles, usable by 3–5 pilot shops on Koh Phangan.
Work top to bottom. One PR per task. Tick when merged.

## 0. Foundation  _(stack: Vercel + Supabase, see DECISIONS.md)_
- [x] Scaffold pnpm monorepo: apps/pos, apps/admin, apps/guest, packages/core, functions (+ packages/i18n, packages/ui, packages/supabase)
- [x] ~~Firebase project config~~ → Supabase project config (`supabase/config.toml`), Vercel config per app, environment variables documented (docs/ENVIRONMENT.md, `.env.example`)
- [x] Vercel project configured via API (root dir, env vars, previews off) and build dry-run locally
- [x] First green CI run on GitHub; first production deploy READY on Vercel (2026-11-17)
- [ ] Still to verify by hand: open `https://bestie-pos.vercel.app/` and `/api/health` (sandbox cannot reach the domain), `supabase start` locally
- [x] Lint, format, Vitest, CI on every PR (ESLint + repo-conventions script: no raw colours, no Thai literals in code, no public-prefixed secrets)
- [x] i18n setup (th, en) shared by all apps
- [x] Design tokens "Island Breeze" + contrast tests, default logo + favicon/PWA icons, `AsyncButton` spinner rule (docs/UX-DESIGN.md)

## 1. Core domain (packages/core, pure TS + tests)
- [x] Types: Org, Store, Device, Staff, Role, Profile, Module, MenuItem, Modifier, Order, Payment, Customer, PointsLedger
- [x] Money in satang; VAT (inclusive/exclusive), service charge, rounding per payment method
- [x] Module registry with dependencies, default profiles, plan tier; `isEnabled(store, module, device?, role?)`
- [x] Profile presets for Restaurant and Cafe
- [x] Points rules: earn from THB spend only, redeem as discount, no purchase/cash-out (enforced + tested)

## 2. Back office (apps/admin)
- [x] Database foundation applied to Supabase (orgs, stores, roles, staff, RLS, `create_org()` RPC) — UI for owner signup still to build
- [x] Owner signup → create org + store → pick profile; **add more shops** (`create_store`); invited staff join with a one-time code on the first screen
- [x] Billing & points settings (owner-selectable VAT / service charge / rounding / Points rule, live sample bill, audited)
- [x] Module toggle screen (store level) with dependency warnings (`/modules`: plan / legal locks, auto-enable, confirm before switching off dependents)
- [x] Menu editor (`/menu`): categories, items, add-on option groups with min/max, per-option prices, prices per channel, station, sold-out switch, Thai required / English optional, soft delete, audited, live-pinged. _(AI translation helper and item photos come later)_
- [x] Staff & roles: team list, role change, deactivate, one-time invite codes, PIN set (bcrypt) — `/staff`. _(PIN login on the tablet comes with §3 device login; custom-role editor later)_
- [x] Devices: register tablet, set role (cashier / staff / KDS + station), assign Revenue Dept POS ID, switch off — `/devices`

## 3. POS app (apps/pos, PWA, offline-first)
- [x] Device login + staff PIN: a tablet is bound to a registered device (`/devices` → "Use this tablet as this device"), "Who's working?" lock screen, PIN checked by the server or — with no signal — by a salted verifier kept on the tablet, auto-lock after 5 min idle, lock button. The acting person's role replaces the account's role on screen.
- [x] Restaurant: floor plan by zone (`/tables`), open a bill on a table, continue a busy table, **move table**, add/rename/remove tables (needs `menu.edit`, online). _(merge tables comes with split bill)_
- [x] Cafe: counter / takeaway orders from `/sell` with the same item grid; the order number (A001…) is the queue number. _(call screen = §4)_
- [x] Order entry with modifiers (min/max checked), notes, quantity, sold-out items, send to kitchen / bar (lines become history once sent; cancelling a sent line needs `order.void` + a reason, audited)
- [x] Split bill **by item and by seat** (any quantity, also part of a line that was already sent), **merge bills**, seats on lines — each bill is paid on its own with its own receipt. _(Split by amount / equal shares is part of split tender, next)_
- [ ] Payments UI: ~~cash with change~~ **done**, ~~Dynamic PromptPay QR~~ and ~~card reader (Stripe Terminal, server-driven)~~ **code done, needs a Stripe test-mode run** — (`Take payment`: due with cash rounding, quick amounts, change, works offline), Dynamic PromptPay QR (amount locked), gateway card (+ Stripe Terminal), Credit, Points, split tender — _next PRs_
- [x] PromptPay auto-confirm via Stripe webhook → bill auto-closes (signature-checked, amount / currency / bill re-checked, mismatches parked for review; PSP logged in DECISIONS.md). **Cannot be exercised from the build sandbox: run it once in Stripe test mode before pilots (docs/ENVIRONMENT.md).**
- [ ] Receipt printing: **on-screen receipt + browser print (80 mm) done** — seller, tax ID, branch, POS ID, number, VAT breakdown, cash / change, Thai or English chosen per receipt, list of today's receipts, reprint from any tablet. Still to do: ESC/POS over network / Bluetooth (needs the printer model from the hardware list)
- [x] Shift open/close with cash count (`/shift`): opening cash, what the shift took, expected cash computed from this device's own cash receipts and re-computed by the server, counted cash, variance (audited), history; optional "require an open shift before payment" per shop (Billing & points)
- [ ] Offline: full order flow works with network off; sync + conflict handling tested — **foundation done** (`@bestie/offline`: IndexedDB outbox with client uuids, ordered replay, retry/backoff, dead-letter, conflict rules per table, cached reads incl. the signed-in user's shop data); each order / payment screen below plugs into it

## 4. Kitchen & queue
- [x] KDS screen per station (`/kds`): tickets per bill with only that station's lines (a menu item's station is the routing rule; no station = never shown), oldest first, colour by waiting time (8 / 15 min), Ready / Undo, optional chime for new tickets, works offline (bumps are queued), live + 10 s refresh; a screen with no station shows everything that has one; waiter's **Ready to serve** list (`/ready`) with Served
- [x] Queue for the cafe: staff board (`/queue`: Preparing / Ready to collect, Handed over) and the customer-facing call screen (`/queue/display`: big numbers, full screen, chime when a number becomes ready); counter bills only

## 5. Guest QR ordering (apps/guest)
- [x] Table QR → menu in EN/TH → order → appears on POS/KDS: each table has a random QR token (`/tables` → table → **Ordering QR**: show, print, create a new code); the guest page `/t/<token>` (`packages/guest-ui`, mounted in apps/pos and apps/guest) needs no account; the database prices the order and checks options / availability / the `order.qr` module; guest lines wait on the bill as unsent lines (**Guest order** badge) or go straight to the kitchen when the shop switches on auto-send (Billing & points); retries never order twice; 12 orders per table per 10 min. The guest sees what is on the table and its kitchen state (refreshed every 10 s)
- [x] Pay at table via PromptPay QR: the guest page shows the bill total (computed by the server with the till's own billing code), starts a Stripe PromptPay QR through the same payment-attempt machinery, polls its status and shows "paid" + the online receipt number when the signed webhook closes the bill. The owner picks which device's A+ receipt series / POS ID guest payments use (Billing & points; off by default); lines still waiting for staff confirmation block payment; ordering is locked while a QR is waiting. **Needs a Stripe test-mode run (docs/ENVIRONMENT.md §6).**

## 6. Customers, Credit & Points
- [x] Manager override with a PIN (`Void with a manager PIN` on a sent line for people without `order.void`; online, one action per approval, approver recorded in the audit event)
- [x] Customer lookup by phone / member code / name (`/customers`, and **Add a customer to this bill** on the order screen): create a member, see the Bestie Points balance and history. _(A scanner that types the member code works today; a camera QR scanner is later.)_
- [ ] Tender framework: cash, PromptPay, gateway, Credit — **done**; **split tender done** (`Split` tab: N payers, equal shares or any amounts, each cash or Bestie Credit, one receipt, server-numbered `X+…`, online) — still to do: Points as a bill discount, PromptPay / card legs inside a split, per-store tender toggles screen
- [ ] Payment gateway adapter (card / e-wallets) behind an interface so providers can be swapped
- [ ] Bestie Credit ledger (double-entry, scoped to the issuing legal entity): **cash top-up, balance, history, manager correction, liability report per company, drawer count — done** (`tender.credit` module, off by default; append-only; no cash-out kind; no crypto funding). **spending Credit on a bill is done** (split tender). Still to do: PromptPay / card top-ups
- [ ] Bestie Points ledger: ~~earn on paid bill~~ **done** (append-only `points_ledger`, earned once per bill from baht spend only, manager corrections with a reason, audited), redeem as discount — **database part done** (`set_order_points`, reservation, receipt columns; tested), the till screen / bill / receipt / guest-bill code is _next_
- [ ] Module stub `credit.topup.crypto` (disabled; blocked unless org.legalSignOff.cryptoTopup) — build in Phase 3

## 7. Reports
- [x] Reports (`/reports`): daily sales, by item, by hour, payment mix, staff, by shop; one shop or all shops, date presets, CSV export (audited as `export.report`). Numbers come from one database function `sales_report()` (paid bills only, Bangkok business day), needs `report.view`.

## 8. Pilot readiness
- [x] Demo data: `seed_demo_menu(store)` (empty restaurant → 4 categories, 13 dishes, option groups, 10 tables; empty cafe → 3 categories, 10 items, milk / sweetness / shot options) with a **Load demo menu** button on `/menu`; needs `menu.edit`, never touches a shop that has a menu, audited
- [x] Onboarding checklist for pilot shops: docs/PILOT-CHECKLIST.md (hardware, accounts, billing, menu, staff and PINs, devices, POS ID, Stripe test, dry run, go-live)

## 9. UX shell, role home & branding  _(design: docs/UX-DESIGN.md)_
- [x] App shell: sidebar (desktop) / rail (tablet) / bottom bar + "More" sheet (phone), one nav list, safe-area, back links, Playwright 390×844 + 1280×800 + axe
- [x] Role home screens (cashier, waiter, kitchen, manager, owner, platform admin, guest) as illustrated cards, grey when module off
- [x] Card illustrations: 30 built-in SVGs in the Island Breeze palette; `RoleHome` already accepts per-card `imageUrls`
- [ ] Admin upload override per card (Storage bucket `card-images` + `home_card_images` table + admin screen)
- [x] Navigation feedback: progress bar + spinner on the tapped item while the next screen loads
- [x] Branding admin (BRANDING-KNOWLEDGE): upload logo/icon, rename app (TH/EN), `/brand/logo` + `/brand/favicon` + dynamic web manifest via `/api/brand`, tab title/icon follow the brand live, defaults = the designed logo/favicon
- [ ] Per-store 5-colour theme with contrast validation

## 10. Live sync  _(LIVE-SYNC-KNOWLEDGE)_
- [x] Supabase Realtime private channels + `live_ping` DB trigger helper + policy (`live_can_listen`) deciding who may listen (platform / org / store / audit / user / admin topics); applied to the hosted project
- [x] `useLiveSync` hook + `LiveSyncController`: refetch on ping (debounced), polling fallback with backoff, pause on hidden tab + catch-up, never refresh under typing / open dialog, catch-up after reconnect
- [x] Wired to: roles / modules / store settings of the signed-in user (all open screens of an org update by themselves), audit history
- [x] Wired to: floor plan, order list, order screen (tables / orders / lines ping `store:<id>`; the till pulls the shop's orders when nothing is waiting to be sent)
- [x] Wired to: KDS, pick-up list, queue board (store topic ping + fast refresh)
- [x] Guest "order ready" (§5): the guest page re-reads the table's bill every 10 s while visible (a guest has no account, so no Realtime channel)
- [x] Interplay with the offline outbox: sync indicator in the top bar (offline / syncing / N waiting / needs attention) driven by the local queue

## 11. Audit trail  _(AUDIT-TRAIL-KNOWLEDGE + admin switches, see KNOWLEDGE-MAPPING §A)_
- [x] `audit_log` (append-only, no PII) + `audit()` helper (never throws) + DB triggers on money/staff tables
- [x] Event registry (typed, TH/EN labels, grouped, `critical` flag)
- [x] Admin: master on/off + tick-list of event types (stores only what is *off*), settings change always audited
- [x] Admin: viewer, filters, CSV export (export itself audited)
- [ ] Test: any function that checks staff permission must import `audit` (no staff-permission functions exist yet — add when §2/§3 actions land)
- [ ] Retention / purge function (open question: how many years)

## 12. Authentication
- [x] Supabase Auth: owner e-mail sign-up / sign-in, shop onboarding (`create_org`), profiles + roles tables (role never comes from SSO), live role home from the DB
- [x] Staff PIN login with lockout (server: 5 wrong tries lock 15 min; tablet: same rule for the offline check)
- [ ] Google login — **code ready** (button appears automatically when Supabase has Google enabled); owner action: create a Google OAuth client and enable the provider in Supabase
- [ ] LINE login via Aivora SSO — **code ready and unit-tested** (`/sso/callback`, `/api/sso-exchange`, `aivora_links`, synthetic e-mail, direct bootstrap); needs `APP_SLUG` registered at the hub + a real ticket from the Launcher to test (cannot be simulated: single use, 60 s)
- [x] Change password (re-auth, sign out other devices); audit + LINE notice of the change arrive with §11 / §14

## 13. AI assistant  _(AI-PROVIDER-MODEL, AI-PROMPTS-RULES; roles in KNOWLEDGE-MAPPING §B)_
- [x] Provider/model registry with capabilities + per-task routes + fallback; admin page (`/ai` as platform admin) to choose provider and model per task, key status (never the key), Test button, recent fallback/error events; keys only in Vercel env; base URLs locked
- [x] Admin prompts & rules page (`/admin/ai/prompts`): append-only extra instructions, gate 1 code screener + gate 2 AI reviewer (fails closed), versioned insert-only history, shows the real prompt; safety/review tasks not editable
- [ ] Module `ai.assistant` wiring + Owner/Manager "Ask my shop" (read-only, numbers from SQL) and menu translation/description helper — needs real data (§2/§3/§7) and **an API key in Vercel** (`ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`) to test
- [ ] Usage + cost log per task (tokens are already returned by the adapters)

## 14. LINE notifications  _(LINE-ACCOUNT-LINKING, LINE-NOTIFICATIONS, LINE-FLEX-CARD)_
- [x] LINE OA webhook (signature over the raw body, 20-event cap, rate limit, always 200) + one-time-code account linking (only the HMAC stored, 30 min, one LINE account per user) + "Connect LINE" card on the account page (4 steps, polls every 4 s, test card, disconnect) — **needs the OA credentials in Vercel to go live**
- [x] Flex bubble builder in Bestie colours (title → ≤ 8 label/value lines → one "Open the app" button), rich `altText`, every field truncated, internal links only, TH/EN by recipient; `notifyLine` pushes with retry key and maps LINE errors
- [ ] `notify()` writer: in-app inbox + LINE **queue**, dedupe keys, monthly quota with reserve, cron tick + retry table, per-user opt-in — build with the first real notice
- [ ] First notices: PromptPay paid, order ready, low stock, shift variance, daily summary — need orders/payments (§3, §6)

## 15. AI for customers & Karaoke  _(design: docs/AI-CUSTOMER-ASSISTANT.md, docs/KARAOKE-AI.md — proposal, waiting for the owner)_
- [ ] Owner confirms the open questions in AI-CUSTOMER-ASSISTANT §7 (who pays for guest AI, therapist sign-off for spa rules, languages, hair photos)
- [ ] 5a: food tags on menu items (+ AI drafts, owner confirms), menu translation helper, guest menu advisor on `/t/<token>` (filter by SQL, AI ranks), "Ask my shop"
- [ ] 5b: concierge basics, feedback intake, hair-style advisor (after appointments), spa / yoga advisor (rules signed by a therapist and the lawyer first)
- [ ] 5c: karaoke profile + room timer, voice song search, **Bestie Song Bridge** (YouTube Lounge / Cast / HID / IR), standalone "Bestie Karaoke" web app, tours / rentals / resort concierge

## 16. Crypto top-up of Bestie Credit  _(spec: docs/modules/CRYPTO_TOPUP.md · knowledge: docs/CRYPTO_TRANSFER_KNOWLEDGE.md)_
- [x] Data model, rules and server: wallets (2-person change), KYC T1 / T2, payment requests with locked rate + unique amount + 15 min, chain watcher (TronGrid / Etherscan behind an interface), matching, confirmations, review queue, flags, blocklist, AML report, idempotent crediting into the Credit ledger (`funding = crypto`; still no cash-out). Off by default; needs the module, Credit and `legal_sign_off.cryptoTopup`.
- [ ] Screens: crypto top-up panel on the member page (KYC form, request with QR and 6+6 address, status), review queue + KYC approval + wallet setup + AML export (`/crypto`)
- [ ] Owner / lawyer actions: legal opinion uploaded and sign-off set; TronGrid / Etherscan keys; scheduler; **Shasta / Sepolia test run**; confirm tiers and limits; company wallet and printed address card

