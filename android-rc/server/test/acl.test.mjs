import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAcl } from '../api/index.mjs';

describe('acl', () => {
  const INTERNAL = 'rc-api';

  it('internal user gets rc/#', () => {
    assert.strictEqual(checkAcl(INTERNAL, 'rc/#'), true);
    assert.strictEqual(checkAcl(INTERNAL, 'rc/cmd/anything'), true);
    assert.strictEqual(checkAcl(INTERNAL, 'rc/state/anything'), true);
  });

  it('device user can access own topics only', () => {
    const u = 'dev-a1b2';
    assert.strictEqual(checkAcl(u, `rc/cmd/${u}`), true);
    assert.strictEqual(checkAcl(u, `rc/state/${u}`), true);
    assert.strictEqual(checkAcl(u, `rc/probe/${u}`), true);
    assert.strictEqual(checkAcl(u, `rc/event/${u}`), true);
  });

  it('device user cannot access other device topics', () => {
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/state/dev-other'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/cmd/dev-other'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/probe/dev-other'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/event/dev-other'), false);
  });

  it('denies unrelated topics', () => {
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/cmd/'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/state'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'other/topic'), false);
    assert.strictEqual(checkAcl('dev-a1b2', 'rc/foo/dev-a1b2'), false);
    assert.strictEqual(checkAcl('dev-a1b2', ''), false);
  });

  it('denies empty username', () => {
    assert.strictEqual(checkAcl('', 'rc/state/dev'), false);
    assert.strictEqual(checkAcl(null, 'rc/state/dev'), false);
  });
});