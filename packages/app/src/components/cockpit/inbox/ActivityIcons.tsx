// Small icons for the Inbox's "Team activity" rows and the "Nothing needs you" line. 16px grid, stroke only, colour = currentColor.
const base = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const IconTick = ({ size = 13 }: { size?: number }) => (
  <svg {...base} width={size} height={size} strokeWidth={2.2}>
    <path d="M3.5 8.5 6.6 11.5 12.5 4.8" />
  </svg>
);
export const IconPullRequest = () => (
  <svg {...base}>
    <circle cx="4.5" cy="3.8" r="1.6" />
    <circle cx="4.5" cy="12.2" r="1.6" />
    <circle cx="11.5" cy="12.2" r="1.6" />
    <path d="M4.5 5.4v5.2M11.5 10.6V6.5a2 2 0 0 0-2-2H8" />
  </svg>
);
export const IconPush = () => (
  <svg {...base}>
    <path d="M8 13V3.5M4.2 7.2 8 3.5l3.8 3.7" />
  </svg>
);
export const IconLend = () => (
  <svg {...base}>
    <path d="M2.5 6h9l-2.2-2.3M13.5 10h-9l2.2 2.3" />
  </svg>
);
export const IconAlert = () => (
  <svg {...base}>
    <path d="M8 3 14 13H2L8 3ZM8 7v3M8 11.6v.1" />
  </svg>
);
export const IconNoteSmall = () => (
  <svg {...base}>
    <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />
  </svg>
);
