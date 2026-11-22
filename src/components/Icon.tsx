import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
  info: <><circle cx="12" cy="12" r="10"/><path d="M12 11v5m0-9h.01"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  'arrow-right': <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
  'chart-no-axes-combined': <><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 6-7"/><path d="M17 7h4v4"/></>,
  'check-circle': <><circle cx="12" cy="12" r="10"/><path d="m7 12 3 3 7-7"/></>,
  'alert-circle': <><circle cx="12" cy="12" r="10"/><path d="M12 7v6m0 4h.01"/></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
  key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2"/></>,
  wallet: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18m-5 5h.01"/></>,
  download: <><path d="M12 4v11m-5-5 5 5 5-5"/><path d="M4 18v2h16v-2"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  'eye-off': <><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3.1 4.1M6.2 6.2C3.5 8 2 12 2 12s3.5 7 10 7c1.2 0 2.3-.3 3.3-.7"/></>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6"/><path d="M10 11v5m4-5v5"/></>,
  'trash-2': <><path d="M3 6h18M8 6V4h8v2m3 2-.9 14H5.9L5 6"/><path d="M10 11v5m4-5v5"/></>,
  'file-check': <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 14l2.5 2.5L16 11"/></>,
  'refresh-cw': <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.4 15"/></>,
  alert: <><path d="M12 3 2.8 19a1.5 1.5 0 0 0 1.3 2.2h15.8a1.5 1.5 0 0 0 1.3-2.2L12 3Z"/><path d="M12 9v4m0 3h.01"/></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></>,
  'list-checks': <><path d="m3 6 2 2 3-3M11 6h10M3 12l2 2 3-3m3 1h10M3 18l2 2 3-3m3 1h10"/></>,
  'file-text': <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  'chevron-left': <path d="m15 18-6-6 6-6"/>,
  fingerprint: <><path d="M12 11a2 2 0 0 0-2 2c0 2.5-.3 5-1 7"/><path d="M14 13c0 3.5-.5 6.2-1.5 8"/><path d="M8.5 17c-.3 1.5-.7 2.7-1.2 3.8M6 14v-1a6 6 0 0 1 12 0c0 1.1-.1 2.7-.3 4"/><path d="M4 13a8 8 0 0 1 16 0c0 .6 0 1.3-.1 2"/><path d="M12 3a10 10 0 0 1 10 10"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>,
  moon: <path d="M20.9 13A8.5 8.5 0 0 1 11 3.1 8.6 8.6 0 1 0 20.9 13Z"/>,
};

export default function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
