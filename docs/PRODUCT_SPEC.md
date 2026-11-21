# Product Spec — Bestie POS

Last updated: 2026-11-18. Source: research session on Thai crypto payment rules and POS
benchmarking (FoodStory/Wongnai POS, StoreHub, Square, Toast, Lightspeed, Fresha,
Cloudbeds/Mews, Papaya).

## 1. Vision

One POS for every kind of shop on Koh Phangan. A shared Core, a Business Profile chosen at
signup, and per-store feature toggles. Shops in the network share customers and loyalty
points, so a tourist earns at a cafe and redeems at a spa.

Differentiators vs competitors:
- Mix modules across profiles (Square forces one mode per device: a bakery-cafe must switch modes).
- Coalition loyalty across independent shops (FoodStory/StoreHub only do in-store / same-brand).
- Tourist-ready: multilingual guest pages, multi-currency price display, PromptPay with
  auto-confirmation (works with TouristDigiPay), offline-first.
- Thai tax ready: POS ID on receipts, e-Tax Invoice later.

## 2. Legal / payment constraints (summary)

- Thai SEC + BOT ban using digital assets (incl. stablecoins) to pay for goods/services and ban
  building tools/wallets that facilitate it (effective 1 Apr 2022).
- TouristDigiPay (18-month sandbox, launched Aug 2025): foreign tourists convert crypto to THB via
  SEC-licensed operators into a BOT-regulated e-money wallet, then pay merchants by Thai QR.
  Limits: 500,000 THB/month, 100,000 THB/transaction. Merchants receive THB normally.
- SEC draft (12 Nov 2026): stablecoin deposit/withdraw cap 5M THB/day/customer per operator and a
  same-owner wallet rule. Irrelevant to the POS as long as we never touch crypto.
- The SEC ban (Notification 5/2565) binds licensed digital asset business operators. A merchant
  accepting crypto directly under a private contract is legally permissible but discouraged by
  the BOT and carries AML obligations (source: AustCham Thailand). Treat direct crypto top-up as
  a legal-gated, off-by-default module.
- Prepaid stored value: under the older e-payment rules, e-money usable only with a single seller
  was the lightest category (notify only); multi-merchant e-money needs registration or a licence.
  Bestie Credit is therefore limited to stores of ONE legal entity. A Thai lawyer must confirm the
  exact current requirement under the Payment Systems Act 2017 before launch.
- Loyalty points: earned from THB spend only; not purchasable; not cash-redeemable.
- VAT-registered shops: each POS device needs a Revenue Department POS ID printed on abbreviated
  tax invoices.

## 3. Architecture (4 layers)

1. **Screens**: POS cashier · Staff app (mobile order taking) · Guest QR pages · KDS / queue screen · Head Office
2. **Business Profile** = default module set: Restaurant · Cafe · Salon · Massage/Spa · Resort · Retail · Tours/Rentals
3. **Add-on modules** (toggle per store): Tables & bill split · Kitchen & queue · Appointments & resources ·
   Commission & packages · Folio & rooms · Stock & cost · Delivery & online · Kiosk · Slot booking & rentals
4. **Core** (always on): Menu/catalog · Orders & payments · Customers & network points ·
   Staff & permissions · Reports & multi-store · Thai tax · Offline & sync · Promotions & coupons · Devices
5. **Integrations**: PromptPay / Thai QR (+ payment confirmation via PSP/bank API) · LINE OA ·
   LINE MAN / Grab · Cloudbeds / Mews PMS · e-Tax Invoice service provider

Toggle levels: store (module on/off) → device (e.g. bar tablet shows only bar menu) → staff role
(e.g. cashier cannot change prices). Modules declare dependencies (KDS needs orders; deposits
need appointments); enabling one auto-enables its dependencies. Disabling hides UI but keeps data.

## 4. Business Profiles

| Profile | Home screen | Sell unit | Default-on specifics |
|---|---|---|---|
| Restaurant (full service) | Floor plan | Dish + modifiers | Move/merge tables, split bill by seat/item/amount, coursing, KDS by station, QR table ordering, staff order app, 10% service charge, table reservations, recipe cost (BOM) |
| Cafe / quick service | Product grid + queue | Cup/item + modifiers (sweetness, milk, shots) | Queue number + call screen, cup sticker printing, order-ahead pickup, stamp card, kiosk, retail beans/bakery |
| Salon / barber / nails | Calendar by stylist | Service (minutes) + products | Online booking by stylist, walk-in queue, deposit/no-show protection, commission service vs product, tips per staff, client history (color formula, before/after photos), LINE/WhatsApp reminders |
| Massage / spa | Calendar by room/bed + therapist | Course 60/90/120 min | Room/bed allocation, course timer, commission per course, 10-visit packages/memberships, gift cards, couple/group booking, health intake form with e-sign |
| Resort / accommodation | Outlets + rooms overview | Night + outlet services | Multiple outlets (restaurant, pool bar, spa, shop), charge to room, PMS link (Cloudbeds/Mews) or light built-in folio, in-room QR ordering, scooter/tour rental, refundable deposits |
| Retail / minimart | Barcode scan | Item + SKU variants | Barcode, stock count, receiving/purchase orders, returns, wholesale price, price label printing |
| Tours / rentals / classes | Slot schedule / assets | Seat per slot, hour/day | Slot/class booking with capacity, timed rental + deposit, passport scan/doc storage, class packages |

