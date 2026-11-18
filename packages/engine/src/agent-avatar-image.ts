import { inflateSync } from "node:zlib";

/** CRC-32 of PNG chunks; validates the stored encoding without resampling the portrait. */
const CRC = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
};
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  Buffer.from(bytes.subarray(at, at + length)).toString("ascii");

function png(bytes: Uint8Array, width: number, height: number) {
  if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payload: Uint8Array[] = [];
  let at = 8;
  let depth = 0;
  let channels = 0;
  let color = -1;
  let interlace = -1;
  let palette = false;
  let ended = false;
  let dataClosed = false;
  while (at + 12 <= bytes.length) {
    const size = view.getUint32(at);
    const end = at + size + 12;
    if (end > bytes.length) return false;
    const kind = ascii(bytes, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(kind) || crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) return false;
    if (at === 8 && kind !== "IHDR") return false;
    if (kind === "IHDR") {
      if (at !== 8 || size !== 13) return false;
      depth = bytes[at + 16] ?? 0;
      color = bytes[at + 17] ?? -1;
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? 0;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      interlace = bytes[at + 20] ?? -1;
      if (
        !depths[color]?.includes(depth) ||
        bytes[at + 18] !== 0 ||
        bytes[at + 19] !== 0 ||
        ![0, 1].includes(interlace)
      )
        return false;
    } else if (kind === "PLTE") {
      if (palette || payload.length || color === 0 || color === 4 || size === 0 || size % 3 || size > 768) return false;
      if (color === 3 && size / 3 > 2 ** depth) return false;
      palette = true;
    } else if (kind === "IDAT") {
      if (dataClosed || (color === 3 && !palette)) return false;
      payload.push(bytes.subarray(at + 8, end - 4));
    } else if (kind === "IEND") {
      if (size !== 0 || end !== bytes.length || !payload.length) return false;
      ended = true;
    } else {
      // Unknown critical chunks cannot be decoded; APNG is not a static portrait.
      if (kind[0] === kind[0]?.toUpperCase() || kind === "acTL") return false;
      if (payload.length) dataClosed = true;
    }
    at = end;
  }
  if (!ended || at !== bytes.length || !payload.some((part) => part.length > 0)) return false;

  // Each PNG row has a filter byte. Adam7 has seven independent sets of rows.
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const rows: { count: number; bytes: number }[] = [];
  let expected = 0;
  for (const pass of passes) {
    const [x = 0, y = 0, dx = 1, dy = 1] = pass;
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    if (!w || !h) continue;
    const rowBytes = Math.ceil((w * channels * depth) / 8) + 1;
    expected += rowBytes * h;
    rows.push({ count: h, bytes: rowBytes });
  }
  // Bound both allocation and decompression, even for a very small compressed image.
  if (!expected || expected > 64 * 1024 * 1024) return false;
  const decoded = inflateSync(Buffer.concat(payload), { maxOutputLength: expected });
  if (decoded.length !== expected) return false;
  let offset = 0;
  for (const row of rows)
    for (let y = 0; y < row.count; y++) {
      if ((decoded[offset] ?? 255) > 4) return false;
      offset += row.bytes;
    }
  return true;
}

function jpeg(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let at = 2;
  let frame = false;
  let scan = false;
  let payload = false;
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) return false;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) return at === bytes.length && frame && scan && payload;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0x01) continue;
    if (at + 2 > bytes.length) return false;
    const size = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
    if (size < 2 || at + size > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8) return false;
      frame = true;
    }
    at += size;
    if (marker !== 0xda) continue;
    if (!frame || size < 6) return false;
    scan = true;
    while (at < bytes.length) {
      if (bytes[at] !== 0xff) {
        payload = true;
        at++;
        continue;
      }
      const start = at;
      while (bytes[at] === 0xff) at++;
      const next = bytes[at];
      if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
        payload = true;
        at++;
      } else {
        at = start;
        break;
      }
    }
  }
  return false;
}

function webp(bytes: Uint8Array, width: number, height: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return false;
  let at = 12;
  let image = false;
  while (at + 8 <= bytes.length) {
    const kind = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (end > bytes.length) return false;
    const data = bytes.subarray(at + 8, at + 8 + size);
    if (kind === "ANIM" || kind === "ANMF") return false;
    if (kind === "VP8X" && size !== 10) return false;
    if (kind === "VP8 " || kind === "VP8L") {
      if (image) return false;
      image = true;
      if (kind === "VP8 ") {
        if (size <= 10 || (data[0] ?? 1) & 1 || data[3] !== 0x9d || data[4] !== 1 || data[5] !== 0x2a) return false;
        if (
          (((data[6] ?? 0) | ((data[7] ?? 0) << 8)) & 0x3fff) !== width ||
          (((data[8] ?? 0) | ((data[9] ?? 0) << 8)) & 0x3fff) !== height
        )
          return false;
      } else {
        if (size <= 5 || data[0] !== 0x2f) return false;
        const bits = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
        if (bits >>> 29 !== 0 || (bits & 0x3fff) + 1 !== width || ((bits >>> 14) & 0x3fff) + 1 !== height) return false;
      }
    }
    at = end;
  }
  return image && at === bytes.length;
}

/** Required image payloads and bounded structural integrity, not just a MIME signature or a dimensional header. */
export function validAgentImage(bytes: Uint8Array, type: string, size: { width: number; height: number }) {
  try {
    return type === "image/png"
      ? png(bytes, size.width, size.height)
      : type === "image/jpeg"
        ? jpeg(bytes)
        : type === "image/webp"
          ? webp(bytes, size.width, size.height)
          : false;
  } catch {
    return false;
  }
}
