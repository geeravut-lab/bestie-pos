# Pilot shop onboarding checklist

For the person (owner or Bestie helper) setting up one pilot shop on Koh Phangan. Work top to bottom, tick as you go.
Everything marked **(owner)** needs the shop owner's own accounts or paperwork. Last updated: 2026-11-18.

## Quick check before you go (anyone with a Supabase access token)

```bash
SUPABASE_ACCESS_TOKEN=sbp_… VERCEL_TOKEN=… pnpm pilot:check -- --store "Shop name"
```

Read-only. It prints ✅ / ❌ (fix before go-live) / ⚠️ (decide on purpose) / ℹ️ for the platform (Google + Aivora login settings, production variables in Vercel, e-mail sending) and for the shop (tax ID, VAT and POS ID, menu stations, tables, PINs, devices, printers, Credit / crypto gates), then lists what it **cannot** check (Stripe test run, real printers, accountant / lawyer answers, a real Google and LINE login from a phone). `VERCEL_TOKEN` is optional; `--quiet` hides the ✅ lines, `--json` gives machine-readable output; exit code 1 means a ❌ is left.

## 0. Before the visit (office)

- [ ] Shop details collected: legal name, **tax ID (13 digits)**, branch code (00000 for head office), address, VAT registered yes / no
- [ ] Profile decided: Restaurant (floor plan + kitchen) or Cafe (counter + queue number)
- [ ] Languages the shop's guests need (Thai + English are built in)
- [ ] Number of tablets and who uses them: counter / waiter / kitchen / bar
- [ ] Stripe account (Thailand) is activated for PromptPay and, if card readers are wanted, Terminal is enabled **(owner)**
- [ ] The accountant confirmed the Billing choices below (VAT, service charge, rounding) and that **two receipt series per device** are acceptable (A-… offline cash, A+… online payments) — see DECISIONS.md

## 1. Hardware

| Item | Notes |
|---|---|
| Tablets | iPad or Android tablet, Chrome / Safari, **Add to Home Screen** so the PWA runs full screen. One per role: counter, waiter(s), kitchen, bar |
| Receipt printer | Until a printer is added, receipts save as a **PDF**. Add the printer at `/settings/printers` (USB / Serial / Bluetooth in Chrome or Edge; LAN printers through `tools/print-bridge`; iPad Safari: PDF or browser dialog only), press **Print a test page**, and write down the model that worked or failed |
| Cash drawer | Plugged into the printer; tick *Open the cash drawer after printing* on that printer |
| Card reader (optional) | Stripe Terminal reader available in Thailand; register it in Stripe, note its `tmr_…` id |
| Network | Shop Wi-Fi + a phone hotspot as backup. Offline cash sales work without signal; PromptPay and card need it |
| Power | Charge tablets overnight; a power bank at the counter |

## 2. Account and shop (back office, any browser)

- [ ] Owner signs up at https://bestie-pos.vercel.app/ (e-mail, Google or LINE) and creates the shop → picks the profile
- [ ] **Billing & points** (`/settings/billing`): VAT registered + rate, service charge %, prices include VAT or not, cash rounding, require an open shift before payment — as the accountant said
- [ ] **Modules** (`/modules`): switch on what the shop uses (tables, kitchen, queue …); leave Credit and crypto off — they are legally gated
- [ ] **Menu** (`/menu`): on an empty restaurant or cafe press **Load demo menu** for a starting point (13 dishes + 10 tables or 10 cafe items), then edit names, prices and stations (kitchen / bar). Items without a station never appear on any kitchen screen
- [ ] Menu check: every required option group has at least as many options as its minimum (the editor warns)
- [ ] **Tables** (restaurant): `/tables` → rename / add the real tables and zones

## 2b. Table QR ordering (restaurant, optional)

- [ ] `/modules`: **QR order** switched on (Pro plan)
- [ ] `/tables` → each table → **Ordering QR** → print, stick on the table. Test one with your own phone
- [ ] **Billing & points**: decide whether guest orders go straight to the kitchen (otherwise staff press Send) and whether guests may pay by phone (pick the device whose A+ receipts they use; confirm with the accountant)
- [ ] If a QR photo leaks, press **Create a new code** on that table

