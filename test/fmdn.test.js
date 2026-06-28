// Unit tests for js/fmdn.js — the pure protocol/decode/selection logic.
// Run with: node --test   (no dependencies; uses the built-in test runner)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fmdn from '../js/fmdn.js';

const dv = (arr) => new DataView(Uint8Array.from(arr).buffer);
const bytes = (arr) => Uint8Array.from(arr);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

test('decodeFmdn: 0x40 normal frame, 160-bit', () => {
  const r = fmdn.decodeFmdn(dv([0x40, ...new Array(20).fill(1)]));
  assert.equal(r.state, 'normal');
  assert.equal(r.keyBits, 160);
  assert.equal(r.frame, 0x40);
});

test('decodeFmdn: 0x41 separated frame', () => {
  assert.equal(fmdn.decodeFmdn(dv([0x41, 1, 2, 3])).state, 'separated');
});

test('decodeFmdn: 256-bit when body >= 32 bytes', () => {
  assert.equal(fmdn.decodeFmdn(dv([0x40, ...new Array(32).fill(0)])).keyBits, 256);
});

test('decodeFmdn: rejects non-FMDN Eddystone frame types', () => {
  assert.equal(fmdn.decodeFmdn(dv([0x00, 1, 2])), null); // UID
  assert.equal(fmdn.decodeFmdn(dv([0x10, 1, 2])), null); // URL
  assert.equal(fmdn.decodeFmdn(dv([0x20, 1, 2])), null); // TLM
  assert.equal(fmdn.decodeFmdn(dv([0x30, 1])), null);
});

test('decodeFmdn: null / empty input', () => {
  assert.equal(fmdn.decodeFmdn(null), null);
  assert.equal(fmdn.decodeFmdn(dv([])), null);
});

test('fmdnFromServiceData: matches the FEAA key', () => {
  const m = new Map([[fmdn.FEAA_UUID, dv([0x41, 1])]]);
  assert.equal(fmdn.fmdnFromServiceData(m).state, 'separated');
});

test('fmdnFromServiceData: matches any key containing "feaa"', () => {
  const m = new Map([['0000feaa-0000-1000-8000-00805f9b34fb', dv([0x40, 1])]]);
  assert.equal(fmdn.fmdnFromServiceData(m).state, 'normal');
});

test('fmdnFromServiceData: ignores Fast Pair / null', () => {
  assert.equal(fmdn.fmdnFromServiceData(new Map([[fmdn.FE2C_UUID, dv([0, 1])]])), null);
  assert.equal(fmdn.fmdnFromServiceData(null), null);
  assert.equal(fmdn.fmdnFromServiceData(new Map()), null);
});

test('distanceMeters: ref RSSI is 1 m, scales correctly', () => {
  assert.equal(Math.round(fmdn.distanceMeters(-59, -59, 2.5)), 1);
  assert.ok(fmdn.distanceMeters(-50, -59, 2.5) < 1);   // stronger → closer
  assert.ok(fmdn.distanceMeters(-80, -59, 2.5) > 1);   // weaker → farther
  assert.equal(fmdn.distanceMeters(null), null);
});

test('formatDistance: buckets', () => {
  assert.equal(fmdn.formatDistance(0.5), '≈ <1 m');
  assert.equal(fmdn.formatDistance(2.34), '≈ 2.3 m');
  assert.equal(fmdn.formatDistance(15), '≈ 15 m');
  assert.equal(fmdn.formatDistance(99), '≈ >30 m');
  assert.equal(fmdn.formatDistance(null), '');
});

test('shortUuid: collapses standard 128-bit, leaves custom intact', () => {
  assert.equal(fmdn.shortUuid('0000feaa-0000-1000-8000-00805f9b34fb'), 'feaa');
  assert.equal(fmdn.shortUuid('0000180A-0000-1000-8000-00805F9B34FB'), '180a');
  assert.equal(fmdn.shortUuid(fmdn.DULT_SERVICE), fmdn.DULT_SERVICE);
});

test('parseDultReply: Invalid_command (ffff terminator)', () => {
  assert.match(fmdn.parseDultReply(bytes([0x02, 0x03, 0xff, 0xff])), /Invalid_command/);
});

test('parseDultReply: printable string after 2-byte opcode', () => {
  assert.equal(fmdn.parseDultReply(bytes([0x04, 0x08, ...ascii('PhyPlus')])), 'PhyPlus');
  assert.equal(fmdn.parseDultReply(bytes([0x05, 0x08, ...ascii('MiTag')])), 'MiTag');
});