## 5. Feature toggle matrix

● on by default · ○ available · – hidden

| Module | Restaurant | Cafe | Salon | Spa | Resort | Retail | Plan |
|---|---|---|---|---|---|---|---|
| Floor plan + move/merge tables | ● | ○ | – | – | ● | – | Basic |
| Split / merge bill | ● | ○ | ○ | ● | ● | – | Basic |
| Queue number + call screen | ○ | ● | ○ | – | – | – | Basic |
| KDS / kitchen print by station | ● | ● | – | – | ● | – | Pro |
| QR order & pay (table/room/bed) | ● | ○ | – | ○ | ● | – | Pro |
| Appointments + online booking | ○ | – | ● | ● | ○ | – | Pro |
| Room/bed/resource allocation | – | – | ○ | ● | ● | – | Pro |
| Deposits / prepayment | ○ | – | ● | ● | ● | – | Pro |
| Commission + tips per staff | ○ | – | ● | ● | ○ | ○ | Pro |
| Packages / courses / memberships | – | ○ | ● | ● | ○ | – | Pro |
| Charge to room / folio | ○ | ○ | – | ○ | ● | ○ | Resort |
| PMS integration | – | – | – | – | ○ | – | Resort |
| Stock + barcode | ○ | ○ | ● | ○ | ○ | ● | Basic |
| Recipe cost (BOM) | ● | ● | – | ○ | ○ | – | Pro |
| Delivery (LINE MAN/Grab) + channel pricing | ○ | ○ | – | – | – | ○ | Pro |
| Service charge | ● | – | – | ○ | ● | – | Basic |
| Self-order kiosk | ○ | ○ | – | – | ○ | ○ | Pro |
| Network points + CRM | ● | ● | ● | ● | ● | ● | Basic |
| Karaoke rooms: timer + time billing (profile Karaoke only; ○ elsewhere) | ○ | ○ | – | – | ○ | – | Basic |
| Karaoke song queue from guests' phones (needs rooms) | – | – | – | – | – | – | Pro |
| Karaoke room booking online with a deposit (needs rooms; off by default) | – | – | – | – | – | – | Pro |

## 6. Core features (benchmark-derived)

- **Payments (tenders)**: Cash · Dynamic PromptPay QR with amount locked and auto-close bill when
  payment is confirmed (FoodStory "POS Pay" pattern — prevents fake slips) · Payment Gateway
  (card, e-wallets) · Bestie Credit · Bestie Points · split tender across any of these.
  Rounding rules per tender; multi-currency *display* only (settle THB). Tenders are toggleable per store.
- **Bestie Credit (prepaid wallet)**: top-up at POS or online via cash, PromptPay, gateway,
  TouristDigiPay (arrives as PromptPay), and optional crypto (legal-gated module, stablecoins only,
  rate locked at confirmation, KYC + tx hash stored, no cash refund of crypto-funded credit).
  Top-up bonuses (e.g. top up 1,000 get 1,050) are booked as discount, not extra cash value.
  Ledger is double-entry; reports show outstanding credit liability per legal entity.
- **Bestie Points (rewards)**: earned from THB spend; redeemed as discount; separate ledger.
- **Menu/catalog**: categories, modifiers with min/max rules, prices per sales channel
  (dine-in / takeaway / delivery / QR), per-option channel pricing, multilingual names, AI menu translation.
- **Orders**: dine-in / takeaway / delivery / booking-linked; voids & refunds with reason + role check.
- **Customers & points**: one customer profile across the network; earn/redeem rules per store;
  member tiers with tier promotions; monthly clearing statement between issuing and redeeming stores.
- **Promotions**: discounts, bulk promo codes (single-use enforced), tier-based promos.
- **Staff**: PIN login, clock in/out, roles & permissions, shift open/close with cash count.
- **Reports**: sales by item/hour/staff/channel, best sellers, peak hours, payment mix, points
  liability, multi-store rollup; bill language setting.
- **Devices**: receipt/kitchen/sticker printers, cash drawer, customer-facing 2nd screen.
- **Offline**: queue writes locally, sync on reconnect, conflict rules defined per entity.

## 7. Koh Phangan network features

- Tourist Pass: scan one QR → digital member card (Apple/Google Wallet or LINE), no app install.
- Island marketplace (web + LINE OA): browse network shops, book spa/salon/tours, order food.
  Commission must stay well below Fresha's 20% new-client fee.
- Languages for guest pages: EN first, then RU, HE, DE, ZH (confirm with pilot shops).

## 8. Roadmap

| Phase | Scope | Gate to next phase |
|---|---|---|
| 1 · MVP | Core + Restaurant & Cafe profiles: menu, orders, payments incl. PromptPay auto-confirm, tables/queue, basic KDS, QR table ordering, offline, reports | 3–5 pilot shops selling through the system daily |
| 2 · Services | Salon & Spa profiles: appointments, rooms/beds, deposits, commission, packages, LINE reminders | Thai lawyer confirms points/clearing structure |
| 3 · Island network | Cross-store points + clearing, Tourist Pass, multilingual guest pages, marketplace | A partner resort ready to connect its PMS |
| 4 · Resort & scale | Folio/charge to room, Cloudbeds/Mews, delivery, kiosk, e-Tax Invoice, Head Office multi-store | — |
