'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** One clock for the page: every elapsed time and the status bar's clock tick from it, once a second. */
const NowContext = createContext<number>(0);

export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
