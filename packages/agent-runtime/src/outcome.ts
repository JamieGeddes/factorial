/**
 * How a run ended, from the SDK's result message. `incomplete` is the rounds
 * path (the orchestrator continues in a fresh session from the branch and the
 * notes), as `max_iterations_exceeded` is for the harness; `failed` saves the
 * work and opens no pull request.
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

export type Outcome = 'complete' | 'incomplete' | 'failed';

export function outcomeOf(subtype: SDKResultMessage['subtype']): Outcome {
  switch (subtype) {
    case 'success':
      return 'complete';
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return 'incomplete';
    case 'error_during_execution':
    case 'error_max_structured_output_retries':
      return 'failed';
  }
}
