/**
 * The reviewer's review, checked before its run may end. A Stop hook in the
 * host validates /workspace/review.json against the review contract and,
 * while it is missing or invalid, sends the reviewer back with what is wrong,
 * at most MAX_REVIEW_CHECKS times. On the harness, #87's first review read
 * until its step limit and wrote nothing.
 *
 * The hook also sends a valid review back once when it rests on fewer than
 * MIN_REVIEW_READS tool calls. On #147, #149 and #150 the Runtime reviewer
 * read the diff in one command, wrote review.json and stopped, with the
 * prompt's instruction to read further (#151) or without it. The send-back
 * is once only and sets no minimum, so a review of a trivial change still
 * ends after one more turn.
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
/** Tool calls, other than writing the review, below which a valid review is sent back once to read further. */
export const MIN_REVIEW_READS = 5;
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

export const READ_FURTHER = [
  'Before you finish: your review rests on very little reading. Do steps 3 to 5 now.',
  '- Open the code that calls or uses what changed (git grep for the changed names) and the tests that cover it.',
  '- For a data, configuration or contract file, open its schema and the code that reads it.',
  'Then rewrite /workspace/review.json with anything you find. If you have already checked these, reply in one line and finish.',
].join('\n');

/** Counts the reviewer's completed tool calls other than writing the review: what its review rests on. */
export interface ReviewReads {
  count: number;
}

/** The PostToolUse hook that counts. A call the PreToolUse hook refused never completes, so it is not counted. */
export function reviewReadHooks(workspace: string, reads: ReviewReads): HookCallbackMatcher[] {
  const file = path.join(workspace, 'review.json');
  return [
    {
      hooks: [
        async (input: HookInput): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name !== 'PostToolUse') return {};
          const target = (input.tool_input as { file_path?: unknown } | null)?.file_path;
          const writesReview = (input.tool_name === 'Write' || input.tool_name === 'Edit') && typeof target === 'string' && path.resolve(workspace, target) === file;
          if (!writesReview) reads.count += 1;
          return {};
        },
      ],
    },
  ];
}

/**
 * The Stop hook: send the reviewer back while its review is missing or
 * invalid, at most MAX_REVIEW_CHECKS times, then once more if the valid
 * review rests on fewer than MIN_REVIEW_READS tool calls.
 */
export function reviewStopHooks(workspace: string, reads: ReviewReads, onBlocked: (reason: string) => void): HookCallbackMatcher[] {
  let checks = 0;
  let sentToRead = false;
  return [
    {
      hooks: [
        async (input: HookInput): Promise<SyncHookJSONOutput> => {
          if (input.hook_event_name !== 'Stop') return {};
          // One byte over the cap, so an oversized file is reported as one.
          const errors = reviewErrors(readAgentFile(path.join(workspace, 'review.json'), MAX_REVIEW_BYTES + 1));
          let reason: string | undefined;
          if (errors !== undefined) {
            if (checks >= MAX_REVIEW_CHECKS) return {};
            checks += 1;
            reason = reviewInstruction(errors);
          } else if (!sentToRead && reads.count < MIN_REVIEW_READS) {
            sentToRead = true;
            reason = READ_FURTHER;
          }
          if (reason === undefined) return {};
          onBlocked(reason);
          return { decision: 'block', reason };
        },
      ],
    },
  ];
}
