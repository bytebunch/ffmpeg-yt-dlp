import { randomBytes } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * UUID version 7 (RFC 9562): a 48-bit Unix-millisecond timestamp, then a 12-bit counter (method 1
 * of RFC 9562 §6.2) and random bits. Ids from one generator are strictly increasing, even within
 * a millisecond, so they index well and double as creation-order cursors.
 */
export function uuidv7Generator(): (now?: number) => string {
  let lastMillis = -1;
  let counter = 0;
  return (now: number = Date.now()) => {
    let millis = now;
    if (millis <= lastMillis) {
      millis = lastMillis;
      counter++;
      if (counter > 0xfff) {
        millis = lastMillis + 1; // Counter overflow: borrow the next millisecond.
        counter = 0;
      }
    } else {
      counter = 0;
    }
    lastMillis = millis;
    const bytes = randomBytes(16);
    bytes.writeUIntBE(millis, 0, 6);
    bytes.writeUInt16BE(0x7000 | counter, 6);
    bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** The process-wide generator. */
export const uuidv7 = uuidv7Generator();

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
