import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

process.env.TOKEN_SECRET = 'test-session-secret';
const api = await import('../api/index.mjs');
const { makeToken, verifyToken } = api;

describe('session TTL', () => {
  it('token expires after 10 minutes', () => {
    const { token } = makeToken('sess-ttl', 'dev-ttl');
    const parsed = verifyToken(token);
    assert.ok(parsed, 'fresh token should verify');
    const exp = new Date(parsed.expiresAt).getTime();
    const now = Date.now();
    const ttlMs = exp - now;
    assert.ok(ttlMs > 9 * 60 * 1000, `TTL should be ~10 min, got ${ttlMs}ms`);
    assert.ok(ttlMs <= 10 * 60 * 1000, `TTL should not exceed 10 min`);
  });

  it('expired token returns null', () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const payload = `sess-expired|dev-expired|${past}`;
    const sig = crypto.createHmac('sha256', process.env.TOKEN_SECRET).update(payload).digest('hex');
    assert.strictEqual(verifyToken(`${payload}.${sig}`), null);
  });
});