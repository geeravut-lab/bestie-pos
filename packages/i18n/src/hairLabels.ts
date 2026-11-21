import type { Dict } from './dict';

export type HairLabelsLike = {
  length: string | null;
  texture: string | null;
  thickness: string | null;
  colored: boolean | null;
  condition: string | null;
};

/** The labels an AI read from a hair photo, as one short line in the reader's language ("long, wavy, fine strands, coloured hair"). */
export function hairLabelsText(t: Dict, l: HairLabelsLike): string {
  const w = t as unknown as Record<string, string>;
  const parts: (string | undefined)[] = [
    l.length ? w[`hair_${l.length}`] : undefined,
    l.texture ? w[`hair_${l.texture}`] : undefined,
    l.thickness ? w[`hairAi_thickness_${l.thickness}`] : undefined,
    l.colored === null ? undefined : w[`hairAi_colored_${l.colored}`],
    l.condition ? w[`hairAi_condition_${l.condition}`] : undefined,
  ];
  return parts.filter((x): x is string => !!x).join(', ');
}
