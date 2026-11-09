import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

// Set env before dynamically importing api (which reads env at module load)
process.env.TOKEN_SECRET = 'test-secret-do-not-use-in-production';
process.env.RC_ENROLL_CODE = 'test-enroll-code-do-not-use';
const api = await import('../api/index.mjs');
const { makeToken, verifyToken } = api;

describe('token', () => {
  it('makeToken + verifyToken round-trip', () => {
    const { token, expiresAt } = makeToken('sess-abc123', 'dev-a1b2');
    const parsed = verifyToken(token);
    assert.ok(parsed, 'token should verify');
    assert.strictEqual(parsed.sessionId, 'sess-abc123');
    assert.strictEqual(parsed.deviceId, 'dev-a1b2');
    assert.strictEqual(parsed.expiresAt, expiresAt);
  });

  it('rejects tampered token', () => {
    const { token } = makeToken('sess-abc123', 'dev-a1b2');
    const tampered = token.replace(/.$/, 'x');
    assert.strictEqual(verifyToken(tampered), null);
  });

  it('rejects malformed token', () => {
    assert.strictEqual(verifyToken('not.a.token'), null);
    assert.strictEqual(verifyToken('nodots'), null);
    assert.strictEqual(verifyToken(''), null);
  });

  it('rejects expired token', () => {
    const past = new Date(0).toISOString();
    const payload = `sess-x|dev-y|${past}`;
    const sig = crypto.createHmac('sha256', process.env.TOKEN_SECRET).update(payload).digest('hex');
    const expired = `${payload}.${sig}`;
    assert.strictEqual(verifyToken(expired), null);
  });
});