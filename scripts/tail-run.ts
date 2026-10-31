/**
 * Watch one agent run live (#194), from its first event, with no gap and no
 * repeat: subscribe to the run's channel, read the catch-up chunks the
 * invoker has stored, and print every event once, in order, until the run
 * ends. Also prints the work item's progress from its own channel.
 *
 * Runs with the caller's own AWS credentials (the usual chain: a profile,
 * SSO, environment variables), which need appsync:EventConnect on the API,
 * appsync:EventSubscribe on the namespace, and s3:ListBucket and s3:GetObject
 * on the work item's artefacts (docs/finding-a-run.md, section 6).
 *
 * Usage: node scripts/tail-run.ts <workItemId> [stage] [round]
 *   stage: build (default) or review; round: 1 (default), 2, ...
 * The API's domain and the bucket come from FACTORIAL_LIVE_HTTP_DOMAIN and
 * FACTORIAL_ARTEFACT_BUCKET, or else from the factorial-orchestration stack's
 * outputs through the aws CLI (cloudformation:DescribeStacks).
 *
 * Everything on the channel is text a model or a tool wrote: it is printed
 * as text, with control and bidirectional characters removed, never
 * interpreted.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client } from '@aws-sdk/client-s3';

import {
  OrderedFeed,
  chunkLines,
  chunkPath,
  connectAuthorization,
  connectProtocols,
  parseEnvelope,
  realtimeDomainOf,
  runChannel,
  subscribeAuthorization,
  workItemChannel,
  type LiveEndpoint,
} from '@factorial/live';

const region = 'eu-west-1';
const stackName = 'factorial-orchestration';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Target {
  workItemId: string;
  stage: string;
  round: number;
}

export function parseArgs(argv: string[]): Target {
  const [workItemId, stage = 'build', round = '1'] = argv;
  if (!workItemId || !UUID.test(workItemId)) throw new Error('usage: node scripts/tail-run.ts <workItemId> [stage] [round]');
  if (!/^[a-z]+$/.test(stage)) throw new Error(`"${stage}" is not a stage (build, review)`);
  const n = Number(round);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${round}" is not a round`);
  return { workItemId, stage, round: n };
}

/** One event as either source gives it. */
export interface FeedItem {
  seq: number;
  at: string;
  event: Record<string, unknown>;
  truncated?: boolean;
}

/** Control characters (newline and tab kept) and bidirectional overrides, which could disguise or reshape what is printed. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function sanitise(text: string): string {
  return text.replace(UNSAFE, '');
}

const oneLine = (text: string, max: number): string => {
  const flat = sanitise(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Prints a run's events, naming the subagent an event came from. */
export class Printer {
  private readonly agents = new Map<string, string>();

  line(item: FeedItem): string | undefined {
    const { event } = item;
    const time = /T(\d{2}:\d{2}:\d{2})/.exec(item.at)?.[1] ?? '--:--:--';
    const agentId = typeof event.agentId === 'string' ? event.agentId : undefined;
    if (event.type === 'subagent.started' && agentId) this.agents.set(agentId, oneLine(str(event.agentType), 40) || 'subagent');
    const who = agentId ? `[${this.agents.get(agentId) ?? 'subagent'}] ` : '';
    const cut = item.truncated ? ' (cut)' : '';
    const text = this.body(event);
    return text === undefined ? undefined : `${time} ${String(item.seq).padStart(5)}  ${who}${text}${cut}`;
  }

