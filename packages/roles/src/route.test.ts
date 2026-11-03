import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRouteFile, routeFileContent } from './route.ts';

describe('the route file', () => {
  it('reads back the route it was written with', () => {
    assert.equal(parseRouteFile(routeFileContent('propose')), 'propose');
    assert.equal(parseRouteFile(routeFileContent('change')), 'change');
  });

  it('is change when absent, unreadable or naming anything else', () => {
    assert.equal(parseRouteFile(undefined), 'change');
    assert.equal(parseRouteFile('not json'), 'change');
    assert.equal(parseRouteFile('{"route":"refuse"}'), 'change');
    assert.equal(parseRouteFile('null'), 'change');
  });
});
