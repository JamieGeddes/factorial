'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * One clock for the page: every elapsed time and the status bar's clock tick
 * from it, once a second; 0 before the page has mounted. A snapshot of the
 * command centre passes `frozenAt`, the moment it was taken, and the clock
 * stands there.
 */
const NowContext = createContext<number>(0);

export function NowProvider({ children, frozenAt }: { children: ReactNode; frozenAt?: number }) {
  // 0 until mounted, on the server and in the first client render alike, so a second ticking over between the two never fails hydration.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (frozenAt !== undefined) {
      setNow(frozenAt);
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozenAt]);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
