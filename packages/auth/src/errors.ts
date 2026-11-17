import type { ErrorKey } from '@bestie/i18n';

/** Supabase auth errors → our `err_*` codes (screens turn them into a sentence in the user's language). */
export function authErrorCode(
  error: { code?: string; message?: string; status?: number } | null | undefined,
): ErrorKey {
  const code = error?.code ?? '';
  const msg = (error?.message ?? '').toLowerCase();
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials'))
    return 'err_auth_invalid';
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    msg.includes('already registered')
  )
    return 'err_auth_exists';
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed'))
    return 'err_auth_email_unconfirmed';
  if (code === 'weak_password' || msg.includes('password should be at least'))
    return 'err_weak_password';
  if (
    code === 'over_request_rate_limit' ||
    code === 'over_email_send_rate_limit' ||
    error?.status === 429
  )
    return 'err_rate_limited';
  if (
    code === 'provider_disabled' ||
    code === 'validation_failed' ||
    msg.includes('provider is not enabled')
  )
    return 'err_provider_disabled';
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'err_network';
  return 'err_unknown';
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // bcrypt limit

/** Client-side checks before asking the server (CHANGE-PASSWORD-KNOWLEDGE §2). Returns an `err_*` code or null. */
export function passwordChangeProblem(input: {
  current: string;
  next: string;
  confirm: string;
}): ErrorKey | null {
  if (!input.current) return 'err_password_current_wrong';
  if (input.next.length < PASSWORD_MIN) return 'err_weak_password';
  if (input.next.length > PASSWORD_MAX) return 'err_password_long';
  if (input.next !== input.confirm) return 'err_password_mismatch';
  if (input.next === input.current) return 'err_password_same';
  return null;
}

export function signUpProblem(email: string, password: string): ErrorKey | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'err_invalid_input';
  if (password.length < PASSWORD_MIN) return 'err_weak_password';
  if (password.length > PASSWORD_MAX) return 'err_password_long';
  return null;
}
