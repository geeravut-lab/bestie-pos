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
- [ ] Owner signup → create org + store → pick profile → see enabled modules
- [ ] Module toggle screen (store level) with dependency warnings
- [ ] Menu editor: categories, items, modifiers (min/max), channel prices, Thai/English names
- [ ] Staff & roles, PIN codes
- [ ] Devices: register tablet, set role (cashier / staff / KDS), assign Revenue Dept POS ID

## 3. POS app (apps/pos, PWA, offline-first)
- [ ] Device login + staff PIN
- [ ] Restaurant: floor plan, open table, move/merge tables
- [ ] Cafe: product grid, queue number
- [ ] Order entry with modifiers, notes, send to kitchen
- [ ] Split bill (by item / amount / seat)
- [ ] Payments UI: cash with change, Dynamic PromptPay QR (amount locked), gateway card, Credit, Points, split tender
- [ ] PromptPay auto-confirm via PSP webhook → bill auto-closes (choose PSP; log in DECISIONS.md)
- [ ] Receipt printing (ESC/POS over network/Bluetooth) with POS ID; Thai/English receipt language
- [ ] Shift open/close with cash count
- [ ] Offline: full order flow works with network off; sync + conflict handling tested

## 4. Kitchen & queue
- [ ] KDS screen per station (kitchen / bar) with item routing rules
- [ ] Queue call screen for cafe

## 5. Guest QR ordering (apps/guest)
- [ ] Table QR → menu in EN/TH → order → appears on POS/KDS
- [ ] Pay at table via PromptPay QR

## 6. Customers, Credit & Points
- [ ] Customer lookup by phone / member QR
- [ ] Tender framework: cash, PromptPay, gateway, Credit, Points, split tender; per-store tender toggles
- [ ] Payment gateway adapter (card / e-wallets) behind an interface so providers can be swapped
- [ ] Bestie Credit ledger (double-entry, scoped to issuerEntityId): top-up by cash / PromptPay / gateway, spend, void, liability report
- [ ] Bestie Points ledger: earn on paid bill, redeem as discount (never purchasable)
- [ ] Module stub `credit.topup.crypto` (disabled; blocked unless org.legalSignOff.cryptoTopup) — build in Phase 3

## 7. Reports
- [ ] Daily sales, by item, by hour, payment mix, staff; export CSV

## 8. Pilot readiness
- [ ] Seed script with demo restaurant + cafe
- [ ] Onboarding checklist for pilot shops (hardware, printer, POS ID registration)

## 9. UX shell, role home & branding  _(design: docs/UX-DESIGN.md)_
- [x] App shell: sidebar (desktop) / rail (tablet) / bottom bar + "More" sheet (phone), one nav list, safe-area, back links, Playwright 390×844 + 1280×800 + axe
- [x] Role home screens (cashier, waiter, kitchen, manager, owner, platform admin, guest) as illustrated cards, grey when module off
- [x] Card illustrations: 30 built-in SVGs in the Island Breeze palette; `RoleHome` already accepts per-card `imageUrls`
- [ ] Admin upload override per card (Storage bucket `card-images` + `home_card_images` table + admin screen)
- [x] Navigation feedback: progress bar + spinner on the tapped item while the next screen loads
- [ ] Branding admin (BRANDING-KNOWLEDGE): upload logo/icon, rename app, `/brand/logo` + `/brand/favicon` functions, dynamic manifest + `<title>`, defaults = designed logo
- [ ] Per-store 5-colour theme with contrast validation

## 10. Live sync  _(LIVE-SYNC-KNOWLEDGE)_
- [x] Supabase Realtime private channels + `live_ping` DB trigger helper + policy (`live_can_listen`) deciding who may listen (platform / org / store / audit / user / admin topics); applied to the hosted project
- [x] `useLiveSync` hook + `LiveSyncController`: refetch on ping (debounced), polling fallback with backoff, pause on hidden tab + catch-up, never refresh under typing / open dialog, catch-up after reconnect
- [x] Wired to: roles / modules / store settings of the signed-in user (all open screens of an org update by themselves), audit history
- [ ] Wire to: floor plan, order list, KDS, queue screen, guest "order ready" — add a `live_ping_row` trigger on each table when those screens are built (§3, §4, §5)
- [ ] Interplay with the offline outbox (sync indicator: online/offline + queued writes) — with the offline task in §3

## 11. Audit trail  _(AUDIT-TRAIL-KNOWLEDGE + admin switches, see KNOWLEDGE-MAPPING §A)_
- [x] `audit_log` (append-only, no PII) + `audit()` helper (never throws) + DB triggers on money/staff tables
- [x] Event registry (typed, TH/EN labels, grouped, `critical` flag)
- [x] Admin: master on/off + tick-list of event types (stores only what is *off*), settings change always audited
- [x] Admin: viewer, filters, CSV export (export itself audited)
- [ ] Test: any function that checks staff permission must import `audit` (no staff-permission functions exist yet — add when §2/§3 actions land)
- [ ] Retention / purge function (open question: how many years)

## 12. Authentication
- [x] Supabase Auth: owner e-mail sign-up / sign-in, shop onboarding (`create_org`), profiles + roles tables (role never comes from SSO), live role home from the DB
- [ ] Staff PIN login with lockout (needs devices + per-staff PIN hash — with §2 Devices/Staff)
- [ ] Google login — **code ready** (button appears automatically when Supabase has Google enabled); owner action: create a Google OAuth client and enable the provider in Supabase
- [ ] LINE login via Aivora SSO — **code ready and unit-tested** (`/sso/callback`, `/api/sso-exchange`, `aivora_links`, synthetic e-mail, direct bootstrap); needs `APP_SLUG` registered at the hub + a real ticket from the Launcher to test (cannot be simulated: single use, 60 s)
- [x] Change password (re-auth, sign out other devices); audit + LINE notice of the change arrive with §11 / §14

## 13. AI assistant  _(AI-PROVIDER-MODEL, AI-PROMPTS-RULES; roles in KNOWLEDGE-MAPPING §B)_
- [ ] Provider/model registry with capabilities + per-task routes + fallback; admin page to choose provider and model per task; keys only in Vercel env
- [ ] Admin prompts & rules page: append-only extra instructions, two-gate screening, versioned history, shows the real prompt
- [ ] Module `ai.assistant` with store/role toggles; Owner/Manager "Ask my shop" (read-only, numbers from SQL), menu translation/description helper
- [ ] Usage + cost log per task

## 14. LINE notifications  _(LINE-ACCOUNT-LINKING, LINE-NOTIFICATIONS, LINE-FLEX-CARD)_
- [ ] LINE OA webhook + one-time-code account linking + status in account page
- [ ] `notify()` writer: in-app inbox + LINE queue, dedupe keys, quota with reserve, retry table, per-user opt-in
- [ ] Flex bubble builder in Bestie colours (title → ≤ 8 label/value lines → "Open app"), rich `altText`, TH/EN by recipient
- [ ] First notices: PromptPay paid, order ready, low stock, shift variance, daily summary

