import type { Dict } from '@bestie/i18n';
import type { Membership } from './myContext';

/** The role as a person reads it: the built-in roles in the interface language, a role the shop made itself under its own name. */
export function roleDisplay(
  m: Pick<Membership, 'roleBuiltIn' | 'roleName'> | undefined,
  t: Dict,
): string {
  if (!m) return '';
  switch (m.roleBuiltIn) {
    case 'owner':
      return t.roleOwner;
    case 'manager':
      return t.roleManager;
    case 'cashier':
      return t.roleCashier;
    case 'waiter':
      return t.roleWaiter;
    case 'kitchen':
      return t.roleKitchen;
    default:
      return m.roleName;
  }
}
