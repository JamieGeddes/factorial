/** An AWS SDK client that answers each command by its class name, and records what it was sent. */
export interface StubClient {
  send(command: object): Promise<unknown>;
  calls: { name: string; input: Record<string, unknown> }[];
}

export function stubClient(answers: Record<string, (input: Record<string, unknown>) => unknown>): StubClient {
  const calls: StubClient['calls'] = [];
  return {
    calls,
    async send(command: object) {
      const name = command.constructor.name;
      const input = (command as { input?: Record<string, unknown> }).input ?? {};
      calls.push({ name, input });
      const answer = answers[name];
      if (!answer) throw new Error(`no stub for ${name}`);
      return answer(input);
    },
  };
}

export const ID = '7f93ccb0-d53d-11f1-8851-ff488f20a8b2';
export const ID2 = 'c8db78d0-d53d-11f1-8851-ff488f20a8b2';
