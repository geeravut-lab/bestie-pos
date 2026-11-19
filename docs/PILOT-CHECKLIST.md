# Pilot shop onboarding checklist

For the person (owner or Bestie helper) setting up one pilot shop on Koh Phangan. Work top to bottom, tick as you go.
Everything marked **(owner)** needs the shop owner's own accounts or paperwork. Last updated: 2026-11-18.

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

## 7. Go-live

- [ ] Staff know: PIN login, lock button, what to do offline (cash only; card / PromptPay need signal)
- [ ] Owner knows where reports and the audit trail are; CSV export works
- [ ] Support contact written next to the till
- [ ] A day-1 call / message after closing: what was confusing, what broke
