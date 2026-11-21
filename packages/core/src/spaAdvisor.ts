// Spa / yoga advisor: a FIXED rule set in code — closed questions, a safety screen and a ranking of the shop's own services. No AI, nothing
// stored. It never diagnoses and never replaces the therapist; every result tells the guest to ask the therapist. The rules are written to
// common international spa-intake practice and take effect for a shop only after a therapist has read and signed them (`SPA_RULES_VERSION`;
// changing a rule means raising the version, which voids earlier sign-offs). docs/AI-CUSTOMER-ASSISTANT.md, docs/LEGAL-DRAFTS.md.

export const SPA_RULES_VERSION = 1;

/** What a service is, from a closed list the shop ticks on each service. */
export const SPA_TAGS = [
  'thai_massage', // firm stretching and pressure
  'oil_massage', // oil, light to firm
  'aromatherapy', // essential oils
  'foot_massage',
  'head_neck', // head, neck and shoulders
  'hot_compress', // herbal compress / hot stone (heat)
  'scrub', // body scrub / exfoliation
  'facial',
  'yoga_gentle',
  'yoga_flow', // vigorous
  'yoga_restorative',
  'meditation',
] as const;
export type SpaTag = (typeof SPA_TAGS)[number];
export const isSpaTag = (v: unknown): v is SpaTag =>
  typeof v === 'string' && (SPA_TAGS as readonly string[]).includes(v);

export const SPA_GOALS = ['relax', 'pain', 'energy', 'sleep', 'flexibility', 'skin'] as const;
export type SpaGoal = (typeof SPA_GOALS)[number];
export const SPA_PRESSURES = ['light', 'medium', 'firm'] as const;
export type SpaPressure = (typeof SPA_PRESSURES)[number];
export const SPA_AREAS = ['neck_shoulders', 'back', 'legs_feet', 'head', 'full'] as const;
export type SpaArea = (typeof SPA_AREAS)[number];
/** Yes / no health questions; a "yes" never blocks a guest by itself, it only changes what is suggested and what the therapist is asked to check. */
export const SPA_FLAGS = [
  'pregnant',
  'high_bp',
  'heart',
  'diabetes',
  'skin_condition',
  'recent_surgery_injury',
  'fever_infection',
  'blood_thinners',
  'clots',
  'cancer_treatment',
] as const;
export type SpaFlag = (typeof SPA_FLAGS)[number];

export type SpaAnswers = {
  goal: SpaGoal | null;
  pressure: SpaPressure | null;
  areas: SpaArea[];
  flags: SpaFlag[];
};
export const EMPTY_SPA_ANSWERS: SpaAnswers = { goal: null, pressure: null, areas: [], flags: [] };

/** `avoid` = never offered; `ask` = offered only with "ask the therapist first". Anything not listed is fine. */
type Verdict = 'avoid' | 'ask';
export const SPA_RULES: Readonly<Record<SpaFlag, Partial<Record<SpaTag, Verdict>>>> = {
  pregnant: {
    thai_massage: 'avoid',
    hot_compress: 'avoid',
    yoga_flow: 'avoid',
    foot_massage: 'ask',
    aromatherapy: 'ask',
    oil_massage: 'ask',
    scrub: 'ask',
    head_neck: 'ask',
    yoga_gentle: 'ask',
    yoga_restorative: 'ask',
  },
  high_bp: {
    hot_compress: 'avoid',
    yoga_flow: 'avoid',
    thai_massage: 'ask',
    oil_massage: 'ask',
    aromatherapy: 'ask',
  },
  heart: {
    hot_compress: 'avoid',
    yoga_flow: 'avoid',
    thai_massage: 'avoid',
    oil_massage: 'ask',
    aromatherapy: 'ask',
    foot_massage: 'ask',
    head_neck: 'ask',
    yoga_gentle: 'ask',
    yoga_restorative: 'ask',
  },
  diabetes: { foot_massage: 'ask', scrub: 'ask', hot_compress: 'ask', facial: 'ask' },
  skin_condition: {
    scrub: 'avoid',
    facial: 'ask',
    oil_massage: 'ask',
    aromatherapy: 'ask',
    hot_compress: 'ask',
  },
  recent_surgery_injury: {
    thai_massage: 'avoid',
    yoga_flow: 'avoid',
    hot_compress: 'ask',
    oil_massage: 'ask',
    foot_massage: 'ask',
    head_neck: 'ask',
    yoga_gentle: 'ask',
  },
  fever_infection: {
    thai_massage: 'avoid',
    oil_massage: 'avoid',
    aromatherapy: 'avoid',
    foot_massage: 'avoid',
    head_neck: 'avoid',
    hot_compress: 'avoid',
    scrub: 'avoid',
    facial: 'avoid',
    yoga_gentle: 'avoid',
    yoga_flow: 'avoid',
    yoga_restorative: 'avoid',
    meditation: 'ask',
  },
  blood_thinners: {
    thai_massage: 'avoid',
    foot_massage: 'ask',
    oil_massage: 'ask',
    scrub: 'ask',
    hot_compress: 'ask',
  },
  clots: {
    thai_massage: 'avoid',
    foot_massage: 'avoid',
    hot_compress: 'avoid',
    oil_massage: 'ask',
    yoga_flow: 'ask',
  },
  cancer_treatment: {
    thai_massage: 'avoid',
    hot_compress: 'avoid',
    oil_massage: 'ask',
    aromatherapy: 'ask',
    foot_massage: 'ask',
    head_neck: 'ask',
    scrub: 'ask',
    facial: 'ask',
    yoga_gentle: 'ask',
    yoga_flow: 'ask',
    yoga_restorative: 'ask',
  },
};

