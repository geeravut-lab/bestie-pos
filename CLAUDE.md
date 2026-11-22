# CLAUDE.md — Bestie POS

Multi-profile, cloud POS for small businesses on Koh Phangan, Thailand (and later anywhere):
restaurants, cafes, hair salons, massage/spa, resorts, retail, tours/rentals.
One codebase. Each store picks a **Business Profile** that pre-enables a set of modules,
and the owner can **toggle modules on/off** per store, per device, per staff role.

Full product spec: @docs/PRODUCT_SPEC.md
Current work plan: @docs/PHASE1_TASKS.md
Decisions log: @docs/DECISIONS.md

## Non-negotiable rules

1. **Every price, bill and ledger is in THB.** Tender types at checkout: Cash, PromptPay QR
   (auto-confirmed), Payment Gateway (card / e-wallets), **Bestie Credit**, **Bestie Points**, and
   split tender (any mix). Crypto is never a checkout tender.
2. **Bestie Credit ≠ Bestie Points. Keep them as two separate ledgers.**
   - **Credit** = prepaid stored value (THB 1:1) the customer tops up. It is a liability
     (deferred revenue) until spent. Top-up channels: cash, PromptPay, gateway, and optionally
     crypto (rule 3). Credit is usable **only at stores owned by the same legal entity**
     (`issuerEntityId`). Using it across different companies turns it into multi-merchant
     e-money, which needs a BOT licence or registration. Enforce this in code.
   - **Points** = rewards earned from THB spend only. Not purchasable, not cash-redeemable.
   - No cash-out of Credit funded by crypto (that would look like an unlicensed crypto exchange).
3. **Crypto top-up is a legally gated module (`credit.topup.crypto`), off by default.**
   - Preferred route needs no crypto handling at all: tourists convert via TouristDigiPay and
     top up with PromptPay.
   - The direct route (customer sends USDT/USDC to the company wallet) can be enabled only when
     the org record has `legalSignOff.cryptoTopup = true` (lawyer opinion uploaded). It requires
     payer KYC (passport), tx hash + chain stored, THB rate locked at confirmation from a
     reference source, per-customer limits, AML report export, stablecoins only.
   - Licensed Thai digital-asset operators may not facilitate crypto payments (SEC 5/2565);
     never integrate a Thai exchange API as a "crypto payment" provider.
4. **Thai tax compliance.** Receipts that act as abbreviated tax invoices must print the
   Revenue Department POS ID per device. Full tax invoices / e-Tax Invoice come later (Phase 4)
   but the data model must already hold customer tax ID, branch code, VAT breakdown.
5. **Offline-first.** Island internet and power are unreliable. Taking orders, sending to kitchen
   and cash payments must keep working offline and sync later. Design every write for this (client-generated UUIDs, outbox replay — see docs/DECISIONS.md "Proposed").
6. **Feature flags are data, not `if` spaghetti.** Every module is registered in the module
   registry (`packages/core/src/modules/registry.ts`) with its id, dependencies, default-on
   profiles, plan tier. UI and API both check `isEnabled(store, module, device?, role?)`.
7. **Multi-tenant from day one.** Every document carries `orgId` and `storeId`.
   One owner may run several stores of different profiles.
8. **i18n everywhere customer-facing** (menus, QR order pages, receipts, booking reminders).
   Staff UI: Thai + English first. Kitchen display: Thai.

## Stack (confirmed 2026-11-17 — see docs/DECISIONS.md)

- Hosting: **Vercel** (static apps + Vercel Functions) · Source: GitHub `geeravut-lab/bestie-pos`
- Backend: **Supabase** — Auth (email, Google, Aivora/LINE SSO, staff PIN), Postgres + RLS, Storage, Realtime.
  Project `https://pqomylchauwecpgqxoad.supabase.co`. Production URL `https://bestie-pos.vercel.app/`.
- TypeScript monorepo (pnpm workspaces)
  - `apps/pos` — React + Vite PWA for iPad / Android tablet / phone (cashier, staff, KDS screens) — main Vercel project
  - `apps/admin` — React back office + Head Office dashboard
  - `apps/guest` — lightweight web for QR ordering, booking, member pass
  - `packages/core` — domain types, module registry, pricing/tax/points logic (pure, fully unit-tested)
  - `packages/i18n` — the single typed Thai/English dictionary + provider
  - `packages/ui` — design tokens (`theme.css`), base CSS, Logo, Spinner, `AsyncButton`, `LangSwitch`
  - `packages/supabase` — browser client + public-env guard (never the service_role key)
  - `functions/` — server-only logic (health, payment webhooks, points clearing, reports, SSO exchange) mounted as Vercel Functions in `apps/*/api`
- Tests: Vitest (unit, jsdom for components), Playwright for critical POS flows (arrives with the first POS screen)
- Money: integer satang (THB × 100). Never floats.

