# Environment, deploy and secrets

Last updated: 2026-11-17. Replaces the Firebase emulator setup in the original plan (see DECISIONS.md).

## 1. Where things run

| Piece | Where | Notes |
|---|---|---|
| Code | GitHub `geeravut-lab/bestie-pos` | PRs run CI (`.github/workflows/ci.yml`) |
| Web apps + Functions | Vercel — production `https://bestie-pos.vercel.app/` | Project root `apps/pos` (see §4) |
| Auth / DB / Storage / Realtime | Supabase `https://pqomylchauwecpgqxoad.supabase.co` | RLS on every table |
| Local dev DB (optional) | `supabase start` (Docker) using `supabase/config.toml` | emulator equivalent |

## 2. Variables

Public (shipped to the browser — `VITE_` prefix, safe to be seen):

| Name | Value | Where to get it |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://pqomylchauwecpgqxoad.supabase.co` | known |
| `VITE_SUPABASE_ANON_KEY` | anon key | Supabase Dashboard → Project Settings → API |
| `VITE_SITE_URL` | `https://bestie-pos.vercel.app` | known |
| `VITE_AIVORA_HUB_URL` | `https://aivora-lc.netlify.app` (default) | Aivora hub |
| `VITE_AIVORA_APP_SLUG` | the slug registered for Bestie at the hub (empty = no LINE button) | **needed from the owner** |

Server only (Vercel Functions in `apps/*/api`, code in `functions/`) — **never** a `VITE_`/`NEXT_PUBLIC_`/`PUBLIC_` prefix:

