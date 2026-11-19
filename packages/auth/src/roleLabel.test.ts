import { describe, expect, it } from 'vitest';
import { dict } from '@bestie/i18n';
import { roleDisplay } from './roleLabel';

describe('roleDisplay', () => {
  it('names the built-in roles in the interface language', () => {
    expect(roleDisplay({ roleBuiltIn: 'cashier', roleName: 'Cashier' }, dict.th)).toBe('แคชเชียร์');
    expect(roleDisplay({ roleBuiltIn: 'cashier', roleName: 'Cashier' }, dict.en)).toBe('Cashier');
    expect(roleDisplay({ roleBuiltIn: 'owner', roleName: 'Owner' }, dict.en)).toBe('Owner');
    expect(roleDisplay({ roleBuiltIn: 'kitchen', roleName: 'Kitchen' }, dict.th)).toBe(
      dict.th.roleKitchen,
    );
  });
  it('a role the shop made itself shows under its own name', () => {
    expect(roleDisplay({ roleBuiltIn: null, roleName: 'Stock keeper' }, dict.en)).toBe(
      'Stock keeper',
    );
  });
  it('nothing for nobody', () => {
    expect(roleDisplay(undefined, dict.en)).toBe('');
  });
});
