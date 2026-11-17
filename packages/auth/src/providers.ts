/**
 * Which sign-in providers are switched on in Supabase (public endpoint /auth/v1/settings), so the login page only
 * shows buttons that will actually work. A failure shows none of the optional buttons — email still works.
 */
export type EnabledProviders = { google: boolean };

export async function fetchEnabledProviders(
  supabaseUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EnabledProviders> {
  try {
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey },
    });
    if (!res.ok) return { google: false };
    const body = (await res.json()) as { external?: Record<string, unknown> };
    return { google: body.external?.google === true };
  } catch {
    return { google: false };
  }
}

/** Where the "Sign in with LINE (Aivora)" button goes (docs/SSO-Aivora-Supabase.md step 8). */
export function aivoraAuthorizeUrl(hubUrl: string, appSlug: string, callbackUrl: string): string {
  const base = hubUrl.replace(/\/+$/, '');
  return `${base}/sso/authorize?app=${encodeURIComponent(appSlug)}&return=${encodeURIComponent(callbackUrl)}`;
}
