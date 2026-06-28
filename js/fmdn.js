// fmdn.js — pure helpers for decoding Google Find My Device (FMDN) / Eddystone
// BLE advertisements and classifying trackers over GATT/DULT. No DOM, no I/O,
// so this module is easy to unit-test and reuse.
//
// Protocol references:
//   FMDN (Find Hub Network): https://developers.google.com/nearby/fast-pair/specifications/extensions/fmdn
//   Fast Pair:               https://developers.google.com/nearby/fast-pair/specifications/service/provider
//   DULT (anti-stalking):    https://www.ietf.org/archive/id/draft-ledvina-dult-accessory-protocol-00.html

export const FEAA_UUID    = '0000feaa-0000-1000-8000-00805f9b34fb'; // Eddystone / FMDN
export const FE2C_UUID    = '0000fe2c-0000-1000-8000-00805f9b34fb'; // Fast Pair
export const DULT_SERVICE = '15190001-12f4-c226-88ed-2ac5579f2a85';
export const DULT_CONTROL = '8e0c0001-1d68-fb92-bf61-48377421680e';

// 16-bit short ids worth highlighting in the inspector.
export const KNOWN_SERVICES = {
  feaa: 'Eddystone / FMDN',
  fe2c: 'Fast Pair',
  feb3: 'Taobao (clone marker)',
  fa25: 'vendor (certified marker)',
  '1804': 'Tx Power',
  '180f': 'Battery',
  '180a': 'Device Information',
  '1801': 'Generic Attribute',
};

// Services we request access to when inspecting a tag over GATT.
export const INSPECT_SERVICES = [
  0x180a, 0x180f, 0x1804, 0x1801, 0xfeb3, 0xfa25, 0xfe2c, 0xfeaa, DULT_SERVICE,
];

// DULT non-owner reads — write the 2-byte little-endian opcode, read the reply
// indication. These are read-only and allowed for anyone (anti-stalking design).
export const DULT_READS = [
  { label: 'Manufacturer', op: [0x04, 0x00] },
  { label: 'Model',        op: [0x05, 0x00] },
  { label: 'Firmware',     op: [0x0a, 0x00] },
];
export const DULT_SOUND_START = [0x00, 0x03];
export const DULT_SOUND_STOP  = [0x01, 0x03];

/** Decode an Eddystone/FMDN service-data payload. @param {DataView} view */
export function decodeFmdn(view) {
  if (!view || view.byteLength < 1) return null;
  const frame = view.getUint8(0);
  if ((frame & 0xf0) !== 0x40) return null;            // FMDN EID frame: high nibble 0x4
  const state = (frame & 0x0f) === 0x01 ? 'separated' : 'normal'; // 0x41 vs 0x40
  const keyBits = (view.byteLength - 1) >= 32 ? 256 : 160;
  return { state, keyBits, frame };
}

/** Pull an FMDN frame out of a Web Bluetooth advert's serviceData Map. */
export function fmdnFromServiceData(serviceData) {
  if (!serviceData) return null;
  let dv = typeof serviceData.get === 'function' ? serviceData.get(FEAA_UUID) : null;
  if (!dv && typeof serviceData.forEach === 'function') {
    serviceData.forEach((v, k) => { if (String(k).includes('feaa')) dv = v; });
  }
  return decodeFmdn(dv);
}

/** Rough distance from RSSI via log-distance path loss. refRssi = RSSI at 1 m. */
export function distanceMeters(rssi, refRssi = -59, ple = 2.5) {
  if (rssi == null) return null;
  return Math.pow(10, (refRssi - rssi) / (10 * ple));
}

/** Format an estimated distance for display. */
export function formatDistance(d) {
  if (d == null) return '';
  if (d < 1) return '≈ <1 m';
  if (d < 10) return `≈ ${d.toFixed(1)} m`;
  if (d < 30) return `≈ ${Math.round(d)} m`;
  return '≈ >30 m';
}

/** Map a 128-bit Bluetooth UUID to its 16-bit short form when applicable. */
export function shortUuid(uuid) {
  const u = String(uuid).toLowerCase();
  return /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(u) ? u.slice(4, 8) : u;
}

/** Interpret a DULT indication reply (Uint8Array) into a display string. */
export function parseDultReply(bytes) {
  if (!bytes || !bytes.length) return '(no reply)';
  if (bytes.length >= 2 && bytes[bytes.length - 1] === 0xff && bytes[bytes.length - 2] === 0xff)
    return 'Invalid_command (tag is in normal / near-owner state)';
  const body = bytes.slice(2);
  const printable = body.length && [...body].every((b) => b >= 32 && b < 127);
  return printable
    ? new TextDecoder().decode(body)
    : [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Classify a tag from its GATT profile.
 * @param {Set<string>} present  short service ids present
 * @param {boolean} mfrBlank     Device-Info manufacturer is a blank placeholder
 * @param {boolean} disEncrypted Device-Info reads were rejected (NotAuthorized)
 */
export function classify({ present, mfrBlank, disEncrypted }) {
  if (present.has('feb3') || mfrBlank)
    return { cls: 'clone', text: 'AliExpress clone — Taobao service / blank Device Info' };
  if (present.has('fa25') || (present.has('1804') && disEncrypted))
    return { cls: 'certified', text: 'Certified tracker — vendor service / encrypted Device Info' };
  return { cls: 'unknown', text: 'Unknown profile' };
}

/** Map an RSSI to a 0–100 signal percentage for the gauge. */
export function rssiToPercent(rssi) {
  return Math.max(0, Math.min(100, ((rssi + 100) / 55) * 100)); // -100..-45 → 0..100
}
