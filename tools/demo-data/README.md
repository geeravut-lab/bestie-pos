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
| all shops | — | `owner.demo`, `manager.demo`, `accountant.demo` (custom role), `stockkeeper.demo` (custom role) |

Also: 8 devices (tills with POS ID, handheld, kitchen / bar screens), ~40 menu items and services (some with barcodes), 8 members
with Bestie Credit and Points, 6 stylists / therapists / rooms, 3 packages, commission rates, information cards, 10 stock items with
recipes, a supplier and a received purchase order, 14 appointments (an online booking, deposits, a no-show fee kept, package visits,
tips), two table-QR guest orders, guest feedback, 4 closed shifts (one 20 baht short).

## What it does NOT do (honestly)
- **PromptPay and card payments are not simulated**: they only exist when Stripe's signed webhook confirms them, and faking that
  would put pretend Stripe payments in the books. Demo bills are cash, split cash, Bestie Credit and Points.
- **No pictures**: menu items, shops and people have no photo field yet.
- The history bills are ordinary cash bills made the same way as today's, only dated in the past (walk-in sales, no members, so no
  Credit / Points in the past). To allow dates older than the app's two-day offline window, the order table's "business date is
  today" guard is switched off inside that one transaction; nothing else is relaxed.

## Safety
The demo accounts share one password and live in the real project: keep the list private, do not give them real roles, and run
`cleanup --yes` before go-live. No demo account is a platform admin. The helper functions (`demo.*`, which can act as any demo user)
exist only while a run is in progress; the tool drops them at the end.