| Name | Purpose |
|---|---|
| `SUPABASE_URL` | same URL, read by server functions |
| `SUPABASE_SERVICE_ROLE_KEY` | bypasses RLS. SSO exchange, webhooks, cron only. Never logged, never returned. |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_BASIC_ID`, `LINE_CODE_SECRET` | LINE webhook signature, push, OA id for links, HMAC key for link codes (random, **not** the channel secret). Webhook URL to register: `https://bestie-pos.vercel.app/api/line/webhook` |
| `PAYMENT_GATEWAY` | Which payment provider is active (default `stripe`; leave unset for Stripe). A name that is not registered in `functions/src/gateway.ts` makes online payments answer "not configured". |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe payment gateway (PromptPay QR + card reader). The secret key must be an `sk_` / `rk_` key (a publishable `pk_` key is refused). **Stripe Dashboard → Developers → Webhooks → add endpoint `https://bestie-pos.vercel.app/api/stripe/webhook`** with events `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`; its signing secret is `STRIPE_WEBHOOK_SECRET`. Use test keys first. |
| *(later)* `CRON_SECRET` | authenticates scheduled-function calls (constant-time compare) |
| `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (alias `GOOGLE_AI_API_KEY` accepted) | AI assistant providers. Set as *Sensitive* in Vercel. **Never use a free-tier key with real customer data.** The admin screen shows only set / missing. |
| `AIVORA_APP_SLUG`, `AIVORA_HUB_EXCHANGE_URL`, `SITE_HOST` | SSO exchange function (`/api/sso-exchange`); slug **needed from the owner** |

Guards: `packages/supabase` throws on a secret-looking name with a public prefix, and
`scripts/check-conventions.mjs` fails CI if one appears in the repo.

## 3. Local development

```bash
pnpm install
cp .env.example .env.local      # fill VITE_SUPABASE_ANON_KEY
pnpm dev:pos                    # http://localhost:5173  (admin 5174, guest 5175) — reads the root .env.local
pnpm check                      # same as CI
```


## 4. Vercel setup

**Already applied via the Vercel API (2026-11-17)** for project `bestie-pos` (team `geeravut-lab`): Root Directory `apps/pos`, framework Vite,
Node 22.x, "include source files outside root" on, **Preview deployments disabled** (only `main` → production deploys),
Vercel Authentication limited to previews so the production URL stays public, env vars below set (`SUPABASE_SERVICE_ROLE_KEY` as *Sensitive*, production only).
The first production deploy happens when a PR is merged into `main`. The build was dry-run locally with `vercel pull` + `vercel build --prod`
(static output + `/api/health` function both OK). Manual steps, if the project is ever recreated:

1. Import the GitHub repo `geeravut-lab/bestie-pos` as a project named `bestie-pos`.
2. **Root Directory:** `apps/pos` and keep *"Include source files outside of the Root Directory"* ON
   (needed for `packages/*` and `functions/`). Framework preset: Vite. `apps/pos/vercel.json` holds install/build/output and the SPA rewrite.
3. Add the variables in §2 under Settings → Environment Variables (Production + Preview). Add `SUPABASE_SERVICE_ROLE_KEY` as *Sensitive*.
4. Production branch = `main`. Every PR gets a preview URL. Smoke test after deploy: `GET /api/health` →
   `{"ok":true,...,"config":{"supabaseUrl":true,"serviceRoleKey":true}}`.
5. In Supabase → Authentication → URL Configuration add `https://bestie-pos.vercel.app/**` (and preview/localhost URLs) as redirect URLs.

`apps/admin` and `apps/guest` carry their own `vercel.json` so they can become separate Vercel projects later.

## 5. Traps already known (from the knowledge files)

- Asset paths absolute + `base: '/'`; the SPA rewrite excludes `api/`, `assets/` and anything with a file extension so a missing JS/CSS is a 404, not `index.html` with status 200 (SSO doc, step 1).
- Never read the service_role key in browser code; never exchange SSO tickets from the browser.
- Migrations and deploys are not atomic: code must tolerate a column that does not exist yet (`42703` / `PGRST204` / `23514`).

## 6. Stripe test-mode run (do this once before any pilot shop takes a real payment)

The build environment cannot reach Stripe, so the PromptPay / card-reader code is covered by tests with a fake Stripe, not by a
real run. With **test** keys in Vercel (`STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` of a test-mode endpoint):

1. Stripe Dashboard (test mode) → Developers → Webhooks → endpoint `https://bestie-pos.vercel.app/api/stripe/webhook`, events
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`.
2. Enable **PromptPay** under Settings → Payment methods (Thai account). For cards: order / register a Terminal reader and put its id
   (`tmr_…`) in Back office → Shop devices → the till's "Stripe card reader ID".
3. On a bound tablet: open a bill → **Take payment → PromptPay QR**. Expect a QR image. In test mode use Stripe's test payment tools
   to complete it → the screen should switch to the receipt by itself and the receipt number should look like `A+000001`.
4. Cancel a QR: the attempt becomes `canceled`, the next QR works, and no receipt number is skipped.
5. Pay with cash on the same bill after cancelling: receipt `A-00000N` (offline series) as before.
6. Try a mismatch on purpose (add an item while the QR is open, then complete the payment): the attempt must become `needs_review`,
   the bill stays open, and an audit line `payment.tender` with `review: true` appears.
7. Card reader (if you have one): **Take payment → Card → send the amount**; tap a test card; same receipt / series behaviour.

If a step differs from what Stripe actually returns (field names, the PromptPay e-mail rule, reader availability in Thailand),
fix `functions/src/stripe.ts` and its tests — nothing else depends on Stripe's wire format.

### Guest PromptPay at the table (add to the test-mode run)
1. In **Billing & points** choose the device whose receipts guest payments use.
2. Open a table's QR page (`/t/<token>`) on a phone, order, let staff send the lines, press **Pay with PromptPay**: a QR appears.
3. Pay it with a Stripe test PromptPay payment; within ~3 s the page shows **Paid** and the receipt number `X+000001`; the bill is closed on the till.
4. Press **Cancel payment** on a second attempt: the QR disappears and the intent is cancelled in the Stripe dashboard.
5. Reload the page while a QR is live: the same QR returns (no second intent).

## 7. Crypto top-up (module `credit.topup.crypto`) — only after the lawyer's sign-off
Server-only variables (never a public prefix):

| Name | Purpose |
|---|---|
| `TRONGRID_API_KEY` | TronGrid API key (reads USDT-TRC20 transfers into the company wallet; read-only) |
| `ETHERSCAN_API_KEY` | Etherscan API key (USDT-ERC20 transfers; read-only) |
| `CRON_SECRET` | secret for `/api/crypto/poll` (constant-time compare) |
| `PRICE_URL_COINGECKO`, `PRICE_URL_THAI_TICKER` | optional: override the two public price sources (the Thai exchange's public ticker is read for the PRICE only) |

- **Scheduler:** `vercel.json` has **no** cron entry on purpose (a per-minute cron is refused on a Hobby plan and would break the deploy). On a Pro plan add `"crons": [{ "path": "/api/crypto/poll", "schedule": "* * * * *" }]`; otherwise call `GET /api/crypto/poll` with `Authorization: Bearer $CRON_SECRET` from any scheduler (GitHub Actions `schedule`, cron-job.org …). Until then staff use **Check now** on a request (rate limited).
- **Before real money:** run the whole flow on **Tron Shasta / Ethereum Sepolia** with test USDT; confirm the TronGrid, Etherscan and price-source response shapes (marked ⚠️ in `functions/src/crypto-*.ts`); set the company wallet (read-only address) and print its 6+6-character card for the shop; get the lawyer's file uploaded and `legal_sign_off.cryptoTopup` set by the platform admin.


## 8. Notifications (in-app inbox + LINE) — what to set so the LINE messages actually leave
The in-app bell and inbox (`/notifications`) work with nothing to set up. Delivery to LINE needs:

| Name | Purpose |
|---|---|
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CODE_SECRET`, `LINE_BASIC_ID` | the LINE Official Account (same as account linking, §2) |
| `CRON_SECRET` | secret for `/api/notify/tick` (the same one as the crypto poll can be used) |

- **Scheduler:** call `GET|POST /api/notify/tick` with `Authorization: Bearer $CRON_SECRET` **every 1–5 minutes** (GitHub Actions `schedule`, cron-job.org, or Vercel Cron on a Pro plan). Each call (1) writes the **daily sales summary** from 21:00 Bangkok time on (safe to repeat: one per shop per day), (2) sends what is due to LINE, (3) tidies old rows once an hour. Without a scheduler the inbox still fills; LINE messages simply wait in the queue and expire after 24 hours (a late "order ready" is not news).
- **Monthly cap:** `notification_settings.line_monthly_cap` (default 200 pushes a month — the free LINE plan) with `line_reserve` (default 20) kept for **urgent** notices (a payment that needs review, a large cash difference). Change them in the database; an admin screen comes later.
- **If LINE rejects the token (401/403)** the tick stops and holds the queue for 6 hours (`notification_settings.halted_until`), then tries again.
- Test: link LINE on the account page, take a PromptPay test payment (§6) → the owner gets a "Payment received ฿…" card within one tick.

## 9. AI for guests and menu drafting (modules `ai.guest`, task `menu_tags`)
Set `ANTHROPIC_API_KEY` and/or `GOOGLE_API_KEY` (server-only, Vercel). Then pick provider and model for the tasks `guest_menu_qa` (guest filter) and `menu_tags` (owner's tag draft) at `/ai` as platform admin and press **Test**. Switch the module **Guest menu assistant (AI)** on per shop at `/modules` (needs the Pro plan and QR ordering). Without a key, or with the module off, nothing breaks: the guest filter buttons and manual tags work as before. Check cost after a week: the target is under THB 1 per guest session with the small default models.