  private body(event: Record<string, unknown>): string | undefined {
    switch (event.type) {
      case 'run.started': {
        const harness = event.harness as { name?: unknown; version?: unknown } | undefined;
        const models = Array.isArray(event.models) ? event.models.map((m: { purpose?: unknown; id?: unknown }) => `${str(m.purpose)}=${str(m.id)}`).join(' ') : '';
        return oneLine(`run started: ${str(event.role)} on ${str(harness?.name)} ${str(harness?.version)} ${models}`, 200);
      }
      case 'model.call': {
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        const cost = (event.cost as { usd?: unknown } | undefined)?.usd;
        return oneLine(`model ${str((event.model as { id?: unknown } | undefined)?.id)} in ${num(usage.inputTokens)} (cached ${num(usage.cacheReadInputTokens)}) out ${num(usage.outputTokens)}${typeof cost === 'number' ? ` $${cost.toFixed(4)}` : ''}`, 160);
      }
      case 'text':
        return `${sanitise(str(event.text)).trim()}`;
      case 'reasoning':
        return `thinking: ${oneLine(str(event.text), 160)}`;
      case 'tool.call':
        return `tool ${oneLine(str(event.tool), 40)} ${oneLine(str(event.input), 140)}`;
      case 'tool.result':
        // A result is shown only when it failed: each call stays one line.
        return event.isError === true ? `  ! ${oneLine(str(event.content), 160)}` : undefined;
      case 'subagent.started':
        return `subagent ${oneLine(str(event.agentType), 40)} started`;
      case 'subagent.ended':
        return `subagent ended: ${num(event.toolCalls)} tool calls, ${Math.round(num(event.durationMs) / 1000)} s`;
      case 'context.compacted':
        return `context compacted ${num(event.tokensBefore)} -> ${num(event.tokensAfter)} tokens`;
      case 'model.retry':
        return oneLine(`model call retried (attempt ${num(event.attempt)}): ${str(event.error)}`, 160);
      case 'harness':
        return undefined;
      case 'run.ended': {
        const cost = (event.cost as { usd?: unknown } | undefined)?.usd;
        return oneLine(`run ended: ${str(event.outcome)} (${str(event.reason)}), ${num(event.turns)} turns${typeof cost === 'number' ? `, $${cost.toFixed(4)}` : ''}`, 200);
      }
      default:
        return oneLine(`${str(event.type)}${event.omitted ? ' (too large for the channel)' : ''}`, 80);
    }
  }
}

/** A work item notice from its channel: a stage transition, or the execution's. */
export function noticeLine(message: Record<string, unknown>): string | undefined {
  if (typeof message.transition !== 'string') return undefined;
  const stage = typeof message.stage === 'string' ? message.stage : 'Execution';
  const round = typeof message.round === 'number' ? ` round ${message.round}` : '';
  const status = typeof message.status === 'string' ? ` (${message.status})` : '';
  return oneLine(`== ${stage}${round} ${message.transition}${status}`, 120);
}

/** A data message's events: AppSync sends them as JSON strings, singly or in a list. */
export function dataEvents(message: { event?: unknown }): unknown[] {
  const raw = Array.isArray(message.event) ? message.event : [message.event];
  return raw.flatMap((value) => {
    if (typeof value !== 'string') return value === undefined ? [] : [value];
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      return [];
    }
  });
}

interface Config {
  httpDomain: string;
  bucket: string;
}

