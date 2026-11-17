# UX / UI Design — Bestie POS "Island Breeze"

Last updated: 2026-11-17. Status: **tokens, logo, favicon and base components are built** (Foundation PR).
Role home / landing, bottom bar and illustrated cards are **designed here, built in the next PR** (PHASE1_TASKS §9).

## 1. Feeling → design decisions

The owner wants users to feel **สนุกสนาน (playful) · ร่าเริง (cheerful) · ปลอดโปร่ง (airy) · ปลอดภัย (safe)**, in a tool that is used
all day with wet hands on a tablet at the counter.

| Feeling | What the user sees | How it is built |
|---|---|---|
| Playful | Friendly rounded font (Nunito), big rounded cards (20 px), pill buttons, one sun-yellow "pop" per screen, small illustrations on cards | `--bp-radius-card`, sun/coral accents used sparingly (≈10 %) |
| Cheerful | Sea-teal gradient hero bands, warm yellow badges, check-mark confirmations, gentle press animation | `--bp-brand` gradient, `.badge`, `.btn:active { scale(.98) }` |
| Airy | Pale mint page background, white cards with soft navy-tinted shadow, generous spacing, one column on phones | `--bp-bg #f3fbfb`, `--bp-shadow`, 1.6 line height (Thai needs it) |
| Safe | Deep navy text (never pure black), trustworthy teal as the *action* colour, red reserved for errors/destructive, every status has icon + words, spinner on every action so nothing looks frozen | `--bp-ink`, `--bp-primary`, status tokens, `AsyncButton` |

Koh Phangan story: sea (teal) + sun (yellow) + sunset/coral accent, on sand-white/mint. Not neon, not corporate grey.

## 2. Reference patterns (what leading POS apps do, and what we take)

Synthesised from the benchmark set in PRODUCT_SPEC (Square, Toast, Lightspeed, StoreHub, FoodStory/Wongnai POS, Loyverse). These are widely
known patterns; this round did not open the live apps, so treat as design direction to validate with pilot shops.

| Pattern | Take | Leave |
|---|---|---|
| Large product tiles with a picture, 1–2 taps to add | ✔ cards with illustration/photo, min 44 px targets (POS target 56 px) | dense tables on phones |
| Bottom tab bar on phones, side rail on tablets, sidebar on desktop | ✔ one nav source for all three | hamburger-only navigation |
| Big, always-visible primary action ("Charge") | ✔ a centre "New sale" action in the bottom bar | action hidden in menus |
| Colour-coded order / table status | ✔ but always icon + text too (not colour alone) | colour-only meaning |
| Dark "kitchen display" | ✔ KDS (Thai) gets a high-contrast variant later | dark mode everywhere now |

## 3. Colour tokens (`packages/ui/src/theme.css` — the only file with colour values)

| Token | Hex | Role | Text on it |
|---|---|---|---|
| `--bp-bg` | `#f3fbfb` | page background | ink 13.4:1 |
| `--bp-surface` | `#ffffff` | cards, header, fields | ink, muted 6.1:1 |
| `--bp-mint` / `--bp-sky` | `#d5f7f0` / `#dff1fb` | selected row, hover, info | ink |
| `--bp-ink` | `#0f2d4a` | main text, headings | — |
| `--bp-muted` | `#4f6577` | secondary text | on bg 5.8:1 |
| `--bp-primary` | `#00796f` | buttons, links, focus ring | white 5.3:1 |
| `--bp-primary-hover` / `-pressed` | `#005f58` / `#004d47` | button states; text on mint | white 7.6:1 |
| `--bp-brand` | `#2bd4bf` | **fill only** (hero, badges, charts) | **ink** 7.5:1 (white ✗) |
| `--bp-accent` | `#ff7a59` | **fill only** (promo, counters) | **ink** 5.5:1 (white ✗) |
| `--bp-sun` | `#ffcb3d` | **fill only** ("new", highlights) | **ink** 9.3:1 |
| `--bp-line` / `--bp-field-border` | `#d8e8e8` / `#6a8590` | card edge (decor) / visible input border (3.9:1) | — |
| success / warning / danger / info | see file | status, **always with icon + text** | ≥ 4.5:1 |

Proportion: light surfaces ≈ 70 %, teal ≈ 20 %, sun/coral ≈ 10 %. All pairs above are asserted in `theme.test.ts`;
white-on-brand and white-on-accent are asserted as **failing**, so nobody "fixes" them wrongly.

Per-store theme (later): a store may change only 5 colours (`primary`, `ink`, `bg`, `accent`, `surface`), validated by the same contrast
function before saving (TYPOGRAPHY-COLOR-KNOWLEDGE §3.3). The admin back office always uses the platform theme.

## 4. Typography

`Nunito Variable` (Latin/numbers, rounded and friendly) → `Noto Sans Thai Variable` (Thai, falls in per character) → system. Bundled via
`@fontsource-variable/*` (no Google call at runtime), `font-display: swap`. Body 16 px / 1.6, inputs ≥ 16 px (no iOS zoom), weights 400/600/700/800,
no italics. Scale 12 · 14 · 16 · 18 · 20 · 24 · 30 · 36. Money and counts use `tabular-nums` (`.tabular`).
Thai multi-line text never uses `leading-none/tight`.

## 5. Logo & favicon (built)

