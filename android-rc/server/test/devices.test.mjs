import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Set DB path before dynamically importing api (which reads DB_PATH at module load)
process.env.DB_PATH = './data/test-devices.sqlite';
const api = await import('../api/index.mjs');
const { upsertDevice, listDevices, initDb } = api;

await initDb();

describe('devices', () => {
  it('upsert then list a device', () => {
    upsertDevice('dev-a1b2', JSON.stringify({ online: true, version: '1.4.5', caps: { h264: false } }));
    const devices = listDevices();
    const found = devices.find(d => d.id === 'dev-a1b2');
    assert.ok(found, 'device should exist');
    assert.strictEqual(found.online, true);
    assert.strictEqual(found.version, '1.4.5');
    assert.ok(found.caps, 'caps should be parsed');
    assert.strictEqual(found.caps.h264, false);
  });

  it('upsert updates existing device', () => {
    upsertDevice('dev-a1b2', JSON.stringify({ online: false, version: '1.4.6', caps: { h264: true } }));
    const devices = listDevices();
    const found = devices.find(d => d.id === 'dev-a1b2');
    assert.strictEqual(found.online, false);
    assert.strictEqual(found.version, '1.4.6');
    assert.strictEqual(found.caps.h264, true);
    // Should still be only one device
    assert.strictEqual(devices.filter(d => d.id === 'dev-a1b2').length, 1);
  });

  it('upsert non-JSON payload still marks online', () => {
    upsertDevice('dev-raw', 'not json at all');
    const found = listDevices().find(d => d.id === 'dev-raw');
    assert.ok(found);
    assert.strictEqual(found.online, true);
  });
});