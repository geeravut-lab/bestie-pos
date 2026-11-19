import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptCode, CameraScan, SAME_CODE_MS } from './CameraScan';
import { mountEn } from './testKit';

afterEach(cleanup);

describe('acceptCode', () => {
  it('ignores empty codes and the same code seen again a moment later', () => {
    expect(acceptCode('  ', null, 0)).toBe(false);
    expect(acceptCode('ABC1234', null, 0)).toBe(true);
    expect(acceptCode('ABC1234', { code: 'ABC1234', at: 0 }, SAME_CODE_MS - 1)).toBe(false);
    expect(acceptCode('ABC1234', { code: 'ABC1234', at: 0 }, SAME_CODE_MS + 1)).toBe(true);
    expect(acceptCode('XYZ9999', { code: 'ABC1234', at: 0 }, 10)).toBe(true);
  });
});

describe('<CameraScan>', () => {
  it('says so where the browser has no BarcodeDetector (no button that cannot work)', () => {
    mountEn(<CameraScan onCode={() => {}} />);
    expect(screen.getByText(/cannot scan with the camera/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan with the camera' })).toBeNull();
  });
});
