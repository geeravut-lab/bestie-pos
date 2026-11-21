/**
 * Reads incoming USDT transfers of OUR receiving addresses. Read-only: no key, no signing, no sending.
 * ⚠️ Request / response shapes follow the providers' public documentation as known on 2026-11-18 and have NOT been run
 * against the live services from the build sandbox: test on testnet (Shasta / Sepolia) and with real keys before enabling.
 */
export type ChainTransfer = {
  network: 'tron' | 'ethereum';
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  units: number;
  blockTimeMs: number;
  confirmations: number;
  success: boolean;
};

export type ChainClient = {
  /** Transfers of `token` INTO `address` since `sinceMs` (block time). */
  incoming: (p: { address: string; contract: string; sinceMs: number }) => Promise<ChainTransfer[]>;
};

const j = async (f: typeof fetch, url: string, init?: RequestInit): Promise<unknown> => {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`chain provider answered ${res.status}`);
  return res.json();
};

/** Tron: TronGrid TRC-20 history + the SOLIDITY node for finality (a transaction found there has ~20 confirmations). */
export function tronClient(opts: {
  apiKey?: string;
  baseUrl?: string;
  f?: typeof fetch;
}): ChainClient {
  const f = opts.f ?? fetch;
  const base = opts.baseUrl ?? 'https://api.trongrid.io';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.apiKey) headers['TRON-PRO-API-KEY'] = opts.apiKey;
  return {
    incoming: async ({ address, contract, sinceMs }) => {
      const url = `${base}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?only_to=true&only_confirmed=false&limit=200&order_by=block_timestamp,asc&contract_address=${encodeURIComponent(contract)}&min_timestamp=${Math.max(0, sinceMs - 60_000)}`;
      const body = (await j(f, url, { headers })) as { data?: Record<string, unknown>[] };
      const out: ChainTransfer[] = [];
      for (const t of body.data ?? []) {
        const txHash = String(t.transaction_id ?? '');
        const units = Number(t.value);
        const to = String(t.to ?? '');
        if (!txHash || !Number.isSafeInteger(units) || units <= 0 || to !== address) continue;
        // finality: ask the solidity node whether it has the transaction
        let final: boolean;
        try {
          const info = (await j(f, `${base}/walletsolidity/gettransactioninfobyid`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: txHash }),
          })) as { blockNumber?: number; receipt?: { result?: string } };
          final = typeof info.blockNumber === 'number';
          if (final && info.receipt?.result && info.receipt.result !== 'SUCCESS') {
            out.push({
              network: 'tron',
              txHash,
              logIndex: 0,
              from: String(t.from ?? ''),
              to,
              units,
              blockTimeMs: Number(t.block_timestamp) || 0,
              confirmations: 0,
              success: false,
            });
            continue;
          }
        } catch {
          final = false; // try again on the next poll
        }
        out.push({
          network: 'tron',
          txHash,
          logIndex: 0,
          from: String(t.from ?? ''),
          to,
          units,
          blockTimeMs: Number(t.block_timestamp) || 0,
          confirmations: final ? 20 : 0,
          success: true,
        });
      }
      return out;
    },
  };
}

/** Ethereum: Etherscan token-transfer history (each row carries its own `confirmations`). Successful transactions only. */
export function ethereumClient(opts: {
  apiKey: string;
  baseUrl?: string;
  /** Etherscan API V2 serves every chain from one address and names the chain in `chainid` (1 = mainnet, 11155111 = Sepolia). */
  chainId?: number;
  f?: typeof fetch;
}): ChainClient {
  const f = opts.f ?? fetch;
  const base = opts.baseUrl ?? 'https://api.etherscan.io/v2/api';
  const chain = base.includes('/v2/') ? `&chainid=${opts.chainId ?? 1}` : '';
  return {
    incoming: async ({ address, contract }) => {
      const url = `${base}?module=account&action=tokentx&contractaddress=${encodeURIComponent(contract)}&address=${encodeURIComponent(address)}&page=1&offset=100&sort=desc${chain}&apikey=${encodeURIComponent(opts.apiKey)}`;
      const body = (await j(f, url)) as { status?: string; result?: unknown };
      const rows = Array.isArray(body.result) ? (body.result as Record<string, string>[]) : [];
      const out: ChainTransfer[] = [];
      for (const r of rows) {
        const units = Number(r.value);
        if (
          String(r.to ?? '').toLowerCase() !== address.toLowerCase() ||
          !Number.isSafeInteger(units) ||
          units <= 0
        )
          continue;
        out.push({
          network: 'ethereum',
          txHash: String(r.hash),
          logIndex: Number(r.transactionIndex) || 0,
          from: String(r.from),
          to: String(r.to),
          units,
          blockTimeMs: (Number(r.timeStamp) || 0) * 1000,
          confirmations: Number(r.confirmations) || 0,
          success: true,
        });
      }
      return out;
    },
  };
}
