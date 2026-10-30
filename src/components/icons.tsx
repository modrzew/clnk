import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ArchiveIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M2.75 6.25v6a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-6M6.5 9h3" />
    </Icon>
  );
}

export function UnarchiveIcon() {
  return (
    <Icon>
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M2.75 6.25v6a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-6M8 11.5V8.25M6.5 9.75 8 8.25l1.5 1.5" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <path d="M2 4.5h7M12.5 4.5H14M2 11.5h1.5M7 11.5h7" />
      <circle cx="10.75" cy="4.5" r="1.75" />
      <circle cx="5.25" cy="11.5" r="1.75" />
    </Icon>
  );
}

export function StopIcon() {
  return (
    <Icon>
      <rect
        x="4"
        y="4"
        width="8"
        height="8"
        rx="1.5"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  );
}
