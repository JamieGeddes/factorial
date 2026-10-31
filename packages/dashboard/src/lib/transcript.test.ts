import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byteLength, describe, describeShort, formatInput, fromEnvelope, fromTranscriptLine, isPlanWrite, passes, planFromWrite, tallyOf, type RunEvent } from './transcript.ts';

const ev = (seq: number, event: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent => ({ seq, at: '2026-11-01T10:00:00Z', event, ...extra });

test('an envelope and a transcript line become the same event; other lines are not events', () => {
  const event = { type: 'text', text: 'hi' };
  assert.deepEqual(fromEnvelope({ seq: 3, at: 'a', event, truncated: true, bytes: 20000 }), { seq: 3, at: 'a', event, truncated: true, bytes: 20000 });
  assert.equal(fromEnvelope({ seq: 1.5, event }), undefined);
  assert.deepEqual(fromTranscriptLine('{"at":"a","seq":3,"type":"text","text":"hi"}'), { seq: 3, at: 'a', event });
  assert.equal(fromTranscriptLine('{"at":"a","request":{"role":"builder"}}'), undefined);
  assert.deepEqual(fromTranscriptLine('{"truncated":true,"keptEvents":5,"droppedEvents":2}'), { marker: { truncated: true, keptEvents: 5, droppedEvents: 2 } });
  assert.equal(fromTranscriptLine('{torn'), undefined);
});

test('the filters: model text, tools, model calls and subagents', () => {
  const types = ['text', 'reasoning', 'tool.call', 'tool.result', 'model.call', 'model.retry', 'context.compacted', 'subagent.started', 'run.started'];
  const of = (filter: Parameters<typeof passes>[1]) => types.filter((type) => passes({ type }, filter));
  assert.deepEqual(of('text'), ['text', 'reasoning']);
  assert.deepEqual(of('tool'), ['tool.call', 'tool.result']);
  assert.deepEqual(of('model'), ['model.call', 'model.retry', 'context.compacted']);
  assert.deepEqual(of('sub'), ['subagent.started']);
  assert.ok(passes({ type: 'tool.call', agentId: 'a1' }, 'sub'));
  assert.equal(of('all').length, types.length);
});

test('each event type is described as the mockup shows it', () => {
  const agents = new Map([['a1', 'plan']]);
  const d = (event: Record<string, unknown>, extra?: Partial<RunEvent>) => describe(ev(1, event, extra), agents);
  assert.deepEqual(d({ type: 'run.started', harness: { name: 'pi', version: '1.4.0' }, models: [{ purpose: 'main', id: 'claude' }], tools: ['bash', 'read'] }), { kind: 'run started', text: 'pi 1.4.0 · main claude\ntools: bash, read' });
  assert.equal(d({ type: 'run.ended', outcome: 'complete', reason: 'completed', turns: 10, durationMs: 407000, cost: { usd: 0.379 }, deniedToolCalls: 0 }).text, 'outcome complete (completed) · 10 turns · 6m 47s · $0.38 · 0 denied tool calls');
  assert.deepEqual(d({ type: 'text', text: 'abc', agentId: 'a1' }, { truncated: true, bytes: 20480 }), { kind: 'plan · text', text: 'abc', note: 'truncated, 20.0 KB in full' });
  const call = d({ type: 'tool.call', tool: 'bash', input: { command: 'ls\nls -la', timeout: 20 } });
  assert.equal(call.kind, 'bash');
  assert.equal(call.text, 'command: ls');
  assert.equal(call.more?.body, 'command: ls\nls -la\ntimeout: 20');
  const result = d({ type: 'tool.result', content: 'one\ntwo', isError: true });
  assert.equal(result.kind, 'error');
  assert.deepEqual(result.more, { summary: 'one', body: 'one\ntwo', label: '7 B' });
  assert.equal(d({ type: 'tool.result', content: 'short' }).more, undefined);
  assert.equal(d({ type: 'model.call', model: { id: 'm' }, usage: { inputTokens: 23140, outputTokens: 412, cacheReadInputTokens: 18210, cacheWriteInputTokens: 4420 }, durationMs: 4100 }).text, 'm   in 23.1K   cache read 18.2K   cache write 4.4K   out 412   latency 4.1s');
  assert.deepEqual(d({ type: 'model.retry', attempt: 1, maxRetries: 10, delayMs: 2000, status: 429, error: 'Throttling' }), { kind: 'retry 1/10', text: 'HTTP 429 · wait 2000 ms · Throttling' });
  assert.equal(d({ type: 'subagent.ended', agentType: 'plan', agentId: 'a1', durationMs: 94906, toolCalls: 26, finalContextTokens: 39172 }).text, 'plan (a1) · 1m 35s · 26 tool calls · final context 39.2K');
  assert.equal(d({ type: 'context.compacted', trigger: 'auto', tokensBefore: 96400, tokensAfter: 31800 }).text, 'auto · 96.4K → 31.8K tokens');
  assert.deepEqual(d({ type: 'harness', name: 'compaction_summary' }), { kind: 'harness', text: 'compaction_summary' });
  assert.equal(d({ type: 'tool.call', omitted: true }, { truncated: true, bytes: 70000 }).text, 'left out of the live feed: too large for one message');
});

test('a cut tool input is the start of its JSON, shown as it is', () => {
  assert.equal(formatInput('{"path":"/workspace/plan.json","content":"{\\"steps'), '{"path":"/workspace/plan.json","content":"{\\"steps');
  assert.equal(formatInput('{"a":1}'), 'a: 1');
});

test('control and bidirectional characters are removed from what the transcript shows', () => {
  const line = describe(ev(1, { type: 'text', text: 'safe‮\u0007 <img src=x onerror=alert(1)>' }));
  assert.equal(line.text, 'safe <img src=x onerror=alert(1)>');
});

test('the tally sums the calls mid-run and trusts run.ended once it arrives', () => {
  const events = [
    ev(1, { type: 'run.started', harness: { name: 'pi' }, models: [{ purpose: 'main', id: 'm' }] }),
    ev(2, { type: 'model.call', usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80 }, cost: { usd: 0.01 } }),
    ev(3, { type: 'tool.call', tool: 'bash', input: {} }),
    ev(4, { type: 'model.call', agentId: 'a1', usage: { inputTokens: 300, outputTokens: 5 }, cost: { usd: 0.02 } }),
    ev(5, { type: 'model.retry', attempt: 1 }),
  ];
  const mid = tallyOf(events);
  assert.equal(mid.inputTokens, 400);
  assert.equal(mid.turns, 1);
  assert.equal(mid.modelCalls, 2);
  assert.equal(mid.toolCalls, 1);
  assert.equal(mid.peakContext, 300);
  assert.equal(mid.retries, 1);
  assert.ok(Math.abs((mid.costUsd ?? 0) - 0.03) < 1e-9);
  assert.deepEqual(mid.models, [{ purpose: 'main', id: 'm' }]);
  const end = tallyOf([...events, ev(6, { type: 'run.ended', outcome: 'complete', reason: 'completed', turns: 7, durationMs: 1000, cost: { usd: 0.5 }, models: [{ model: { id: 'm' }, usage: { inputTokens: 999, outputTokens: 9 } }] })]);
  assert.equal(end.turns, 7);
  assert.equal(end.costUsd, 0.5);
  assert.equal(end.inputTokens, 999);
  assert.equal(end.ended?.durationMs, 1000);
});

