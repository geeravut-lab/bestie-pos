import type { ArtId } from './nav';

/** 24×24 stroke icons for nav items. `currentColor` only — colour comes from the surrounding token. */
const PATHS: Record<ArtId | 'more' | 'close' | 'back' | 'bell', string[]> = {
  billing: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 9l6 6M9.5 9.5h.01M14.5 14.5h.01'],
  account: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  home: ['M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  sell: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8v8M8 12h8'],
  tables: ['M3 10a9 4 0 1 0 18 0 9 4 0 0 0-18 0z', 'M12 14v6M8 20h8'],
  queue: [
    'M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z',
    'M9 9h6M9 13h4',
  ],
  orders: ['M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'],
  customers: [
    'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M3 20a6 6 0 0 1 12 0',
    'M17 10a2.5 2.5 0 1 0 0-5',
    'M16.5 14a5 5 0 0 1 4.5 5',
  ],
  shift: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  receipts: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6M9 12h6'],
  takeOrder: ['M4 20h4L18 10l-4-4L4 16z', 'M13 7l4 4'],
  ready: ['M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  kitchen: [
    'M5 10h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z',
    'M3 10h18',
    'M8 6c0-2.5 4-2.5 4 0 0-2.5 4-2.5 4 0',
  ],
  menu: ['M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z', 'M16 10h2a2 2 0 0 1 0 4h-2', 'M8 3v2M12 3v2'],
  stock: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4', 'M12 11v10'],
  staff: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  reports: ['M4 20h16', 'M7 20v-6M12 20V6M17 20v-9'],
  credit: ['M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 7l2-3h12', 'M17 13.5h.01'],
  points: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  modules: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  devices: ['M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M11 18h2'],
  dashboard: ['M4 15a8 8 0 0 1 16 0', 'M12 15l4-4', 'M4 15h2M18 15h2'],
  ai: ['M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z', 'M19 16v4M17 18h4'],
  branding: [
    'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3 3 0 0 0 3-3C20 8 16.5 3 12 3z',
    'M8 11h.01M12 7.5h.01M16 11h.01',
  ],
  flags: ['M7 8h10a4 4 0 0 1 0 8H7A4 4 0 0 1 7 8z', 'M16 12h.01'],
  audit: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  line: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  analytics: ['M3 17l5-6 4 4 8-9', 'M3 21h18'],
  guestMenu: [
    'M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z',
    'M16 10h2a2 2 0 0 1 0 4h-2',
    'M8 3v2M12 3v2',
  ],
  pass: [
    'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    'M9 12h.01',
    'M14 10h4M14 14h3',
  ],
  calendar: [
    'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    'M4 10h16',
    'M8 3v4M16 3v4',
    'M8 14h3M13 14h3M8 17.5h3',
  ],
  folio: ['M3 10l9-6 9 6v10H3z', 'M9 20v-6h6v6', 'M7 10h.01M17 10h.01'],
  translate: ['M4 5h9M8.5 3v2M6 5c0 4 3 7 6 8M11 5c0 3-2 6-6 8', 'M13 21l4-10 4 10M14.5 18h5'],
  waitlist: ['M8 6h13M8 12h13M8 18h13', 'M3 6h.01M3 12h.01M3 18h.01'],
  timeclock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  tours: [
    'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z',
    'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  ],
  stamps: ['M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.4 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z'],
  marketing: ['M3 11v3l12 5V6z', 'M15 8a4 4 0 0 1 0 8', 'M6 14v5'],
  hub: [
    'M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1',
    'M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1',
  ],
  karaoke: [
    'M9 3h6a3 3 0 0 1 3 3v3a6 6 0 0 1-12 0V6a3 3 0 0 1 3-3z',
    'M5 12a7 7 0 0 0 14 0',
    'M12 19v3M8 22h8',
  ],
  book: [
    'M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    'M4 10h16',
    'M8 3v4M16 3v4',
  ],
  pay: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z', 'M14 14h2v2M18 14v6M14 18h2'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  close: ['M6 6l12 12M18 6L6 18'],
  back: ['M15 5l-7 7 7 7'],
  bell: ['M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
};

export function Icon({
  name,
  size = 24,
}: {
  name: ArtId | 'more' | 'close' | 'back' | 'bell';
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