- **Mark** (`packages/ui/brand/logo-mark.svg`): a sea-teal rounded tile holding a white **speech bubble** with a rounded navy **"B"**, and a **sun** dot
  on the corner. Reads as: *Bestie* = a friend who talks to you (bubble), *B* for Bestie, sun = good mood / island; teal + navy = trust.
- **Favicon** (`favicon.svg`): simplified for 16 px — bold white B on the tile with the sun dot (no bubble, which would turn to mush).
- Generated, committed: `favicon.ico` (16/32/48), `favicon-32.png`, `apple-touch-icon.png` (180), `icon-192/512.png`, `icon-maskable-512.png`
  (artwork inside the 80 % safe zone), copied into every app's `public/` and referenced from `index.html` + `manifest.webmanifest`.
  Rebuild with `pnpm brand:build`.
- The wordmark "Bestie POS" is live text from the dictionary (`<Brand>`), never baked into an image, so the admin can rename the product.
- **Admin override (queued, PHASE1_TASKS §9):** these files are only the *default*. Following BRANDING-KNOWLEDGE.md, the admin uploads a logo
  (raster image ≤ 1 MB, never SVG) and icon (square PNG 192–1024 px ≤ 512 KB) to a private Supabase Storage bucket; the app serves them at `/brand/logo`
  and `/brand/favicon` (ETag = upload time, fallback = these defaults), `LogoMark` already accepts the override `src`.

## 6. Loading feedback (the "spinner rule", built)

Every action that takes time shows a spinner **at the control that was pressed**, immediately, until the work finishes:

- `<AsyncButton onClick={async () => …}>` → spinner + `aria-busy` + hidden live text "Working on it", extra clicks ignored (ref guard, so two
  taps in the same frame cannot both pass), spinner removed on success **or** failure; failures become an `err_*` code, never an unhandled rejection.
- Menu / bottom-bar items that navigate show a top progress bar + spinner on the tapped item while the next screen loads (built with the router).
- `prefers-reduced-motion`: spinner slows but never disappears (it is a status, not decoration).
- Unit-tested: spinner appears/disappears, 3 rapid clicks → 1 call, synchronous double-click → 1 call, error path clears the spinner.

## 7. Role home / landing (designed — next PR)

One home screen per role, assembled from the **same card list** that drives the sidebar and bottom bar (one nav source; add a page in one place).

**Layout**
- Phone (< 768): sticky header (logo, language, bell) → greeting band (gradient, ink text) → 2-column card grid (wide cards span 2) → **bottom bar**:
  `Home · Orders · [ ＋ New sale ] · Tables/Customers · More`. The centre action is raised and always the primary job of the role.
  "More" opens a sheet (max 85 dvh, scrolls, arrows show hidden items, closes with ✕ / backdrop / Esc / device Back).
- Tablet (768–1100, the main POS device): left **rail** with icons + labels, cards in 3–4 columns, 56 px tap targets.
- Desktop: full sidebar, content `max-w-3xl` for forms, wider for dashboards. Same code, one breakpoint (`md` = 768).
- Safe-area insets honoured; content padded so the last card is never hidden behind the bar. No horizontal scroll anywhere.

**Cards** — every card = illustration (top, 16:10) + title + one-line hint + optional live badge (e.g. "3 open tables").
Illustrations are flat 2-tone SVGs in the Island Breeze palette with the sun-dot motif (sharp at every size, tiny files). Each card has an
`image_url` override so the **admin can upload a replacement per card** (Supabase Storage bucket `card-images`, falls back to the built-in SVG).
Cards of switched-off modules stay visible but grey and non-clickable (feature-flag knowledge: nobody wonders where a menu went).

| Role | Cards (default order) | Centre action |
|---|---|---|
| Cashier | Sell · Tables/Queue · Today's orders · Customers & points · Shift · Receipts | Sell |
| Waiter / staff | Tables · Take order · Ready to serve · Customers | Take order |
| Kitchen / bar (KDS) | Station board (full screen, Thai) | — |
| Manager | Today's sales · Menu · Stock · Staff · Reports · Credit & Points | Sell |
| Owner | Dashboard (all stores) · Modules · Menu · Staff & roles · Devices · Credit liability · AI assistant | Dashboard |
| Platform admin | Branding · Feature flags · Audit trail · AI settings · LINE · Analytics | — |
| Guest | Menu & order · My pass · Book · Pay | Order |

Illustration brief (one SVG each, 3–5 shapes, no text): Sell = tablet with a coin + sparkle; Tables = round table with two stools; Queue = ticket "A12"
with a bell; Orders = receipt roll; Customers = two smiling avatars; Shift = clock + cash drawer; Menu = steaming cup + croissant; Stock = stacked crates;
Staff = apron; Reports = bar chart rising into the sun; Credit = wallet with a leaf; Points = star coin; AI = friendly spark-bubble; Branding = paint palette;
Audit = shield with magnifier; LINE = chat bubble with bell; Guest pass = QR in a palm leaf.

**Always-visible rules:** a "back to <parent>" link on every non-menu page (PWA has no browser Back), shop status (online/offline + queued writes)
in the header, language switch one tap away, errors in plain Thai/English with an icon.

## 8. Accessibility & device checklist (each screen must pass)

390×844 and 1280×800 in both languages; axe no serious violations; `scrollWidth <= clientWidth`; all targets ≥ 44 px (POS targets 56 px);
inputs ≥ 16 px; status not by colour alone; visible focus ring (3 px primary); works with the keyboard; Playwright covers shell + home.
