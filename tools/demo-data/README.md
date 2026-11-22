# Demo data (for showing Bestie POS to a business owner)

Creates **one demo company with four shops**, an account for every role, a catalogue, members, bookings, stock, **9 days of
history (163 bills, varied by weekday and hour)** and **37 paid bills today** that the real database functions book **as each person** (so RLS and permission checks apply). Everything is marked
`[DEMO]` / `@bestiedemo.example`, and one command removes it all before go-live.

```bash
# create + simulate (the password is NOT stored in git; use a throw-away value and never reuse it)
DEMO_PASSWORD='…' SUPABASE_ACCESS_TOKEN=sbp_… node tools/demo-data/run.mjs remote setup simulate

# delete everything demo (the organisation, its shops / bills / receipts / ledgers / audit lines, and the demo accounts)
SUPABASE_ACCESS_TOKEN=sbp_… node tools/demo-data/run.mjs remote cleanup --yes
```

`local` instead of `remote` runs the same files on a throw-away Postgres (`LOCAL_PSQL="psql -h … -d …"`), which is how they are tested.
Running `setup` / `simulate` twice does nothing new (each step checks first); run `cleanup` and start again for a fresh set.

## What is created
| Shop | Profile | Team (login = `<name>@bestiedemo.example`, PIN 1234 for all) |
|---|---|---|
| Island Kitchen | restaurant (VAT 7 %, service 10 %) | `cashier.kitchen.demo`, `waiter.kitchen.demo`, `kds.kitchen.demo`, `bar.kitchen.demo` |
| Breeze Café | cafe | `cashier.cafe.demo`, `kds.cafe.demo` |
| Sunset Salon | salon | `reception.salon.demo`, `stylist.salon.demo` |
| Lotus Spa | spa | `reception.spa.demo`, `therapist.spa.demo` |
| Island Mart | retail (`retail` step, see below) | `cashier.retail.demo`, `manager.retail.demo` |
| all shops | — | `owner.demo`, `manager.demo`, `accountant.demo` (custom role), `stockkeeper.demo` (custom role) |

Also: 8 devices (tills with POS ID, handheld, kitchen / bar screens), ~40 menu items and services (some with barcodes), 8 members
with Bestie Credit and Points, 6 stylists / therapists / rooms, 3 packages, commission rates, information cards, 10 stock items with
recipes, a supplier and a received purchase order, 14 appointments (an online booking, deposits, a no-show fee kept, package visits,
tips), two table-QR guest orders, guest feedback, 4 closed shifts (one 20 baht short).

## The island network (`network` step)
`node tools/demo-data/run.mjs remote network` (needs migration 63 and the demo set up; safe to run again) adds a **second business**, "[DEMO] Palm Beach Co" (one café, `owner.beach.demo`, `cashier.beach.demo`), joins both businesses to the network `koh-phangan`, gives three shops a marketplace listing and three tourists a **Tourist Pass** (fake phones `0999000101`–`103`), and makes bills so that Points are **earned at Breeze Café and spent at Palm Beach** (Anna 12, Liu 6) and **earned at Palm Beach and spent at Lotus Spa** (Dan 20). The clearing statement on `/network` then has a line in each direction (18 points = THB 18.00 and 20 points = THB 20.00) and each business sees only its own lines. The sales are in four files because every file is its own transaction: the Points then have different times and the first-in-first-out order is real. Without `DEMO_PASSWORD` the two new accounts get a random password nobody knows. `cleanup --yes` removes both businesses, the passes and the accounts.

## Karaoke and resort (`phase4` step)
`node tools/demo-data/run.mjs remote phase4` (needs migrations 70, 73 and 74; safe to run again) adds **Sing Along** (karaoke: three rooms, two time packages, VIP 1 running with a package and three songs queued, a reservation for tomorrow 20:00) and **Palm Resort** (resort on the Resort plan: rooms 101–104, Anna in 101 with a Breeze Café bill and a Lotus Spa bill charged to her room, Liu in 102). It uses the existing demo accounts (the owner acts). `cleanup --yes` removes them with everything else.

