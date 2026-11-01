import type { WorkItemSummary } from '../lib/work-items.ts';
import { ExternalLink } from './ExternalLink.tsx';

/**
 * A work item's source: its reference, or with `withLabel` its label and
 * reference, linked to the originating record when the app built a URL for it
 * (`lib/links.ts`), plain text otherwise.
 */
export function SourceLink({ source, withLabel = false }: { source: WorkItemSummary['source']; withLabel?: boolean }) {
  return <ExternalLink url={source.url}>{withLabel ? [source.label, source.ref].filter(Boolean).join(' ') : source.ref}</ExternalLink>;
}

/** A work item's pull request, `PR #<n>` or with `label` that text, linked when the app built its URL. */
export function PullRequestLink({ pullRequest, label, className }: { pullRequest: NonNullable<WorkItemSummary['pullRequest']>; label?: string; className?: string }) {
  return (
    <ExternalLink url={pullRequest.url} {...(className ? { className } : {})}>
      {label ?? `PR #${pullRequest.number}`}
    </ExternalLink>
  );
}
