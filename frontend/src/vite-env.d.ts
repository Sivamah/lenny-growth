/// <reference types="vite/client" />

// Node-style env access is only used by the plain-Node live-check harness
// (tsx); the browser path reads VITE_* via import.meta.env instead.
declare const process: {
  env?: Record<string, string>;
  exit: (code?: number) => never;
} | undefined;