test('the plan comes from a write of plan.json, whole or not at all', () => {
  const content = JSON.stringify({ steps: [{ id: 'lib', files: ['a.ts'], description: 'x' }] });
  const write = { type: 'tool.call', tool: 'write', input: { path: '/workspace/plan.json', content } };
  assert.ok(isPlanWrite(write));
  assert.ok(isPlanWrite({ type: 'tool.call', tool: 'Write', input: { file_path: 'plan.json', content } }));
  assert.ok(!isPlanWrite({ type: 'tool.call', tool: 'write', input: { path: '/workspace/plan.md', content } }));
  assert.ok(isPlanWrite({ type: 'tool.call', tool: 'write', input: '{"path":"/workspace/plan.json","content":"{\\"ste' }));
  assert.deepEqual(planFromWrite(write), [{ id: 'lib', description: 'x', files: ['a.ts'] }]);
  assert.equal(planFromWrite({ type: 'tool.call', tool: 'write', input: '{"path":"/workspace/plan.json"' }), undefined);
});

test('the short form of the last event, and byte counts', () => {
  assert.equal(describeShort({ type: 'tool.call', tool: 'read', input: { path: '/workspace/repo/packages/dashboard/src/x.ts' } }), 'read /workspace/repo/packages/das');
  assert.equal(describeShort({ type: 'model.call', usage: { inputTokens: 12000 } }), 'model call 12.0K in');
  assert.equal(byteLength('aé€😀'), 1 + 2 + 3 + 4);
});
