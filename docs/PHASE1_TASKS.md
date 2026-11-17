# Phase 1 — MVP task list

Goal: Core + Restaurant and Cafe profiles, usable by 3–5 pilot shops on Koh Phangan.
Work top to bottom. One PR per task. Tick when merged.

## 0. Foundation
- [ ] Scaffold pnpm monorepo: apps/pos, apps/admin, apps/guest, packages/core, functions
- [ ] Firebase project config (emulators for local dev + tests), environment variables documented
- [ ] Lint, format, Vitest, CI on every PR
- [ ] i18n setup (th, en) shared by all apps

## 1. Core domain (packages/core, pure TS + tests)
- [ ] Types: Org, Store, Device, Staff, Role, Profile, Module, MenuItem, Modifier, Order, Payment, Customer, PointsLedger
- [ ] Money in satang; VAT (inclusive/exclusive), service charge, rounding per payment method
- [ ] Module registry with dependencies, default profiles, plan tier; `isEnabled(store, module, device?, role?)`
- [ ] Profile presets for Restaurant and Cafe
- [ ] Points rules: earn from THB spend only, redeem as discount, no purchase/cash-out (enforced + tested)

## 2. Back office (apps/admin)
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
