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

## Proposed (confirm)
- Stack: TypeScript monorepo, React + Vite PWA, Firebase (Firestore offline, Auth, Functions, Hosting).

## Open questions
- LEGAL (before launch of Credit): does single-entity prepaid credit need BOT notification/registration under the Payment Systems Act 2017? Are all shops truly one legal entity?
- LEGAL (before enabling direct crypto top-up): AML duties, tax treatment of crypto received, refund policy, wording allowed in marketing.
- Payment gateway choice (card + e-wallets) and its PromptPay auto-confirm webhook.
- Which PSP / bank API confirms PromptPay payments automatically?
- Card payments: which acquirer / terminal for Phase 1?
- Pricing per plan tier (Basic / Pro / Resort) in THB.
- Hardware list for pilot shops (tablet models, printers).
- Pilot shops: names, profiles, languages their guests need.
