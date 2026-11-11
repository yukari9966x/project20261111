// 바이너리 읽기/쓰기 도우미 (리틀 엔디언)

export class Reader {
  constructor(u8, offset = 0, end = undefined) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = offset;
    this.end = end === undefined ? u8.length : end;
  }
  get remaining() { return this.end - this.pos; }
  get eof() { return this.pos >= this.end; }
  need(n) {
    if (this.pos + n > this.end) throw new RangeError(`데이터가 부족합니다 (위치 ${this.pos}, 필요 ${n}, 끝 ${this.end})`);
  }
  u8_() { this.need(1); return this.u8[this.pos++]; }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  bytes(n) { this.need(n); const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n) { this.need(n); this.pos += n; }
  /** UTF-16LE 문자열 (nchars 코드 유닛) */
  wstr(nchars) {
    this.need(nchars * 2);
    let s = '';
    for (let i = 0; i < nchars; i++) s += String.fromCharCode(this.dv.getUint16(this.pos + i * 2, true));
    this.pos += nchars * 2;
    return s;
  }
  /** u16 길이 + UTF-16LE 문자열 */
  lwstr() { const n = this.u16(); return this.wstr(n); }
}

export class Writer {
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; return this; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; return this; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; return this; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v | 0, true); this.pos += 4; return this; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  zeros(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }
  wstr(s) {
    this.ensure(s.length * 2);
    for (let i = 0; i < s.length; i++) { this.dv.setUint16(this.pos, s.charCodeAt(i), true); this.pos += 2; }
    return this;
  }
  lwstr(s) { this.u16(s.length); return this.wstr(s); }
  toBytes() { return this.buf.slice(0, this.pos); }
}

export function concatBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const b of list) { out.set(b, p); p += b.length; }
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8');
export const utf8Encode = (s) => te.encode(s);
export const utf8Decode = (b) => td.decode(b);

export function utf16leDecode(b) {
  let s = '';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(dv.getUint16(i, true));
  return s;
}
export function utf16leEncode(s) {
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function bytesToBase64(u8) {
  if (typeof btoa === 'function') {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  return Buffer.from(u8).toString('base64');
}
