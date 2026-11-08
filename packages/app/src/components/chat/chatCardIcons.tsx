// Small line icons for the agent cards (tool kind, state marks, chevron). Drawn on a 16px grid in the current ink.
import type { ReactNode } from 'react';
import type { ToolKind } from '../../lib/chatToolKinds';

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

const KIND_PATHS: Record<ToolKind, ReactNode> = {
  read: <path d="M4 1.8h5l3 3v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM9 1.8v3h3M5.5 8h5M5.5 10.5h5" />,
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14" />,
  edit: <path d="M10.5 2.5l3 3L5.5 13.5l-3.5.5.5-3.5zM9 4l3 3" />,
  write: <path d="M4 1.8h5l3 3v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM8 7v4M6 9h4" />,
  run: <path d="M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM4.5 6.5l2 1.5-2 1.5M8 10h3" />,
  web: <path d="M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4zM1.8 8h12.4M8 1.8c1.8 1.8 2.6 3.9 2.6 6.2S9.8 12.4 8 14.2C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.8z" />,
  helper: <path d="M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 7.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM2 13c0-2 1.6-3.4 3.5-3.4S9 11 9 13M10 10c1.9 0 4 .9 4 3" />,
  other: <path d="M10.5 2.5a3.5 3.5 0 0 0-3.2 4.8L2.7 11.9a1.2 1.2 0 0 0 1.7 1.7L9 9a3.5 3.5 0 0 0 4.8-3.2L11.6 8 9.5 7.5 9 5.4z" />,
};

export function KindIcon({ kind }: { kind: ToolKind }) {
  return <Svg>{KIND_PATHS[kind]}</Svg>;
}

export function CheckIcon() {
  return (
    <Svg className="ck-agc-check">
      <path d="M3.5 8.5l3 3 6-7" />
    </Svg>
  );
}

export function CrossIcon() {
  return (
    <Svg className="ck-agc-cross">
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function ListIcon() {
  return (
    <Svg>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
    </Svg>
  );
}

export function Chevron() {
  return (
    <Svg className="ck-agc-chev">
      <path d="M4 6l4 4 4-4" />
    </Svg>
  );
}

/** A small ring that turns: the live mark of a step that is running. */
export function SpinMark() {
  return <span className="ck-agc-spin" aria-hidden="true" />;
}

export function PendingMark() {
  return <span className="ck-agc-dot" aria-hidden="true" />;
}
