/**
 * Helpers for the checks on templates/orchestration.yml in the *-template
 * tests: its resources, and EventBridge pattern matching for the operators
 * its rules use.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

export type Json = Record<string, unknown>;

/** Resources of the template; CloudFormation short-form tags parse to `{ Tag: value }`. */
export function resources(): Record<string, Json> {
  const tags = ['Ref', 'GetAtt', 'Sub', 'ImportValue', 'Join', 'Select', 'If', 'Equals', 'Not', 'And', 'Or', 'FindInMap', 'Split', 'GetAZs', 'Base64', 'Condition'].map((name) => ({
    tag: `!${name}`,
    resolve: (value: unknown) => ({ [name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`]: value }),
  }));
  const template = parse(readFileSync(new URL('../../../templates/orchestration.yml', import.meta.url), 'utf8'), { customTags: tags }) as {
    Resources: Record<string, Json>;
  };
  return template.Resources;
}

/** One resource's definition; fails when it is missing. */
export function resource(name: string): Json {
  const found = resources()[name];
  assert.ok(found, `${name} not found`);
  return found;
}

/** EventBridge matching for the operators the rules use: an array is any-of, `{ exists: false }` is absence, an object nests. */
export function matches(pattern: Json, event: Json): boolean {
  return Object.entries(pattern).every(([key, expected]) => {
    const actual = event[key];
    if (Array.isArray(expected)) {
      return expected.some((item) => {
        if (item !== null && typeof item === 'object') {
          const { exists } = item as { exists?: boolean };
          assert.notEqual(exists, undefined, `unsupported operator in ${JSON.stringify(item)}`);
          return (actual !== undefined) === exists;
        }
        return item === actual;
      });
    }
    return actual !== null && typeof actual === 'object' && matches(expected as Json, actual as Json);
  });
}