test('parseDultReply: empty → placeholder, non-printable → hex', () => {
  assert.equal(fmdn.parseDultReply(null), '(no reply)');
  assert.equal(fmdn.parseDultReply(bytes([])), '(no reply)');
  assert.equal(fmdn.parseDultReply(bytes([0x04, 0x08, 0x00, 0x01, 0x02])), '0408000102');
});

test('classify: clone via Taobao service or blank manufacturer', () => {
  assert.equal(fmdn.classify({ present: new Set(['feb3', '180a']), mfrBlank: false, disEncrypted: false }).cls, 'clone');
  assert.equal(fmdn.classify({ present: new Set(['180a']), mfrBlank: true, disEncrypted: false }).cls, 'clone');
});

test('classify: certified via vendor service or txpower+encrypted DIS', () => {
  assert.equal(fmdn.classify({ present: new Set(['fa25']), mfrBlank: false, disEncrypted: false }).cls, 'certified');
  assert.equal(fmdn.classify({ present: new Set(['1804']), mfrBlank: false, disEncrypted: true }).cls, 'certified');
});

test('classify: unknown profile', () => {
  assert.equal(fmdn.classify({ present: new Set(['180f']), mfrBlank: false, disEncrypted: false }).cls, 'unknown');
});

test('rssiToPercent: maps and clamps to 0..100', () => {
  assert.equal(fmdn.rssiToPercent(-45), 100);
  assert.equal(fmdn.rssiToPercent(-100), 0);
  assert.equal(fmdn.rssiToPercent(-30), 100);   // clamp high
  assert.equal(fmdn.rssiToPercent(-120), 0);    // clamp low
  assert.ok(Math.abs(fmdn.rssiToPercent(-72.5) - 50) < 0.001);
});

const tag = (id, ema, state) => ({ id, ema, state });

test('selectTarget: strongest normal-state tag', () => {
  const tags = new Map([
    ['a', tag('a', -80, 'normal')],
    ['b', tag('b', -60, 'separated')],   // excluded in normal mode
    ['c', tag('c', -70, 'normal')],
  ]);
  assert.equal(fmdn.selectTarget(tags, 'normal').id, 'c');
});

test('selectTarget: any-mode picks strongest overall', () => {
  const tags = new Map([['a', tag('a', -80, 'normal')], ['b', tag('b', -60, 'separated')]]);
  assert.equal(fmdn.selectTarget(tags, 'any').id, 'b');
});

test('selectTarget: manual returns the locked tag or null', () => {
  const tags = new Map([['a', tag('a', -80, 'normal')]]);
  assert.equal(fmdn.selectTarget(tags, 'manual', 'a').id, 'a');
  assert.equal(fmdn.selectTarget(tags, 'manual', 'missing'), null);
});

test('selectTarget: empty set → null', () => {
  assert.equal(fmdn.selectTarget(new Map(), 'normal'), null);
  assert.equal(fmdn.selectTarget(new Map(), 'any'), null);
});

test('capSeenLog: keeps every named tag, caps unnamed by recency', () => {
  const now = 1_700_000_000_000;
  const seen = {};
  for (let i = 0; i < 20; i++) seen['u' + i] = { ts: now - i * 1000, rssi: -70, state: 'normal' };
  seen.keys = { ts: now - 6 * 864e5, rssi: -70, state: 'separated' }; // old-ish but named
  const out = fmdn.capSeenLog(seen, { keys: 'Lost keys' }, 12, now, 7 * 864e5);
  assert.ok('keys' in out, 'named tag kept');
  const unnamed = Object.keys(out).filter((k) => k !== 'keys');
  assert.equal(unnamed.length, 12, 'unnamed capped at 12');
  assert.ok('u0' in out, 'most recent unnamed kept');
  assert.ok(!('u19' in out), 'oldest unnamed dropped');
});

test('capSeenLog: drops unnamed older than maxAge, keeps named regardless', () => {
  const now = 1_700_000_000_000;
  const seen = {
    fresh: { ts: now, rssi: -70, state: 'normal' },
    old: { ts: now - 8 * 864e5, rssi: -70, state: 'normal' },
    oldNamed: { ts: now - 30 * 864e5, rssi: -70, state: 'normal' },
  };
  const out = fmdn.capSeenLog(seen, { oldNamed: 'Wallet' }, 12, now, 7 * 864e5);
  assert.ok('fresh' in out);
  assert.ok(!('old' in out), 'old unnamed dropped');
  assert.ok('oldNamed' in out, 'old but named kept');
});

test('capSeenLog: does not mutate its input', () => {
  const seen = { a: { ts: 1, rssi: -70, state: 'normal' } };
  const copy = JSON.parse(JSON.stringify(seen));
  fmdn.capSeenLog(seen, {}, 12, 1_700_000_000_000);
  assert.deepEqual(seen, copy);
});
