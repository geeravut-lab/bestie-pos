import type { ReactNode } from 'react';
import type { ArtId } from './nav';

/**
 * Flat two-tone illustrations for the role-home cards (160×100). Pure SVG so they stay sharp on every
 * screen and weigh almost nothing. Colours come ONLY from the `il-*` classes in styles.css → theme tokens.
 * An admin-uploaded image (card `imageUrl`) replaces this in <Card>.
 */
type Tone = 'mint' | 'sky' | 'sun' | 'accent';

const SCENES: Record<ArtId, { tone: Tone; art: ReactNode }> = {
  sell: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-white il-edge" x="50" y="14" width="52" height="72" rx="9" />
        <rect className="il-brand" x="57" y="23" width="38" height="24" rx="5" />
        <rect className="il-primary" x="57" y="55" width="38" height="10" rx="5" />
        <rect className="il-line-fill" x="57" y="71" width="24" height="5" rx="2.5" />
        <circle className="il-sun il-edge" cx="116" cy="34" r="15" />
        <circle className="il-white" cx="116" cy="34" r="8" />
        <path
          className="il-spark"
          d="M132 62l2.5 5.5 5.5 2.5-5.5 2.5-2.5 5.5-2.5-5.5-5.5-2.5 5.5-2.5z"
        />
      </>
    ),
  },
  tables: {
    tone: 'sun',
    art: (
      <>
        <ellipse className="il-shadow" cx="80" cy="82" rx="42" ry="6" />
        <ellipse className="il-white il-edge" cx="80" cy="46" rx="38" ry="16" />
        <path className="il-edge-line" d="M80 62v20M68 82h24" />
        <circle className="il-accent il-edge" cx="30" cy="58" r="10" />
        <circle className="il-accent il-edge" cx="130" cy="58" r="10" />
        <circle className="il-brand" cx="64" cy="42" r="5" />
        <circle className="il-sun" cx="96" cy="42" r="5" />
      </>
    ),
  },
  queue: {
    tone: 'sky',
    art: (
      <>
        <path
          className="il-white il-edge"
          d="M30 30a6 6 0 0 1 6-6h88a6 6 0 0 1 6 6v10a8 8 0 0 0 0 16v10a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6V56a8 8 0 0 0 0-16z"
        />
        <rect className="il-brand" x="44" y="36" width="36" height="28" rx="6" />
        <rect className="il-line-fill" x="90" y="38" width="28" height="6" rx="3" />
        <rect className="il-line-fill" x="90" y="52" width="20" height="6" rx="3" />
        <path
          className="il-sun il-edge"
          d="M124 16a10 10 0 0 1 10 10v4l4 5H110l4-5v-4a10 10 0 0 1 10-10z"
        />
      </>
    ),
  },
  orders: {
    tone: 'mint',
    art: (
      <>
        <path className="il-white il-edge" d="M44 10h72v80l-12-8-12 8-12-8-12 8-12-8-12 8z" />
        <rect className="il-brand" x="54" y="22" width="30" height="7" rx="3.5" />
        <rect className="il-line-fill" x="54" y="38" width="52" height="6" rx="3" />
        <rect className="il-line-fill" x="54" y="50" width="46" height="6" rx="3" />
        <rect className="il-primary" x="54" y="62" width="30" height="7" rx="3.5" />
        <circle className="il-sun il-edge" cx="124" cy="26" r="11" />
      </>
    ),
  },
  customers: {
    tone: 'sun',
    art: (
      <>
        <circle className="il-accent il-edge" cx="58" cy="40" r="17" />
        <path className="il-accent il-edge" d="M30 86a28 28 0 0 1 56 0z" />
        <circle className="il-brand il-edge" cx="108" cy="44" r="15" />
        <path className="il-brand il-edge" d="M84 86a24 24 0 0 1 48 0z" />
        <path className="il-edge-line" d="M52 42q6 5 12 0M102 46q6 5 12 0" />
      </>
    ),
  },
  shift: {
    tone: 'sky',
    art: (
      <>
        <circle className="il-white il-edge" cx="58" cy="46" r="30" />
        <path className="il-edge-line" d="M58 26v20l12 8" />
        <rect className="il-brand il-edge" x="94" y="52" width="46" height="30" rx="6" />
        <rect className="il-white" x="102" y="62" width="30" height="8" rx="3" />
        <circle className="il-sun il-edge" cx="128" cy="36" r="10" />
      </>
    ),
  },
  receipts: {
    tone: 'sun',
    art: (
      <>
        <path className="il-white il-edge" d="M50 8h60v84l-10-7-10 7-10-7-10 7-10-7z" />
        <rect className="il-line-fill" x="60" y="22" width="40" height="6" rx="3" />
        <rect className="il-line-fill" x="60" y="36" width="40" height="6" rx="3" />
        <rect className="il-primary" x="60" y="50" width="24" height="8" rx="4" />
        <circle className="il-accent il-edge" cx="124" cy="62" r="13" />
        <path className="il-edge-line" d="M118 62l5 5 8-9" />
      </>
    ),
  },
  takeOrder: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-white il-edge" x="42" y="16" width="56" height="70" rx="8" />
        <rect className="il-line-fill" x="52" y="30" width="36" height="6" rx="3" />
        <rect className="il-line-fill" x="52" y="44" width="30" height="6" rx="3" />
        <rect className="il-line-fill" x="52" y="58" width="34" height="6" rx="3" />
        <path className="il-sun il-edge" d="M104 70l8-34 14 5-8 34-10 6z" />
        <path className="il-ink-fill" d="M104 70l-2 12 10-6z" />
      </>
    ),
  },
  ready: {
    tone: 'accent',
    art: (
      <>
        <path
          className="il-sun il-edge"
          d="M80 14a26 26 0 0 1 26 26v16l9 11H45l9-11V40a26 26 0 0 1 26-26z"
        />
        <circle className="il-ink-fill" cx="80" cy="78" r="6" />
        <path className="il-edge-line" d="M30 30q-8 12 0 24M130 30q8 12 0 24" />
        <circle className="il-white il-edge" cx="128" cy="76" r="10" />
        <path className="il-edge-line" d="M123 76l4 4 6-7" />
      </>
    ),
  },
  kitchen: {
    tone: 'accent',
    art: (
      <>
        <path className="il-white il-edge" d="M40 52h80v28a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8z" />
        <rect className="il-brand il-edge" x="34" y="44" width="92" height="12" rx="6" />
        <path
          className="il-white il-edge"
          d="M52 44c-10-2-12-18 2-18 2-10 18-10 22 0 6-4 16 0 14 10 6 2 4 8-2 8z"
        />
        <path className="il-spark" d="M128 22l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      </>
    ),
  },
  menu: {
    tone: 'sun',
    art: (
      <>
        <path
          className="il-white il-edge"
          d="M42 40h56v22a22 22 0 0 1-22 22h-12a22 22 0 0 1-22-22z"
        />
        <path className="il-edge-line" d="M98 48h8a10 10 0 0 1 0 20h-8" />
        <rect className="il-accent" x="42" y="40" width="56" height="10" rx="5" />
        <path className="il-edge-line il-steam" d="M60 30q-5-8 0-14M76 30q-5-8 0-14" />
        <path className="il-sun il-edge" d="M112 74c4-14 22-14 26 0z" />
      </>
    ),
  },
  stock: {
    tone: 'sky',
    art: (
      <>
        <rect className="il-accent il-edge" x="30" y="52" width="46" height="34" rx="5" />
        <rect className="il-brand il-edge" x="84" y="52" width="46" height="34" rx="5" />
        <rect className="il-sun il-edge" x="56" y="16" width="46" height="34" rx="5" />
        <path className="il-edge-line" d="M40 64h26M94 64h26M66 28h26" />
      </>
    ),
  },
  staff: {
    tone: 'mint',
    art: (
      <>
        <circle className="il-sun il-edge" cx="80" cy="30" r="16" />
        <path className="il-brand il-edge" d="M48 90a32 32 0 0 1 64 0z" />
        <path className="il-white il-edge" d="M64 62l16 10 16-10v28H64z" />
        <path className="il-edge-line" d="M74 28q6 5 12 0" />
      </>
    ),
  },
  reports: {
    tone: 'sun',
    art: (
      <>
        <rect className="il-brand il-edge" x="30" y="56" width="20" height="30" rx="4" />
        <rect className="il-primary il-edge" x="58" y="40" width="20" height="46" rx="4" />
        <rect className="il-accent il-edge" x="86" y="26" width="20" height="60" rx="4" />
        <circle className="il-sun il-edge" cx="126" cy="22" r="13" />
        <path className="il-edge-line" d="M24 90h112" />
      </>
    ),
  },
  credit: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-primary il-edge" x="34" y="30" width="92" height="56" rx="10" />
        <path className="il-white il-edge" d="M34 40h82a10 10 0 0 1 10 10v-10" />
        <rect className="il-sun il-edge" x="96" y="52" width="40" height="22" rx="8" />
        <circle className="il-ink-fill" cx="108" cy="63" r="3.5" />
        <path className="il-leaf il-edge" d="M52 30q4-18 22-18-1 16-22 18z" />
      </>
    ),
  },
  points: {
    tone: 'sun',
    art: (
      <>
        <circle className="il-sun il-edge" cx="80" cy="48" r="32" />
        <path
          className="il-white il-edge"
          d="M80 26l6.5 13.5 14.5 2-10.5 10.2 2.5 14.6L80 59.4 67 66.3l2.5-14.6L59 41.5l14.5-2z"
        />
        <path className="il-spark" d="M30 24l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
        <path className="il-spark" d="M128 68l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
      </>
    ),
  },
  modules: {
    tone: 'sky',
    art: (
      <>
        <rect className="il-brand il-edge" x="36" y="18" width="40" height="30" rx="8" />
        <rect className="il-white il-edge" x="84" y="18" width="40" height="30" rx="8" />
        <rect className="il-white il-edge" x="36" y="56" width="40" height="30" rx="8" />
        <rect className="il-sun il-edge" x="84" y="56" width="40" height="30" rx="8" />
        <circle className="il-white" cx="64" cy="33" r="6" />
        <circle className="il-primary" cx="104" cy="71" r="6" />
      </>
    ),
  },
  devices: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-white il-edge" x="40" y="14" width="64" height="72" rx="9" />
        <rect className="il-brand" x="48" y="24" width="48" height="40" rx="5" />
        <circle className="il-line-fill" cx="72" cy="75" r="4" />
        <rect className="il-sun il-edge" x="108" y="46" width="30" height="40" rx="7" />
        <rect className="il-white" x="113" y="53" width="20" height="18" rx="3" />
      </>
    ),
  },
  dashboard: {
    tone: 'sun',
    art: (
      <>
        <path className="il-white il-edge" d="M30 78a50 50 0 0 1 100 0z" />
        <path className="il-brand" d="M42 78a38 38 0 0 1 76 0z" />
        <path className="il-edge-line il-needle" d="M80 78l24-28" />
        <circle className="il-ink-fill" cx="80" cy="78" r="6" />
        <circle className="il-sun il-edge" cx="132" cy="22" r="11" />
      </>
    ),
  },
  ai: {
    tone: 'sky',
    art: (
      <>
        <path
          className="il-white il-edge"
          d="M36 24a10 10 0 0 1 10-10h68a10 10 0 0 1 10 10v36a10 10 0 0 1-10 10H78l-18 16V70H46a10 10 0 0 1-10-10z"
        />
        <path
          className="il-sun il-edge"
          d="M80 26l4.5 11.5L96 42l-11.5 4.5L80 58l-4.5-11.5L64 42l11.5-4.5z"
        />
        <circle className="il-accent" cx="108" cy="30" r="4" />
        <circle className="il-brand" cx="52" cy="56" r="4" />
      </>
    ),
  },
  branding: {
    tone: 'accent',
    art: (
      <>
        <path
          className="il-white il-edge"
          d="M80 12c-32 0-52 22-52 42 0 16 14 30 32 30 8 0 10-6 8-10s0-10 8-10h10c14 0 22-8 22-20C108 24 98 12 80 12z"
        />
        <circle className="il-brand il-edge" cx="54" cy="46" r="8" />
        <circle className="il-sun il-edge" cx="76" cy="32" r="8" />
        <circle className="il-accent il-edge" cx="100" cy="42" r="8" />
        <path className="il-primary il-edge" d="M112 70l24-30 6 5-22 32z" />
      </>
    ),
  },
  flags: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-brand il-edge" x="26" y="22" width="68" height="28" rx="14" />
        <circle className="il-white il-edge" cx="80" cy="36" r="10" />
        <rect className="il-white il-edge" x="66" y="58" width="68" height="28" rx="14" />
        <circle className="il-sun il-edge" cx="80" cy="72" r="10" />
      </>
    ),
  },
  audit: {
    tone: 'sky',
    art: (
      <>
        <path
          className="il-brand il-edge"
          d="M64 10l40 15v30c0 24-17 38-40 43-23-5-40-19-40-43V25z"
        />
        <path className="il-edge-line il-check" d="M46 52l12 12 22-24" />
        <circle className="il-white il-edge" cx="116" cy="64" r="14" />
        <path className="il-edge-line" d="M126 74l12 12" />
      </>
    ),
  },
  line: {
    tone: 'mint',
    art: (
      <>
        <path
          className="il-white il-edge"
          d="M34 20h92a8 8 0 0 1 8 8v36a8 8 0 0 1-8 8H78l-22 18V72H34a8 8 0 0 1-8-8V28a8 8 0 0 1 8-8z"
        />
        <rect className="il-brand" x="44" y="34" width="52" height="7" rx="3.5" />
        <rect className="il-line-fill" x="44" y="48" width="38" height="7" rx="3.5" />
        <circle className="il-accent il-edge" cx="128" cy="22" r="11" />
      </>
    ),
  },
  analytics: {
    tone: 'sun',
    art: (
      <>
        <path className="il-edge-line il-chart" d="M26 74l30-26 22 16 36-40" />
        <circle className="il-accent il-edge" cx="56" cy="48" r="7" />
        <circle className="il-brand il-edge" cx="78" cy="64" r="7" />
        <circle className="il-sun il-edge" cx="114" cy="24" r="9" />
        <path className="il-edge-line" d="M24 88h112" />
      </>
    ),
  },
  guestMenu: {
    tone: 'sun',
    art: (
      <>
        <circle className="il-white il-edge" cx="68" cy="52" r="32" />
        <circle className="il-sun" cx="68" cy="52" r="20" />
        <path className="il-edge-line" d="M112 22v66M106 22v16a6 6 0 0 0 12 0V22" />
        <path className="il-accent il-edge" d="M128 22c8 8 8 30 0 36z" />
      </>
    ),
  },
  pass: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-brand il-edge" x="30" y="22" width="100" height="62" rx="10" />
        <rect className="il-white il-edge" x="40" y="34" width="38" height="38" rx="5" />
        <path
          className="il-ink-fill"
          d="M46 40h10v10H46zM62 40h10v10H62zM46 56h10v10H46zM64 58h6v6h-6z"
        />
        <rect className="il-sun" x="88" y="38" width="30" height="7" rx="3.5" />
        <rect className="il-white" x="88" y="52" width="22" height="7" rx="3.5" />
      </>
    ),
  },
  book: {
    tone: 'sky',
    art: (
      <>
        <rect className="il-white il-edge" x="34" y="20" width="92" height="66" rx="9" />
        <path className="il-accent il-edge" d="M34 29a9 9 0 0 1 9-9h74a9 9 0 0 1 9 9v12H34z" />
        <path className="il-edge-line" d="M54 12v14M106 12v14" />
        <circle className="il-brand" cx="62" cy="58" r="7" />
        <circle className="il-sun il-edge" cx="94" cy="58" r="9" />
        <circle className="il-line-fill" cx="62" cy="76" r="4" />
      </>
    ),
  },
  calendar: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-white il-edge" x="30" y="18" width="100" height="68" rx="9" />
        <path className="il-brand il-edge" d="M30 27a9 9 0 0 1 9-9h82a9 9 0 0 1 9 9v10H30z" />
        <path className="il-edge-line" d="M70 37v49M100 37v49M30 58h100" />
        <rect className="il-sun il-edge" x="36" y="42" width="28" height="12" rx="3" />
        <rect className="il-accent il-edge" x="76" y="62" width="18" height="18" rx="3" />
        <rect className="il-line-fill" x="106" y="44" width="18" height="10" rx="3" />
      </>
    ),
  },
  karaoke: {
    tone: 'sky',
    art: (
      <>
        <rect className="il-white il-edge" x="30" y="46" width="62" height="40" rx="9" />
        <circle className="il-accent il-edge" cx="61" cy="66" r="12" />
        <path className="il-edge-line" d="M52 66h18M61 57v18" />
        <rect className="il-brand il-edge" x="104" y="12" width="26" height="40" rx="13" />
        <path className="il-edge-line" d="M98 40a19 19 0 0 0 38 0M117 59v14M107 73h20" />
        <circle className="il-sun il-edge" cx="40" cy="26" r="8" />
        <path className="il-edge-line" d="M62 24l22-6v14" />
      </>
    ),
  },
  pay: {
    tone: 'mint',
    art: (
      <>
        <rect className="il-white il-edge" x="42" y="12" width="56" height="76" rx="9" />
        <path
          className="il-ink-fill"
          d="M52 22h16v16H52zM72 22h16v16H72zM52 44h16v16H52zM76 48h8v8h-8zM72 66h16v14H72z"
        />
        <circle className="il-sun il-edge" cx="122" cy="44" r="16" />
        <path className="il-edge-line" d="M116 44l5 5 9-10" />
      </>
    ),
  },
  billing: {
    tone: 'sun',
    art: (
      <>
        <path className="il-white il-edge" d="M48 10h64v82l-11-8-11 8-11-8-11 8-11-8-9 6z" />
        <rect className="il-line-fill" x="58" y="22" width="44" height="6" rx="3" />
        <rect className="il-line-fill" x="58" y="34" width="34" height="6" rx="3" />
        <circle className="il-accent il-edge" cx="116" cy="38" r="14" />
        <path className="il-edge-line" d="M110 44l12-12" />
        <circle className="il-sun il-edge" cx="40" cy="64" r="12" />
        <path className="il-edge-line" d="M34 64h12" />
      </>
    ),
  },
  account: {
    tone: 'sky',
    art: (
      <>
        <circle className="il-sun il-edge" cx="80" cy="34" r="17" />
        <path className="il-brand il-edge" d="M44 92a36 36 0 0 1 72 0z" />
        <path className="il-edge-line" d="M73 32q7 6 14 0" />
        <circle className="il-accent il-edge" cx="120" cy="30" r="9" />
      </>
    ),
  },
  home: {
    tone: 'mint',
    art: (
      <>
        <path className="il-white il-edge" d="M36 50L80 14l44 36v36H36z" />
        <rect className="il-brand il-edge" x="66" y="56" width="28" height="30" rx="5" />
        <circle className="il-sun il-edge" cx="126" cy="24" r="11" />
      </>
    ),
  },
};

export function Illustration({ art }: { art: ArtId }) {
  const scene = SCENES[art];
  return (
    <svg
      className="illustration"
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect className={`il-bg il-bg-${scene.tone}`} width="160" height="100" />
      <circle className="il-blob" cx="140" cy="86" r="34" />
      <circle className="il-blob" cx="14" cy="10" r="22" />
      {scene.art}
    </svg>
  );
}
