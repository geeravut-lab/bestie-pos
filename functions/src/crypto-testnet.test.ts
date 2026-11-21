import { describe, expect, it, vi } from 'vitest';
import { chainFor } from './crypto-handler.js';

describe('pointing the chain readers at a test network', () => {
  const seen: string[] = [];
  const f = vi.fn(async (url: unknown) => {
    seen.push(String(url));
    return Response.json({ data: [], result: [], status: '1' });
  }) as unknown as typeof fetch;
  const read = async (net: 'tron' | 'ethereum', env: Record<string, string>) => {
    seen.length = 0;
    const c = chainFor(env, {}, net, f)!;
    await c.incoming({ address: 'TXabc', contract: 'TXdef', sinceMs: 0 }).catch(() => {});
    return seen[0] ?? '';
  };
  it('uses the mainnet addresses when nothing is set', async () => {
    expect(await read('tron', { TRONGRID_API_KEY: 'k' })).toContain(
      'https://api.trongrid.io/v1/accounts/',
    );
    const eth = await read('ethereum', { ETHERSCAN_API_KEY: 'k' });
    expect(eth).toContain('https://api.etherscan.io/v2/api?module=account');
    expect(eth).toContain('&chainid=1&');
  });
  it('uses Shasta / Sepolia when the base address variables are set', async () => {
    expect(
      await read('tron', {
        TRONGRID_API_KEY: 'k',
        TRONGRID_BASE_URL: 'https://api.shasta.trongrid.io/',
      }),
    ).toContain('https://api.shasta.trongrid.io/v1/accounts/');
    expect(
      await read('ethereum', {
        ETHERSCAN_API_KEY: 'k',
        ETHERSCAN_BASE_URL: 'https://api-sepolia.etherscan.io/api',
      }),
    ).toContain('https://api-sepolia.etherscan.io/api?module=account');
    // Etherscan V2: one address, the chain named by chainid (Sepolia = 11155111)
    const v2 = await read('ethereum', { ETHERSCAN_API_KEY: 'k', ETHERSCAN_CHAIN_ID: '11155111' });
    expect(v2).toContain('https://api.etherscan.io/v2/api?module=account');
    expect(v2).toContain('&chainid=11155111&');
    expect(await read('ethereum', { ETHERSCAN_API_KEY: 'k', ETHERSCAN_CHAIN_ID: 'abc' })).toContain(
      '&chainid=1&',
    );
  });
  it('ignores a base address that is not https', async () => {
    expect(
      await read('tron', { TRONGRID_API_KEY: 'k', TRONGRID_BASE_URL: 'http://evil.example' }),
    ).toContain('https://api.trongrid.io/');
    expect(
      await read('tron', { TRONGRID_API_KEY: 'k', TRONGRID_BASE_URL: 'https://evil.example/?x=1' }),
    ).toContain('https://api.trongrid.io/');
  });
  it('Ethereum needs its key', () => {
    expect(chainFor({}, {}, 'ethereum', f)).toBeNull();
  });
});
