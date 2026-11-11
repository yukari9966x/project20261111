// ZIP 읽기/쓰기 (HWPX 컨테이너용). 저장(0)과 deflate(8) 만 지원한다.

import { concatBytes, utf8Decode, utf8Encode } from './bytes.js';
import { inflateRaw, deflateRaw, crc32 } from './zlibx.js';

export function isZip(u8) {
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 0x03 || u8[2] === 0x05) && (u8[3] === 0x04 || u8[3] === 0x06);
}

/**
 * 반환: [{ name, method, crc, compSize, size, raw(압축된 바이트), time, date, getData(): Promise<Uint8Array> }]
 */
export function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 끝에서부터 중앙 디렉터리 끝 레코드 찾기
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 22 - 0xffff);
  for (let p = u8.length - 22; p >= minPos; p--) {
    if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('ZIP 형식이 아닙니다 (끝 레코드를 찾을 수 없음).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리가 손상되었습니다.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff) throw new Error('ZIP64 형식은 지원하지 않습니다.');
    if (flags & 1) throw new Error('암호가 걸린 ZIP 항목은 지원하지 않습니다.');
    if (localOff + 30 > u8.length || dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('ZIP 로컬 헤더가 손상되었습니다.');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    if (dataOff + compSize > u8.length) throw new Error('ZIP 항목 데이터가 잘렸습니다.');
    const raw = u8.subarray(dataOff, dataOff + compSize);
    if (method !== 0 && method !== 8) throw new Error(`지원하지 않는 ZIP 압축 방식입니다 (${method}).`);
    const entry = { name, method, crc, compSize, size, raw, time, date, _data: null };
    entry.getData = async () => {
      if (entry._data) return entry._data;
      entry._data = method === 0 ? raw.slice() : await inflateRaw(raw);
      return entry._data;
    };
    entries.push(entry);
  }
  return entries;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * entries: [{ name, data?: Uint8Array, store?: boolean, passthrough?: readZip 항목(바뀌지 않은 원본) }]
 * 주어진 순서대로 기록한다.
 */
export async function writeZip(entries) {
  const now = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = utf8Encode(e.name);
    let method, crc, raw, size, time = now.time, date = now.date;
    if (e.passthrough) {
      const src = e.passthrough;
      method = src.method; crc = src.crc; raw = src.raw; size = src.size;
      if (src.time !== undefined) { time = src.time; date = src.date; }
    } else {
      const data = e.data || new Uint8Array(0);
      size = data.length;
      crc = crc32(data);
      if (e.store || size === 0) { method = 0; raw = data; }
      else {
        const comp = await deflateRaw(data);
        if (comp.length < size) { method = 8; raw = comp; } else { method = 0; raw = data; }
      }
    }
    const flags = 0x0800; // 이름은 UTF-8
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, method === 8 ? 20 : 10, true);
    ldv.setUint16(6, flags, true);
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, time, true);
    ldv.setUint16(12, date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, raw.length, true);
    ldv.setUint32(22, size, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, raw);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, method === 8 ? 20 : 10, true);
    cdv.setUint16(8, flags, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, raw.length, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
    offset += lh.length + raw.length;
  }
  const cd = concatBytes(central);
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cd.length, true);
  edv.setUint32(16, offset, true);
  return concatBytes([...parts, cd, end]);
}
