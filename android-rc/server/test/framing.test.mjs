import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHeader, packHeader, TYPE_CONFIG, TYPE_KEY, TYPE_DELTA, TYPE_JPEG, FRAME_HEADER_SIZE } from '../relay/index.mjs';

describe('framing', () => {
  it('packHeader produces 9-byte header', () => {
    const buf = packHeader(TYPE_JPEG, 123456789);
    assert.strictEqual(buf.length, FRAME_HEADER_SIZE);
    assert.strictEqual(buf.readUInt8(0), TYPE_JPEG);
    assert.strictEqual(Number(buf.readBigUInt64BE(1)), 123456789);
  });

  it('parseHeader round-trips packHeader', () => {
    for (const type of [TYPE_CONFIG, TYPE_KEY, TYPE_DELTA, TYPE_JPEG]) {
      for (const pts of [0, 1, 42, 999999999999]) {
        const hdr = packHeader(type, pts);
        const parsed = parseHeader(hdr);
        assert.strictEqual(parsed.type, type);
        assert.strictEqual(parsed.pts, pts);
      }
    }
  });

  it('parseHeader rejects short buffer', () => {
    assert.strictEqual(parseHeader(Buffer.alloc(8)), null);
    assert.strictEqual(parseHeader(Buffer.alloc(0)), null);
  });

  it('header size constant is 9', () => {
    assert.strictEqual(FRAME_HEADER_SIZE, 9);
  });
});