## Owner standing rules (from the owner — follow every time)

1. **Spinner on every action.** Any button, menu item or submit that triggers work must show a loading
   spinner immediately, stay un-double-clickable, and clear it only when the work is finished (success or
   failure). Use `<AsyncButton>` / `useAsyncAction` from `@bestie/ui`; never wire a bare `onClick` to async work.
2. **Next steps after every prompt — and say clearly what the owner must ORDER.** When a prompt is finished,
   list the remaining steps of the current phase (and the next phase) from docs/PHASE1_TASKS.md, but always
   split the closing report into these three blocks, in this order, in Thai, so the owner never has to guess:
   - **🟢 สั่งได้เลย (ผมทำต่อได้ทันที)** — work Claude can do now with no input. List as a numbered menu with a
     recommended order, and say the exact words the owner can reply with (e.g. "สั่ง: ข้อ 1").
   - **🟡 ต้องรอเจ้าของตัดสินใจ/ลงมือเอง ก่อนผมทำต่อได้** — each item names WHO must act (owner / lawyer /
     accountant / a pilot shop), WHAT exactly, and which work is blocked until then. If it needs the owner's
     answer, phrase it as a question with options and a recommendation.
   - **⚪ แจ้งให้ทราบเฉย ๆ (ไม่ต้องสั่งอะไร)** — facts, risks and things not verified from the sandbox. Nothing here
     needs a reply; never mix these into the other two blocks.
   Finish with ONE line telling the owner when they need to speak next ("ต้องตอบก็ต่อเมื่อ …" or "ไม่ต้องตอบ
   ผมทำข้อ 1 ต่อให้เอง"). Never list the same item under two blocks.
3. **Reply to the owner in Thai** (code, identifiers and commit messages in English).
4. **Reuse the knowledge files.** `docs/Knowledge-Index.md` indexes the RooSuk-derived knowledge files
   (branding, live sync, audit trail, AI provider/prompts, LINE linking/flex cards, i18n, typography, responsive,
   navigation, feature flags, …). Read the relevant file before building the matching feature; the mapping of
   each file to Bestie POS features is in docs/KNOWLEDGE-MAPPING.md. Their stack is Next.js — adapt the
   ideas, not the API names. Their global rules (docs/Knowledge-Index.md bottom) apply here too.
5. **Admin-controllable things are data, not code constants**: branding, feature flags, audit event types,
   AI provider/model/prompts, notification settings.
6. **Build everything in the plan now; legal sign-off gates launch, not building** (owner order 2026-11-21). Every function and
   feature in the plan (all phases) may be built and demonstrated without waiting for the lawyer, accountant or a pilot shop,
   because the owner shows the working system to them BEFORE go-live. Built things that need a legal opinion keep their code gates
   (module switched off by default, `legalSignOff` flags, consent ticks) and are listed in the closing report under "must be confirmed
   before go-live" — never as a reason not to build. This does not relax the safety rules above (never fake payments, no crypto
   checkout tender, Credit single-entity, secrets never in git).

## Working conventions

- Business logic goes in `packages/core`, never inside React components.
- Every new module: registry entry + Supabase RLS policies + tests + entry in the toggle matrix doc.
- Small PRs per task in docs/PHASE1_TASKS.md; tick the box when merged.
- When a requirement is unclear, add a question to docs/DECISIONS.md under "Open questions"
  instead of guessing, and continue with the rest.
- Commands: `pnpm install` · `pnpm dev` (all apps) / `pnpm dev:pos` · `pnpm test` · `pnpm lint`
  (ESLint + `scripts/check-conventions.mjs`) · `pnpm typecheck` · `pnpm build` · `pnpm format` ·
  `pnpm check` (everything CI runs) · `pnpm brand:build` (re-rasterise default logo/favicons).
- Colours: only in `packages/ui/src/theme.css`, everywhere else `var(--bp-*)`. Bright fills (`brand`,
  `accent`, `sun`) carry **ink** text only — never white. Contrast is unit-tested.
- Guide PDFs live in `docs/` and are named for their reader: `CUSTOMER-GUIDE.pdf`, `CUSTOMER-QUICK-GUIDES.pdf` (never `QUICK-GUIDES.pdf`), `STAFF-GUIDE.pdf`, `STAFF-QUICK-GUIDES.pdf`, `E2E-TEST-GUIDE.pdf`, `TEST-ACCOUNTS.pdf`.
- Strings: every user-facing string (incl. `aria-label`, `alt`, `placeholder`) lives in
  `packages/i18n/src/dict.ts`. Thai literals elsewhere in `.ts/.tsx` fail lint.
- Secrets: never in git, never with a `VITE_`/`NEXT_PUBLIC_`/`PUBLIC_` prefix. See docs/ENVIRONMENT.md.
- Asset paths are absolute (`/…`), `base: '/'` — nested routes like `/sso/callback` must not break assets.
