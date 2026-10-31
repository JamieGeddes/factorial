import './globals.css';

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { LiveProvider } from '../client/live.tsx';
import { NowProvider } from '../client/now.tsx';
import { StatusProvider } from '../client/status.tsx';
import { TooltipProvider } from '../components/charts/Tooltip.tsx';
import { Rail } from '../components/shell/Rail.tsx';
import { TopBar } from '../components/shell/TopBar.tsx';

export const metadata: Metadata = { title: 'Factorial Command Centre' };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read so every page is rendered per request: Next.js puts the CSP nonce on its scripts from the request.
  await headers();
  return (
    <html lang="en-GB">
      <body>
        <NowProvider>
          <StatusProvider>
            <LiveProvider>
              <TooltipProvider>
                <div className="shell">
                  <Rail />
                  <TopBar />
                  <main id="main">{children}</main>
                </div>
              </TooltipProvider>
            </LiveProvider>
          </StatusProvider>
        </NowProvider>
      </body>
    </html>
  );
}
