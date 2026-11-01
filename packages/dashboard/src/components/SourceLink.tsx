import type { WorkItemSummary } from '../lib/work-items.ts';

/**
 * A work item's source: its reference, or with `withLabel` its label and
 * reference, linked to the originating record when the app built a URL for it
 * (`lib/links.ts`), plain text otherwise.
 */
export function SourceLink({ source, withLabel = false }: { source: WorkItemSummary['source']; withLabel?: boolean }) {
  const content = withLabel ? [source.label, source.ref].filter(Boolean).join(' ') : source.ref;
  return source.url ? (
    <a href={source.url} target="_blank" rel="noreferrer noopener">
      {content}
    </a>
  ) : (
    <>{content}</>
  );
}
