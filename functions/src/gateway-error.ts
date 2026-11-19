/** A provider refused or failed. `code` is the provider's machine code ("resource_missing", "no_reader" …): safe to log and show as a code. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`gateway ${status} ${code}`);
    this.name = 'GatewayError';
  }
}