## The newest modules (`extras` step)
`node tools/demo-data/run.mjs remote extras` (needs migrations 75–81 and the `phase4` step; safe to run again) switches the newer modules on where they fit and makes data to click through: **Island Kitchen** — a delivery platform *LINE MAN* (30 % commission) with one incoming order `DL001` made through the same intake function the server uses, the seller address and a **full tax invoice** `TI-000001` for the latest VAT bill; **Breeze Café** — a self-order kiosk and an online-order page (links and QR at `/kiosk`) and a bill split between room 103 (THB 100) and cash; **Palm Resort** — a nightly rate of THB 1,500 on every room, a guest (Mia Chen, room 103) who checked in two days ago with two nights posted, and an information page; **Sing Along** — online booking of rooms with a 30 % deposit and one guest booking. It uses the existing demo accounts; `cleanup --yes` removes it all. The platform token and the cancel code of the guest booking are not shown anywhere (make a new token at `/delivery`).

## Sets A–D and tours online (`growth` step)
`node tools/demo-data/run.mjs remote growth` (needs migrations 82–88 and the `setup` step; safe to run again) switches the modules of sets A–D on where they fit and makes data to click through: **Island Kitchen** — a *Happy hour* promotion (20 % on weekdays 15:00–17:00), an upsell rule (basil rice suggests iced tea), a waiting list with two parties, the cashier clocked in, three guest feedbacks with two **service cases** (one acknowledged, one resolved), waste with reasons and the business manager's findings; **Breeze Café** — a coffee stamp card (5 stamps = a free latte), a monthly coffee pass and two **draft** LINE campaigns (inactive: nothing is sent and no member consent or LINE contact is faked); **Island Tours** (a new tours shop on the Pro plan) — two tour slots, a guest booking made through the online booking function with a **cash deposit of THB 720.00 recorded into the "Tour desk" till** (so the shift count includes it), and a counter booking with a PromptPay deposit. The tour link and QR are at the bottom of `/tours`. It uses the existing demo accounts; `cleanup --yes` removes it all.

## What it does NOT do (honestly)
- **PromptPay and card payments are not simulated**: they only exist when Stripe's signed webhook confirms them, and faking that
  would put pretend Stripe payments in the books. Demo bills are cash, split cash, Bestie Credit and Points.
- **Pictures are placeholders**: 40 colour tiles with an emoji (`make-images.mjs`), not photos of the dishes. Shops and people have no picture field.
- The history bills are ordinary cash bills made the same way as today's, only dated in the past (walk-in sales, no members, so no
  Credit / Points in the past). To allow dates older than the app's two-day offline window, the order table's "business date is
  today" guard is switched off inside that one transaction; nothing else is relaxed.

## Safety
The demo accounts share one password and live in the real project: keep the list private, do not give them real roles, and run
`cleanup --yes` before go-live. No demo account is a platform admin. The helper functions (`demo.*`, which can act as any demo user)
exist only while a run is in progress; the tool drops them at the end.

## The Retail shop and product returns (`retail` step)
```bash
DEMO_PASSWORD='…' SUPABASE_ACCESS_TOKEN=sbp_… node tools/demo-data/run.mjs remote retail
```
Adds **Island Mart** (retail, VAT 7 %) to an existing demo: a cashier and a manager (PIN 1234), a till, six products with barcodes
and stock (30 each), a morning shift, **five sales** (cash, Bestie Credit, Points) and **three returns**: a T-shirt back for cash and on the
shelf, a damaged bottle refunded onto the member's Credit (not restocked), and a wrong-size T-shirt for cash with the Points taken back. The
shift closes with the drawer exactly right (cash refunds leave it). Safe to run again; `cleanup` removes it with the rest.

## Everything else (`full` step)
`node tools/demo-data/run.mjs remote full` (needs migrations 82–89, the `setup`, `retail`, `network`, `phase4`, `extras` and `growth` steps; safe to run again) fills the gaps so every role and module has data: **24 accounts** (cashier / waiter / kitchen / bar per shop, reception and stylist / therapist for salon and spa, retail manager and cashier, resort and karaoke desks, tours cashier and guide, an accountant and a stock keeper with their own roles) sharing the owner demo's password and PIN 1234, devices *Front desk* and *Karaoke desk*, open shifts, Island Tours bills with cash deposits (kept as a fee, refunded), three karaoke bills (one with a package and a split), a resort check-out in cash, stamps and a day pass, a manager discount, a delivery bill paid and a payout, stock lots and a transfer, hair styles, client notes, health forms, a day off and a weekly break, planned shifts and a timesheet, an API key, an AI budget and usage counts, and a guest who switched off sharing with one business. `cleanup --yes` removes it all. The password is passed as `DEMO_PASSWORD` only when `setup` or `retail` runs; `full` copies the owner demo's stored hash.