## 3. People

- [ ] **Staff** (`/staff`): invite each person with the right role (manager, cashier, waiter, kitchen). Give them the one-time code; they sign up and enter it on the first screen
- [ ] Set a **PIN** (4–8 digits) for every person who works at a till
- [ ] One extra account **per tablet** with the *device's* role (Cashier / Waiter / Kitchen) — never the owner's account on a shop tablet

## 4. Devices and tax POS ID

- [ ] **Register each tablet** (`/devices`): name, role (cashier / staff / KDS + station), then on the tablet press "Use this tablet as this device"
- [ ] **VAT-registered shops: Revenue Department POS ID** — apply for / look up the POS ID of each device and enter it in `/devices`. Receipts that act as abbreviated tax invoices must print it
- [ ] Receipt header check: seller name, tax ID, branch, POS ID appear on a test receipt (`/receipts`)
- [ ] Each tablet: sign in once with its own account, the "Who's working?" lock screen shows, PINs work, 5 minutes idle locks it

## 5. Payments

- [ ] Run the **Stripe test-mode checklist** (docs/ENVIRONMENT.md §6) once before any real money
- [ ] Switch to live Stripe keys in Vercel and re-point the webhook **(owner)**
- [ ] Stripe TEST-mode run with the guided checker: `pnpm stripe:check --guided` (docs/ENVIRONMENT.md §6) — every non-optional step ✅ **(owner + Claude)**
- [ ] Test PromptPay for a small real amount: the bill closes by itself, the receipt is numbered `A+…`
- [ ] Test card (if a reader is used): tap, bill closes
- [ ] Test **cash with the network off**: take an order, pay cash, turn the network on, check it syncs (top bar shows waiting → synced)

## 6. Dry run (30 minutes with the staff)

- [ ] Open a shift with the opening cash (`/shift`)
- [ ] Take a dine-in order → send to kitchen → kitchen screen shows it → Ready → waiter marks Served
- [ ] Cafe: counter order → queue number → call screen shows Ready
- [ ] Split a bill by item / by seat; merge two bills
- [ ] Pay, reprint a receipt, check `/reports` shows today's sale
- [ ] Close the shift: counted cash vs expected, variance recorded
- [ ] Check `/admin/audit` shows the voids and shift events

## 6b. Newer modules — switch on only what the shop uses, then run its check

Every module is OFF until the owner switches it on at `/modules` (some need the Pro plan and a module they depend on — the page says which). Full step-by-step scripts for every role are in `docs/E2E-TEST-GUIDE.pdf (source: tools/e2e-guide)`.

