# Screenshot rig (local only)

Takes the screenshots of `docs/CUSTOMER-GUIDE.pdf` from the **real apps** running against **demo data on a local Postgres**.
It never touches the hosted Supabase project, Vercel or any real key: the JWT secret in these files is a throw-away local string.

What runs:

1. a throw-away Postgres with the repo's migrations (`/tmp/devpg.sh`-style: `supabase/tests/local_stub.sql` + every migration), then
   `LOCAL_PSQL="psql -h /tmp/devpg -p 54998 -U postgres -d demo" DEMO_PASSWORD=x node tools/demo-data/run.mjs local setup simulate retail network phase4 extras growth full`
   and, so the stub reads PostgREST's claims, `create or replace function auth.uid()` / `auth.role()` to read `request.jwt.claims` too;
2. **PostgREST** (official release, `pgrst.conf` here) on port 3011;
3. the Vercel Functions of `apps/pos/api` bundled with `node build-api.mjs` (run it from `apps/pos`) into `/tmp/api-dist`;
4. `shim-server.mjs` on port 54321: serves the built app (`/tmp/pos-dist`), forwards `/rest/v1` to PostgREST, answers `/auth/v1/user` from the local `auth.users` and runs the functions;
5. the app built with `VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=<anon JWT signed with the local secret> VITE_SITE_URL=http://127.0.0.1:54321 pnpm --filter ./apps/pos exec vite build --outDir /tmp/pos-dist`;
6. the scripts here (`node s_salon.cjs` …) with Playwright; `tokens.sql` makes the `tokens.json` they read. Staff screens use a 390 × 844 phone viewport (`VP=tablet` for a tablet).

Resize the PNGs to JPEG into `../shots` and run `node ../build.mjs`.
