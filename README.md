# Bestie POS

Multi-profile cloud POS for restaurants, cafes, salons, spas, resorts and retail on Koh Phangan.
Production: <https://bestie-pos.vercel.app/> · Stack: Vercel + Supabase + GitHub.

Start with `CLAUDE.md`, then `docs/PRODUCT_SPEC.md`, `docs/PHASE1_TASKS.md`, `docs/DECISIONS.md`.
Design: `docs/UX-DESIGN.md` · Knowledge → features: `docs/KNOWLEDGE-MAPPING.md` · Env/deploy: `docs/ENVIRONMENT.md`.

## Quick start

```bash
pnpm install          # Node 22+, pnpm 10
cp .env.example .env.local   # add VITE_SUPABASE_ANON_KEY
pnpm dev:pos          # http://localhost:5173   (admin :5174, guest :5175)
pnpm check            # format + lint + typecheck + tests + build (what CI runs)
```

| Path | What |
|---|---|
| `apps/pos` · `apps/admin` · `apps/guest` | React + Vite PWAs |
| `packages/core` | pure domain logic (money, modules, points) |
| `packages/i18n` | Thai/English dictionary + provider |
| `packages/ui` | design tokens, logo, `AsyncButton` (spinner), language switch |
| `packages/supabase` | browser client + public-env guard |
| `functions/` | server-only logic mounted as Vercel Functions (`apps/*/api`) |
| `supabase/` | local stack config + SQL migrations |
