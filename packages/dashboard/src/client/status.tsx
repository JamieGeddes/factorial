'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** The status bar's facts (`/api/status`), read every 30 seconds. */
export interface StatusBar {
  version?: { sha: string; url?: string };
  runtimes: { name: string; role: string; version?: string }[];
  region: string;
  busRate?: number;
  alarms?: { total: number; firing: string[] };
  counts?: { running: number; waiting: number };
  errors: string[];
}

const StatusContext = createContext<StatusBar | undefined>(undefined);

export function StatusProvider({ children, initial }: { children: ReactNode; initial?: StatusBar }) {
  const [status, setStatus] = useState<StatusBar | undefined>(initial);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (response.ok && !stopped) setStatus((await response.json()) as StatusBar);
      } catch {
        // The next read tries again.
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusBar | undefined {
  return useContext(StatusContext);
}
