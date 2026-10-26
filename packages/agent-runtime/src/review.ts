/**
 * The reviewer's review, checked before its run may end. A Stop hook in the
 * host validates /workspace/review.json against the review contract and,
 * while it is missing or invalid, sends the reviewer back with what is wrong,
 * at most MAX_REVIEW_CHECKS times. On the harness, #87's first review read
 * until its step limit and wrote nothing.
 *
 * CollectReview validates the review again and is the gate; this only makes
 * a usable review more likely. The file is the agent's, so it is read as
 * report.ts reads the builder's files: no link followed, regular files only,
 * up to a cap.
 */
import path from 'node:path';

import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { parseReviewJson } from '@factorial/review';

import { readAgentFile } from './report.ts';

export const MAX_REVIEW_CHECKS = 2;
/** CollectReview's limit (packages/orchestration/src/lib/review-files.ts). */
export const MAX_REVIEW_BYTES = 64 * 1024;
/** Validation errors sent back, each cut to ERROR_CHARS, as CollectReview cuts them. */
const MAX_ERRORS = 10;
const ERROR_CHARS = 300;

/** What is wrong with the review, or undefined if it is valid. */
export function reviewErrors(reviewJson: string | undefined): string[] | undefined {
  if (reviewJson === undefined) return ['/workspace/review.json is missing'];
  if (Buffer.byteLength(reviewJson, 'utf8') > MAX_REVIEW_BYTES) return [`/workspace/review.json is over ${MAX_REVIEW_BYTES} bytes`];
  const result = parseReviewJson(reviewJson);
  if (result.ok) return undefined;
  return result.errors.slice(0, MAX_ERRORS).map((e) => `review.json ${e.length > ERROR_CHARS ? `${e.slice(0, ERROR_CHARS)}…` : e}`);
}

function reviewInstruction(errors: string[]): string {
  return [
    'Before you finish, /workspace/review.json must meet the review contract your instructions describe. Fix each problem and write the file again:',
    ...errors.map((e) => `- ${e}`),
  ].join('\n');
}

/** The Stop hook: send the reviewer back while its review is missing or invalid, at most MAX_REVIEW_CHECKS times. */
export function reviewStopHooks(workspace: string, onBlocked: (reason: string) => void): HookCallbackMatcher[] {
  let checks = 0;
  return [
    {
      hooks: [
        async (input: HookInput): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name !== 'Stop' || checks >= MAX_REVIEW_CHECKS) return {};
          // One byte over the cap, so an oversized file is reported as one.
          const errors = reviewErrors(readAgentFile(path.join(workspace, 'review.json'), MAX_REVIEW_BYTES + 1));
          if (errors === undefined) return {};
          checks += 1;
          const reason = reviewInstruction(errors);
          onBlocked(reason);
          return { decision: 'block', reason };
        },
      ],
    },
  ];
}
