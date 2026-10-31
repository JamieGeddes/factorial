'use client';

import { createContext, useCallback, useContext, useState, type MouseEvent, type ReactNode } from 'react';

/** One tooltip for the page, placed by the pointer and kept on screen; its content is React nodes, so text stays text. */
interface Tip {
  show(event: MouseEvent, content: ReactNode): void;
  move(event: MouseEvent): void;
  hide(): void;
}

const TipContext = createContext<Tip>({ show() {}, move() {}, hide() {} });

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | undefined>();
  const place = (event: MouseEvent) => {
    const w = 260;
    const h = 80;
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - 10;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - 10;
    return { x, y };
  };
  const show = useCallback((event: MouseEvent, content: ReactNode) => setTip({ ...place(event), content }), []);
  const move = useCallback((event: MouseEvent) => setTip((t) => (t ? { ...t, ...place(event) } : t)), []);
  const hide = useCallback(() => setTip(undefined), []);
  return (
    <TipContext.Provider value={{ show, move, hide }}>
      {children}
      <div className="tooltip" role="tooltip" style={tip ? { display: 'block', left: tip.x, top: tip.y } : undefined}>
        {tip?.content}
      </div>
    </TipContext.Provider>
  );
}

export function useTooltip(): Tip {
  return useContext(TipContext);
}

/** A tooltip's colour key and line. */
export function TipLine({ color, name, value }: { color?: string; name: string; value: string }) {
  return (
    <div>
      {color ? <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6 }} /> : null}
      {name}: <span className="num">{value}</span>
    </div>
  );
}
