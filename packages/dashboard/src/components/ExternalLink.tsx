import type { ReactNode } from 'react';

/**
 * `children` linked, in a new tab, to a URL the app built itself
 * (`lib/links.ts`); plain text without one. Never pass a URL from a record.
 */
export function ExternalLink({ url, className, children }: { url?: string | undefined; className?: string; children: ReactNode }) {
  return url ? (
    <a href={url} className={className} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}