**Tours** (`slots.booking`, optional `tours.online`)
- [ ] `/tours`: make a tour (title Thai required, start, length, seats, price per seat, guide) → book seats at the desk → **Check in** → **Open the bill** → pay it (a deposit already taken is on the bill as paid)
- [ ] **Take a deposit** three ways: PromptPay, card, and **cash into a named till** — open a shift on that till first, close it later and check the cash deposit is in the expected cash
- [ ] Online booking (`tours.online`): copy the link / QR at the bottom of `/tours`, book from a phone, note the **cancel code**, check the deposit shows as due, record it at the desk, check the guest page says *received*
- [ ] Leave one online booking unpaid past its hold time: the next tick (`/api/notify/tick`) cancels it and the seats are free again
- [ ] Cancel one booking that has a deposit and one **no-show**: both appear under *Cancelled and no-show bookings*; a manager keeps one deposit as a fee and refunds the other (cash refund names a till)
- [ ] Reminder: after booking online add an e-mail (and the shop's LINE with the booking code); a counter booking: *Set up the guest reminder*. Needs `RESEND_API_KEY` + `EMAIL_FROM` (test mode: `EMAIL_REDIRECT_TO`) and the scheduler **(owner)**

**Waiting list, time clock, stamp cards, promotions**
- [ ] `/waitlist`: add two parties, seat one, mark one *left*; the quoted wait and the table turnover report make sense
- [ ] `/timeclock`: clock in / out with the PIN of two people, plan a shift, download the timesheet CSV; the kitchen account can use it too
- [ ] `/stamps`: a stamp card (free item after N stamps) and a day pass; pay a bill for a member, see the stamp, use the free item on the next bill (the line goes to price 0), void it and check the stamp comes back
- [ ] `/promotions`: a happy-hour promotion; try one that sells below cost — it is saved OFF until forced; on the order screen the running promotion changes the unsent lines
- [ ] Manager discount: a cashier asks, a manager types their PIN; a wrong PIN is refused, five wrong tries lock it

**Stock, menu profit, smart operations**
- [ ] `/stock`: items, goods in, waste with a reason, count; a supplier and a purchase order received in two parts; a transfer between two shops
- [ ] `/menu-profit`, `/kpi`, `/stock/insights`: the numbers match a hand check of one dish / one day
- [ ] Bad feedback (rating 1–2 on a table page) opens a case in `/cases`; acknowledge, resolve, reopen
- [ ] `/brief` (business manager) and **Ask my shop** (`/ask`): numbers in the answer match the reports; without an AI key the page says so **(owner: keys in Vercel)**

**Service shops (salon / spa)**
- [ ] Calendar booking → arrived → bill → paid; a deposit then a no-show (keep as fee) and a refund; a package sold and a visit used; commission and tips report for a period
- [ ] Online booking link + reminder by e-mail / LINE; the health form and hair advisor with the consent wording **(lawyer reads the wording first)**
- [ ] Days off (one-off and weekly) block both the front desk and the online page

**Retail**
- [ ] Barcodes on items and variants; scan with a handheld scanner and with the camera (Chrome / Android); price labels print; stock count sheet; a return by cash and one onto Credit

**Karaoke**
- [ ] Room timer start / pause / stop (database clock), a time package, a bill `KR…`; the room QR queue page, add a song by link; online room booking with a deposit and the hold release

**Resort**
- [ ] `/folio`: rooms with a nightly rate, check in, charge a bill to the room (whole and part), nights posted, a return to the room, check out and the printed statement **(accountant: form of the documents)**

**Delivery, kiosk, online food page, receipts**
- [ ] `/delivery`: a platform with commission and a token; send a test order to `POST /api/delivery/intake`; close it with *Platform pays*; record a payout
- [ ] `/kiosk`: a kiosk page and an online-order page; an order makes a bill `KS…` / `WB…` that the cashier pays
- [ ] E-receipt by e-mail / LINE from the receipt page; customer display (`/display`) on a second screen
- [ ] Full tax invoice `TI-…` from a receipt of a VAT shop (seller address set at *Settings → Accounting*) **(accountant)**

**Island network and Credit**
- [ ] Join the network (owner), issue a Tourist Pass at the counter, earn at one business and spend at another; the clearing statement shows both directions
- [ ] Credit (only after the lawyer allows): terms accepted before the first top-up, top up in cash, spend on a bill, liability report per company

**Platform administrator**
- [ ] `/admin/flags`: switch a module off for every shop and back; `/admin/analytics`: counts appear after some use; `/ai`: provider and model per task with the Test button; `/admin/line`: the LINE connection check

## 7. Go-live

- [ ] Staff know: PIN login, lock button, what to do offline (cash only; card / PromptPay need signal)
- [ ] Owner knows where reports and the audit trail are; CSV export works
- [ ] Support contact written next to the till
- [ ] A day-1 call / message after closing: what was confusing, what broke

- [ ] **Before go-live: delete the demo data** — `SUPABASE_ACCESS_TOKEN=sbp_… node tools/demo-data/run.mjs remote cleanup --yes` (removes the organisation "[DEMO] Island Group" and every `@bestiedemo.example` account; see tools/demo-data/README.md) **(owner + Claude)**
