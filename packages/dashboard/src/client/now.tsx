'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** One clock for the page: every elapsed time and the status bar's clock tick from it, once a second; 0 before the page has mounted. */
const NowContext = createContext<number>(0);

export function NowProvider({ children }: { children: ReactNode }) {
  // 0 until mounted, on the server and in the first client render alike, so a second ticking over between the two never fails hydration.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
