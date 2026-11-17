import { createClient } from '@supabase/supabase-js';
import type { Session, SsoAdmin } from './sso.js';

/** Real `SsoAdmin` on top of Supabase (service_role). Server only — never import this from browser code. */
export function createSupabaseSsoAdmin(url: string, serviceRoleKey: string): SsoAdmin {
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const emailOf = async (userId: string): Promise<string> => {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data.user?.email) throw new Error('linked user has no e-mail');
    return data.user.email;
  };

  return {
    async findLinkedUser(aivoraUserId) {
      const { data, error } = await admin
        .from('aivora_links')
        .select('user_id')
        .eq('aivora_user_id', aivoraUserId)
        .maybeSingle();
      if (error) throw new Error(`aivora_links lookup failed: ${error.code ?? 'unknown'}`);
      if (!data) return null;
      return { userId: data.user_id as string, email: await emailOf(data.user_id as string) };
    },

    async createLinkedUser({ aivoraUserId, email, displayName, avatarUrl, hubEmail }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        app_metadata: { aivora_user_id: aivoraUserId, provider: 'aivora' },
        user_metadata: { display_name: displayName, avatar_url: avatarUrl, hub_email: hubEmail },
      });
      if (error || !data.user) {
        // Two simultaneous first logins: the other request created it — use theirs.
        const existing = await this.findLinkedUser(aivoraUserId);
        if (existing) return existing;
        throw new Error(`createUser failed: ${error?.code ?? 'unknown'}`);
      }
      const { error: linkError } = await admin
        .from('aivora_links')
        .insert({ aivora_user_id: aivoraUserId, user_id: data.user.id });
      if (linkError) {
        await admin.auth.admin.deleteUser(data.user.id); // do not leave an unlinked orphan behind
        const existing = await this.findLinkedUser(aivoraUserId);
        if (existing) return existing;
        throw new Error(`link insert failed: ${linkError.code ?? 'unknown'}`);
      }
      return { userId: data.user.id, email };
    },

    async issueSession(email): Promise<Session> {
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });
      const hashed = link?.properties?.hashed_token;
      if (linkError || !hashed)
        throw new Error(`generateLink failed: ${linkError?.code ?? 'no token'}`);
      const { data, error } = await admin.auth.verifyOtp({ type: 'magiclink', token_hash: hashed });
      if (error || !data.session)
        throw new Error(`verifyOtp failed: ${error?.code ?? 'no session'}`);
      return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
    },

    async fillProfile(userId, { displayName, avatarUrl }) {
      const { data } = await admin
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('user_id', userId)
        .maybeSingle();
      const patch: Record<string, string> = {};
      if (!data?.display_name && displayName) patch.display_name = displayName;
      if (!data?.avatar_url && avatarUrl) patch.avatar_url = avatarUrl;
      if (Object.keys(patch).length > 0)
        await admin.from('profiles').update(patch).eq('user_id', userId);
    },
  };
}
