/**
 * What a guest handler sends back after validating a database answer with a core parser.
 * The guest pages run the SAME parser again on what they receive, and those parsers read the database's own
 * (snake_case) keys, so a successful answer must travel as the database wrote it, not in the parser's camelCase
 * shape. A refusal (`{ ok: false, error }`) has the same keys on both sides and is sent as parsed.
 */
export function wire(parsed: unknown, raw: unknown): unknown {
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) return parsed;
  return raw;
}