/** What each goal / area / pressure favours (a score; the order of the picks, never a safety decision). */
const GOAL_TAGS: Readonly<Record<SpaGoal, readonly SpaTag[]>> = {
  relax: ['oil_massage', 'aromatherapy', 'head_neck', 'foot_massage', 'yoga_restorative'],
  pain: ['thai_massage', 'oil_massage', 'hot_compress', 'head_neck'],
  energy: ['yoga_flow', 'thai_massage', 'head_neck', 'foot_massage'],
  sleep: ['aromatherapy', 'yoga_restorative', 'meditation', 'foot_massage', 'head_neck'],
  flexibility: ['thai_massage', 'yoga_gentle', 'yoga_flow', 'yoga_restorative'],
  skin: ['facial', 'scrub', 'aromatherapy'],
};
const AREA_TAGS: Readonly<Record<SpaArea, readonly SpaTag[]>> = {
  neck_shoulders: ['head_neck', 'thai_massage', 'oil_massage'],
  back: ['thai_massage', 'oil_massage', 'hot_compress'],
  legs_feet: ['foot_massage', 'thai_massage', 'oil_massage'],
  head: ['head_neck', 'meditation'],
  full: ['thai_massage', 'oil_massage', 'aromatherapy'],
};
const PRESSURE_TAGS: Readonly<Record<SpaPressure, readonly SpaTag[]>> = {
  light: ['aromatherapy', 'yoga_restorative', 'meditation', 'head_neck'],
  medium: ['oil_massage', 'foot_massage', 'yoga_gentle'],
  firm: ['thai_massage', 'hot_compress', 'yoga_flow'],
};

export type SpaService = { id: string; tags: readonly SpaTag[] };
export type SpaSafety = 'ok' | 'ask' | 'stop';
export type SpaPick = { id: string; score: number; askAbout: SpaFlag[] };
export type SpaAdvice = {
  /** `stop` = nothing is suggested (fever / infection): come back when well; `ask` = some flags need the therapist's check. */
  safety: SpaSafety;
  /** The yes answers the therapist should look at (every flag the guest ticked, in the closed order). */
  flags: SpaFlag[];
  picks: SpaPick[];
};

/** The verdict a flag set gives one tag: avoid beats ask beats nothing. */
export function tagVerdict(flags: readonly SpaFlag[], tag: SpaTag): Verdict | null {
  let v: Verdict | null = null;
  for (const f of flags) {
    const r = SPA_RULES[f][tag];
    if (r === 'avoid') return 'avoid';
    if (r === 'ask') v = 'ask';
  }
  return v;
}

/**
 * Suggest the shop's services. A service is dropped when ANY of its tags is `avoid` for the guest's flags; kept with `askAbout` when any tag is
 * `ask`; a service with no tags is never suggested (the shop has not said what it is). At most `limit` picks, best first.
 */
export function adviseSpa(
  answers: SpaAnswers,
  services: readonly SpaService[],
  limit = 4,
): SpaAdvice {
  const flags = SPA_FLAGS.filter((f) => answers.flags.includes(f));
  if (flags.includes('fever_infection')) return { safety: 'stop', flags, picks: [] };
  const picks: SpaPick[] = [];
  for (const s of services) {
    if (s.tags.length === 0) continue;
    if (s.tags.some((tg) => tagVerdict(flags, tg) === 'avoid')) continue;
    const ask = new Set<SpaFlag>();
    for (const tg of s.tags) for (const f of flags) if (SPA_RULES[f][tg] === 'ask') ask.add(f);
    let score = 0;
    for (const tg of s.tags) {
      if (answers.goal && GOAL_TAGS[answers.goal].includes(tg)) score += 3;
      if (answers.pressure && PRESSURE_TAGS[answers.pressure].includes(tg)) score += 2;
      for (const a of answers.areas) if (AREA_TAGS[a].includes(tg)) score += 1;
    }
    picks.push({ id: s.id, score, askAbout: SPA_FLAGS.filter((f) => ask.has(f)) });
  }
  picks.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const kept = picks.slice(0, limit);
  const needsAsk = flags.length > 0 || kept.some((p) => p.askAbout.length > 0);
  return { safety: needsAsk ? 'ask' : 'ok', flags, picks: kept };
}

/** The tags on a service, read from the database (closed set only). */
export function parseSpaTags(raw: unknown): SpaTag[] {
  return Array.isArray(raw) ? raw.filter(isSpaTag) : [];
}

export type SpaInfo = { enabled: boolean; services: SpaService[] };
/** What `guest_spa_info` returns. */
export function parseSpaInfo(raw: unknown): SpaInfo {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const services = (Array.isArray(o.services) ? o.services : []).flatMap((s): SpaService[] => {
    const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
    return typeof r.id === 'string' ? [{ id: r.id, tags: parseSpaTags(r.tags) }] : [];
  });
  return { enabled: o.enabled === true, services };
}

/** The note put on the booking so the therapist sees what to check (plain English codes, no health detail beyond the closed flags). */
export const spaAdvisorNote = (flags: readonly SpaFlag[]): string =>
  flags.length === 0 ? '' : `Spa advisor: please check ${flags.join(', ')}`;
