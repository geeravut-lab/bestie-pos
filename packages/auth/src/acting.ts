import type { Membership } from './myContext';

/** Who is acting on a shared till right now (chosen with a PIN). Replaces the signed-in account's own role for screens. */
export type ActingIdentity = Pick<
  Membership,
  'staffId' | 'displayName' | 'roleBuiltIn' | 'roleName' | 'permissions' | 'hiddenModules'
> & {
  /** The signed-in account this PIN unlock belongs to: an unlock never survives a different account. */
  accountId: string;
};

/** An unlock counts only for the account that made it (sign out + sign in as someone else = locked again). */
export const effectiveActing = (
  acting: ActingIdentity | null | undefined,
  accountId: string | undefined,
): ActingIdentity | null => (acting && accountId && acting.accountId === accountId ? acting : null);

/** The membership the screens use: the account's own, with the acting person's role / permissions on top. */
export const withActing = (
  base: Membership | undefined,
  acting: ActingIdentity | null,
): Membership | undefined => (base && acting ? { ...base, ...acting } : base);
