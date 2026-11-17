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
   and cash payments must keep working offline and sync later. Design every write for this.
6. **Feature flags are data, not `if` spaghetti.** Every module is registered in the module
   registry (`packages/core/src/modules/registry.ts`) with its id, dependencies, default-on
   profiles, plan tier. UI and API both check `isEnabled(store, module, device?, role?)`.
7. **Multi-tenant from day one.** Every document carries `orgId` and `storeId`.
   One owner may run several stores of different profiles.
8. **i18n everywhere customer-facing** (menus, QR order pages, receipts, booking reminders).
   Staff UI: Thai + English first. Kitchen display: Thai.

## Proposed stack (confirm in docs/DECISIONS.md before changing)

- TypeScript monorepo (pnpm workspaces)
  - `apps/pos` — React + Vite PWA for iPad / Android tablet / phone (cashier, staff, KDS screens)
  - `apps/admin` — React back office + Head Office dashboard
  - `apps/guest` — lightweight web for QR ordering, booking, member pass
  - `packages/core` — domain types, module registry, pricing/tax/points logic (pure, fully unit-tested)
  - `functions/` — Firebase Cloud Functions (payments webhooks, points clearing, reports)
- Firebase: Firestore (offline persistence), Auth (owner email/LINE login, staff PIN), Hosting, Functions
- Tests: Vitest for `packages/core`, Playwright for critical POS flows
- Money: integer satang (THB × 100). Never floats.

## Working conventions

- Business logic goes in `packages/core`, never inside React components.
- Every new module: registry entry + Firestore rules + tests + entry in the toggle matrix doc.
- Small PRs per task in docs/PHASE1_TASKS.md; tick the box when merged.
- When a requirement is unclear, add a question to docs/DECISIONS.md under "Open questions"
  instead of guessing, and continue with the rest.
- Commands (update when scaffolded): `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm lint`.
