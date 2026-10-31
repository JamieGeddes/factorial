import 'server-only';

/** The one method of an AWS SDK client the modules use, so tests can stub it. */
export interface Sender {
  send(command: object): Promise<unknown>;
}

/** Factorial runs in one region. */
export const REGION = 'eu-west-1';

/** The command's class name, which stubs answer by. */
export function commandName(command: object): string {
  return command.constructor.name;
}
