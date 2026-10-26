/**
 * The reviewer's review, checked before its run may end. A Stop hook in the
 * host validates /workspace/review.json against the review contract and,
 * while it is missing or invalid, sends the reviewer back with what is wrong,
 * at most MAX_REVIEW_CHECKS times. On the harness, #87's first review read
 * until its step limit and wrote nothing.
 *
 * The first valid review is always sent back once for a second pass: check
 * the callers, the tests and, for a data or configuration file, its schema
 * and the code that reads it, then update the review or confirm it. On #147,
 * #149 and #150 the Runtime reviewer read the diff in one command, wrote
 * review.json and stopped, with the prompt's instruction to read further
 * (#151) or without it: a valid review was its end of the job. The second
 * pass is a fixed step, not a judgement of how much was read, so it costs
 * one more turn on every review, and a reviewer that has already checked
 * these confirms in one line.
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

export const SECOND_PASS = [
  'Before you finish, make one more pass over the change. Check what the diff alone cannot show:',
  '- the code that calls or uses what changed (git grep for the changed names) and the tests that cover it;',
  '- for a data, configuration or contract file, its schema and the code that reads it.',
  'Then rewrite /workspace/review.json with anything you find. If you have already checked these, reply in one line saying so and finish.',
].join('\n');

/**
 * The Stop hook: send the reviewer back while its review is missing or
 * invalid, at most MAX_REVIEW_CHECKS times, and send the first valid review
 * back once for the second pass.
 */
export function reviewStopHooks(workspace: string, onBlocked: (reason: string) => void): HookCallbackMatcher[] {
  let checks = 0;
  let secondPass = false;
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
          } else if (!secondPass) {
            secondPass = true;
            reason = SECOND_PASS;
          }
          if (reason === undefined) return {};
          onBlocked(reason);
          return { decision: 'block', reason };
        },
      ],
    },
  ];
}
