/**
 * Checks on the functions served from the orchestration image (#261): each
 * names a handler the build writes into the image, every other function is a
 * zip with its own runtime, and Collect, the clean room, has room for a clone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { resource, resources, type Json } from './template-checks.ts';

/** The build's `imageFunctions`, read from the script, which builds when imported. */
function imageFunctions(): string[] {
  const source = readFileSync(new URL('../build.ts', import.meta.url), 'utf8');
  const list = /export const imageFunctions = \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(list !== undefined, 'build.ts declares no imageFunctions');
  return [...list.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string);
}

const functions = (): Array<[string, Json]> =>
  Object.entries(resources())
    .filter(([, definition]) => definition.Type === 'AWS::Serverless::Function')
    .map(([name, definition]) => [name, definition.Properties as Json]);

test('every image function runs a handler the build puts in the image, and the build puts nothing else there', () => {
  const built = imageFunctions();
  const commands = functions()
    .filter(([, properties]) => properties.PackageType === 'Image')
    .map(([name, properties]) => {
      assert.deepEqual(Object.keys(properties).filter((key) => ['CodeUri', 'Handler', 'Runtime', 'Layers'].includes(key)), [], name);
      const command = (properties.ImageConfig as { Command?: string[] } | undefined)?.Command ?? [];
      assert.equal(command.length, 1, name);
      return command[0] as string;
    });
  assert.deepEqual(commands.sort(), built.map((name) => `${name}/index.handler`).sort());
});

test('every zip function names its runtime and is not also in the image', () => {
  const built = new Set(imageFunctions());
  for (const [name, properties] of functions().filter(([, p]) => p.PackageType !== 'Image')) {
    assert.match(String(properties.Runtime), /^nodejs\d+\.x$/, name);
    const dir = /dist\/([a-z-]+)\/$/.exec(String(properties.CodeUri))?.[1];
    assert.ok(dir && !built.has(dir), `${name} is a zip of a function the build puts in the image`);
  }
});

test('Collect runs from the orchestration image with 2 GB of memory and of /tmp', () => {
  const properties = resource('CollectFunction').Properties as Json;
  assert.equal(properties.PackageType, 'Image');
  const uri = JSON.stringify(properties.ImageUri);
  assert.ok(uri.includes('${RepositoryUri}:${OrchestrationImageTag}') && uri.includes('Factorial-OrchestrationRepositoryUri'), uri);
  assert.equal(properties.MemorySize, 2048);
  assert.deepEqual(properties.EphemeralStorage, { Size: 2048 });
});