function config(): Config {
  let httpDomain = process.env.FACTORIAL_LIVE_HTTP_DOMAIN;
  let bucket = process.env.FACTORIAL_ARTEFACT_BUCKET;
  if (!httpDomain || !bucket) {
    const outputs = JSON.parse(
      execFileSync('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', stackName, '--query', 'Stacks[0].Outputs', '--output', 'json'], { encoding: 'utf8' }),
    ) as Array<{ OutputKey: string; OutputValue: string }>;
    const output = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
    httpDomain ??= output('LiveHttpDomain');
    bucket ??= output('WorkArtefactsBucketName');
  }
  if (!httpDomain || !bucket) throw new Error(`${stackName} has no LiveHttpDomain or WorkArtefactsBucketName output`);
  return { httpDomain, bucket };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const target = parseArgs(process.argv.slice(2));
  const { httpDomain, bucket } = config();
  const endpoint: LiveEndpoint = { httpDomain, region };
  const s3 = new S3Client({ region });
  const feed = new OrderedFeed<FeedItem>();
  const printer = new Printer();
  const runTopic = runChannel(target.workItemId, target.stage, target.round);
  const itemTopic = workItemChannel(target.workItemId);
  let attempt: number | undefined;
  let chunksRead = 0;
  let ended = false;
  let executionOver = false;

  const take = (item: FeedItem) => {
    for (const ready of feed.offer(item.seq, item)) {
      const text = printer.line(ready);
      if (text !== undefined) console.log(text);
      if (ready.event.type === 'run.ended') ended = true;
    }
  };

  /** The latest attempt with artefacts, found by listing the work item's prefix. */
  const findAttempt = async (): Promise<number | undefined> => {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${target.workItemId}/`, Delimiter: '/' }));
    const attempts = (listed.CommonPrefixes ?? []).map((p) => Number(p.Prefix?.split('/')[1])).filter((n) => Number.isInteger(n) && n > 0);
    return attempts.length > 0 ? Math.max(...attempts) : undefined;
  };

  /** Read every chunk not yet read, in order; stops at the first that does not exist yet. */
  const readChunks = async () => {
    attempt ??= await findAttempt();
    if (attempt === undefined) return;
    for (;;) {
      const key = `${target.workItemId}/${attempt}/${chunkPath(target.stage, target.round, chunksRead + 1)}`;
      let text: string;
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        text = (await object.Body?.transformToString()) ?? '';
      } catch (error) {
        if (error instanceof NoSuchKey) return;
        throw error;
      }
      chunksRead += 1;
      for (const line of chunkLines(text)) {
        const { at, seq, ...event } = line;
        take({ seq, at, event });
      }
    }
  };

  const connect = async (): Promise<WebSocket> => {
    const socket = new WebSocket(`wss://${realtimeDomainOf(httpDomain)}/event/realtime`, connectProtocols(await connectAuthorization(endpoint)));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
    socket.addEventListener('message', (message) => {
      void (async () => {
        const data = JSON.parse(String(message.data)) as { type?: string; id?: string; event?: unknown; errors?: unknown };
        if (data.type === 'connection_ack') {
          for (const [id, channel] of [
            ['run', runTopic],
            ['item', itemTopic],
          ] as const) {
            socket.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: await subscribeAuthorization(endpoint, channel) }));
          }
        } else if (data.type === 'subscribe_error' || data.type === 'broadcast_error' || data.type === 'error' || data.type === 'connection_error') {
          console.error(`live feed: ${data.type} ${JSON.stringify(data.errors ?? '')}`);
        } else if (data.type === 'data' && data.id === 'run') {
          for (const value of dataEvents(data)) {
            const envelope = parseEnvelope(JSON.stringify(value));
            if (!envelope) continue;
            attempt ??= envelope.attempt;
            take({ seq: envelope.seq, at: envelope.at, event: envelope.event, ...(envelope.truncated ? { truncated: true } : {}) });
          }
        } else if (data.type === 'data' && data.id === 'item') {
          for (const value of dataEvents(data)) {
            const line = typeof value === 'object' && value !== null ? noticeLine(value as Record<string, unknown>) : undefined;
            if (line) console.log(line);
            const transition = (value as { stage?: unknown; transition?: unknown } | null);
            if (transition && transition.stage === undefined && ['succeeded', 'failed', 'timed-out', 'aborted'].includes(String(transition.transition))) executionOver = true;
          }
        }
      })().catch((error: unknown) => console.error(`live feed: ${error instanceof Error ? error.message : String(error)}`));
    });
    return socket;
  };

  let socket = await connect();
  let closed = false;
  socket.addEventListener('close', () => (closed = true));
  let reconnects = 0;
  // Subscribed first; then the chunks fill in what came before, and are read
  // again while a gap remains, until the run has ended.
  for (let quietRounds = 0; !ended; ) {
    await sleep(chunksRead === 0 ? 2000 : 5000);
    await readChunks();
    if (closed && !ended) {
      if (reconnects >= 5) throw new Error('the live connection closed five times');
      reconnects += 1;
      closed = false;
      socket = await connect();
      socket.addEventListener('close', () => (closed = true));
    }
    // The execution is over and the chunks have nothing more: the run ended without its last event.
    if (executionOver && !feed.gap) quietRounds += 1;
    if (quietRounds >= 3) {
      console.error('the work item ended before this run did');
      socket.close();
      return 1;
    }
  }
  socket.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
