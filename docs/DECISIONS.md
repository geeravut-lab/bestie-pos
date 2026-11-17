# Decisions log

## Decided
- 2026-11-18 — Settle in THB only; no crypto payment features (Thai SEC/BOT rules). Tourists with crypto use TouristDigiPay → PromptPay.
- 2026-11-18 — Loyalty points earned from THB spend only; not purchasable; not cash-redeemable.
- 2026-11-18 — Architecture: Core + Business Profile + per-store/device/role feature toggles.
- 2026-11-18 — Roadmap: Phase 1 = Restaurant + Cafe MVP.
- 2026-11-18 — Product name: "Bestie POS". Still to check: trademark (DIP), domain, app store names.

- 2026-11-18 — Bestie POS runs only in stores of the owner's own company (single legal entity).
- 2026-11-18 — Tenders: Cash, PromptPay QR, Payment Gateway, Bestie Credit (prepaid), Bestie Points (rewards), split tender.
- 2026-11-18 — Customers can buy Bestie Credit with cash or crypto. Crypto route = TouristDigiPay (preferred) or direct stablecoin top-up behind a legal sign-off flag.

- 2026-11-17 — **Stack confirmed by the owner: Vercel (hosting + Functions) + Supabase (Auth + Postgres + Storage + Realtime) + GitHub `geeravut-lab/bestie-pos`.** This replaces the Firebase proposal. Supabase project: `https://pqomylchauwecpgqxoad.supabase.co`. Production URL: `https://bestie-pos.vercel.app/`.
- 2026-11-17 — Monorepo = pnpm workspaces: `apps/pos`, `apps/admin`, `apps/guest` (React 19 + Vite PWAs), `packages/{core,i18n,ui,supabase}`, `functions/` (server-only logic mounted as Vercel Functions under `apps/*/api`). TypeScript 6.0.x (typescript-eslint does not support 7.x yet). Vitest for unit tests; Playwright arrives with the first critical POS flow.
- 2026-11-17 — Styling = plain CSS design tokens (`packages/ui/src/theme.css`, the only file allowed to hold colour values; enforced by `scripts/check-conventions.mjs`). Tailwind is **not** adopted yet.
- 2026-11-17 — i18n = single typed dictionary (`packages/i18n/src/dict.ts`), Thai is the source, English must `satisfies` it; servers return `err_*` codes (see docs/I18N-KNOWLEDGE.md). Thai literals in `.ts/.tsx` outside the dictionary fail lint.
- 2026-11-17 — Brand "Island Breeze": teal sea + sun yellow + coral on airy mint backgrounds, font Nunito + Noto Sans Thai, logo = speech-bubble "B" with a sun dot. Rationale: docs/UX-DESIGN.md. Admin-uploadable brand overrides these defaults (task list §9).
- 2026-11-17 — Owner standing rules recorded in CLAUDE.md: (1) every button/menu that does work shows a loading spinner until it finishes and cannot be double-submitted; (2) after every finished prompt, list the remaining steps of the current/next phase so the owner can choose what to run next.
- 2026-11-17 — Server secrets (`SUPABASE_SERVICE_ROLE_KEY`, LINE and AI provider keys) live only in Vercel environment variables, never in git and never with a `VITE_`/`NEXT_PUBLIC_`/`PUBLIC_` prefix (lint-enforced).

## Proposed (confirm)
- Offline-first on Supabase (Firestore's built-in offline cache is gone): IndexedDB (Dexie) local store + an outbox of client-generated-UUID writes replayed to Supabase with per-entity conflict rules. Needed before task "Offline: full order flow works with network off".
- Live sync = Supabase Realtime "ping" topics + refetch, per docs/LIVE-SYNC-KNOWLEDGE.md (adapted from Next.js `router.refresh()` to React Query/refetch).
- Vercel layout: ONE Vercel project rooted at `apps/pos` serves `bestie-pos.vercel.app` (login, role home, POS, SSO callback). `apps/admin` and `apps/guest` get their own Vercel projects/URLs later (or are folded in as routes) — see Open questions.

## Open questions
- LEGAL (before launch of Credit): does single-entity prepaid credit need BOT notification/registration under the Payment Systems Act 2017? Are all shops truly one legal entity?
- LEGAL (before enabling direct crypto top-up): AML duties, tax treatment of crypto received, refund policy, wording allowed in marketing.
- Payment gateway choice (card + e-wallets) and its PromptPay auto-confirm webhook.
- Which PSP / bank API confirms PromptPay payments automatically?
- Card payments: which acquirer / terminal for Phase 1?
- Pricing per plan tier (Basic / Pro / Resort) in THB.
- Hardware list for pilot shops (tablet models, printers).
- Pilot shops: names, profiles, languages their guests need.
- INFRA: Supabase **anon key** is needed for `VITE_SUPABASE_ANON_KEY` (public, Dashboard → Project Settings → API). **service_role key** goes only into Vercel env `SUPABASE_SERVICE_ROLE_KEY`.
- INFRA: Vercel project mapping — which URLs for `apps/admin` and `apps/guest`? (separate Vercel projects vs. routes inside one app). Default assumption: `apps/pos` = bestie-pos.vercel.app, others later.
- SSO (docs/SSO-Aivora-Supabase.md): the doc's constants are the *e-voa* example (`HUB_URL`, `APP_SLUG`, `CALLBACK`, a different Supabase URL). For Bestie we need the real `APP_SLUG` registered at the Aivora hub (callback = `https://bestie-pos.vercel.app/sso/callback`). Also: should an Aivora/LINE user become owner, staff, or customer on first login? (SSO gives identity only, never a role.)
- Google login: OAuth client ID/secret to be created in Google Cloud and pasted into Supabase Auth → Providers (never into git).
- LINE: need LINE Official Account + Messaging API channel (webhook URL, channel secret/token) for notifications/linking; decide LINE Login (SSO via Aivora) vs. OA one-time-code linking for notifications (knowledge file recommends one-time code).
- AI assistant: which providers/models to enable by default and who pays for usage (platform key vs. each org's own key)?
- Landing/role home: confirm the list of roles (owner, manager, cashier, waiter/staff, kitchen/KDS, guest) and which cards each sees by default.
- Audit trail: confirm retention period (the knowledge file uses 4 years; Thai accounting-record retention is commonly cited as 5 years — verify with the accountant/lawyer before fixing the number).

