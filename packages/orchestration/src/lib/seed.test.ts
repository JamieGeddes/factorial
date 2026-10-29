import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contextFor, newItem } from './seed-fixtures.ts';
import { assembleSeed, cutToBytes, sectionText, seedScript, type SeedProvider } from './seed.ts';

const context = contextFor(newItem);

describe('assembleSeed', () => {
  it('runs the providers in the order of the list and collects their files, sections and data', async () => {
    const order: string[] = [];
    const first: SeedProvider = () => (order.push('first'), { files: [{ path: 'a.md', content: 'a', cap: 10 }], sections: [{ id: 's', text: 'x', cap: 10 }] });
    const second: SeedProvider = async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('second');
      return { files: [{ path: 'b.md', content: 'b', cap: 10 }], data: { reworkPoints: [{ author: 'u', body: 'b' }] } };
    };
    const seed = await assembleSeed([first, second], context);
    assert.deepEqual(order, ['first', 'second']);
    assert.deepEqual(seed.files.map((f) => f.path), ['a.md', 'b.md']);
    assert.equal(sectionText(seed, 's'), 'x');
    assert.equal(sectionText(seed, 'nope'), undefined);
    assert.equal(seed.data.reworkPoints?.length, 1);
  });

  it('seeds nothing for an empty list', async () => {
    assert.deepEqual(await assembleSeed([], context), { files: [], sections: [], data: {} });
  });

  it('refuses a file name that leaves /workspace', async () => {
    for (const path of ['../x', 'a/b', '/etc/passwd', '', '.hidden', 'a b']) {
      await assert.rejects(assembleSeed([() => ({ files: [{ path, content: '', cap: 1 }] })], context), /not a file name/);
    }
  });

  it('refuses a second file of the same name, unless it appends to the first', async () => {
    const one: SeedProvider = () => ({ files: [{ path: 'notes.md', content: 'one', cap: 100 }] });
    await assert.rejects(assembleSeed([one, one], context), /already seeded/);
    const more: SeedProvider = () => ({ files: [{ path: 'notes.md', content: ' two', cap: 100, append: true }] });
    const seed = await assembleSeed([one, more], context);
    assert.deepEqual(seed.files.map((f) => ('content' in f ? f.content : '')), ['one two']);
    await assert.rejects(assembleSeed([more], context), /no earlier provider/);
  });

  it('refuses a file over its cap, and cuts one whose provider allows it', async () => {
    await assert.rejects(assembleSeed([() => ({ files: [{ path: 'a.json', content: 'x'.repeat(11), cap: 10 }] })], context), /over its 10-byte cap/);
    const seed = await assembleSeed([() => ({ files: [{ path: 'a.md', content: 'x'.repeat(500), cap: 100, truncate: true }] })], context);
    const file = seed.files[0]!;
    assert.ok('content' in file && Buffer.byteLength(file.content, 'utf8') <= 100);
    assert.match('content' in file ? file.content : '', /Cut at 100 bytes/);
  });

  it('refuses a section over its cap and a section id used twice', async () => {
    await assert.rejects(assembleSeed([() => ({ sections: [{ id: 's', text: 'abcdef', cap: 5 }] })], context), /over its 5-character cap/);
    const one: SeedProvider = () => ({ sections: [{ id: 's', text: 'a', cap: 5 }] });
    await assert.rejects(assembleSeed([one, one], context), /already seeded/);
  });
});

describe('cutToBytes', () => {
  it('leaves text within the cap alone', () => {
    assert.equal(cutToBytes('abc', 3), 'abc');
  });

  it('cuts on a character boundary and stays within the cap', () => {
    const cut = cutToBytes('é'.repeat(200), 101);
    assert.ok(Buffer.byteLength(cut, 'utf8') <= 101);
    assert.doesNotMatch(cut, /\uFFFD/);
  });
});

describe('seedScript', () => {
  it('writes every file from base64, so no content reaches the shell as text', async () => {
    const seed = await assembleSeed([() => ({ files: [{ path: 'notes.md', content: "'; touch /x; '$(id)", cap: 100 }, { path: 'b.md', content: 'b', cap: 10 }] })], context);
    const script = seedScript(seed);
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.equal(script.match(/base64 -d > \/workspace\/(notes|b)\.md/g)?.length, 2);
    assert.doesNotMatch(script, /touch \/x|\$\(id\)/);
  });

  it('makes a command file in the clone and cuts it to its cap', async () => {
    const seed = await assembleSeed([() => ({ files: [{ path: 'diff.patch', command: 'git diff', cap: 1000 }] })], context);
    const script = seedScript(seed);
    assert.match(script, /\(cd \/workspace\/repo && git diff\) > \/workspace\/diff\.patch/);
    assert.match(script, /truncate -s 1000 \/workspace\/diff\.patch/);
  });
});
