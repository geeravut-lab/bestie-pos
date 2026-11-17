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

Server only (Vercel Functions in `apps/*/api`, code in `functions/`) — **never** a `VITE_`/`NEXT_PUBLIC_`/`PUBLIC_` prefix:

| Name | Purpose |
|---|---|
| `SUPABASE_URL` | same URL, read by server functions |
| `SUPABASE_SERVICE_ROLE_KEY` | bypasses RLS. SSO exchange, webhooks, cron only. Never logged, never returned. |
| *(later)* `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | LINE webhook + push |
| *(later)* `CRON_SECRET` | authenticates scheduled-function calls (constant-time compare) |
| *(later)* `AI_*` provider keys | AI assistant providers (Anthropic, Google, …) |
| *(later)* `AIVORA_HUB_URL`, `AIVORA_APP_SLUG` | SSO (see DECISIONS.md open question) |

Guards: `packages/supabase` throws on a secret-looking name with a public prefix, and
`scripts/check-conventions.mjs` fails CI if one appears in the repo.

## 3. Local development

```bash
pnpm install
cp .env.example .env.local      # fill VITE_SUPABASE_ANON_KEY
pnpm dev:pos                    # http://localhost:5173  (admin 5174, guest 5175) — reads the root .env.local
pnpm check                      # same as CI
```


## 4. Vercel setup (one-time, in the Vercel dashboard)

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
