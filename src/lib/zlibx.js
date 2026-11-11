// 압축/해제 (raw deflate) 와 CRC32
// - 해제: 브라우저/Node 내장 DecompressionStream 을 먼저 쓰고, 실패하면(끝에 군더더기 바이트가
//   붙은 스트림 등) 순수 JS 구현으로 다시 시도한다.
// - 압축: 내장 CompressionStream 을 쓰고, 없으면 무압축(stored) 블록으로 만든다.

import { concatBytes } from './bytes.js';

async function pump(stream, data) {
  const writer = stream.writable.getWriter();
  const chunks = [];
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  // 쓰기 오류는 읽기 쪽에서도 드러나므로 둘 다 기다린다.
  const writeAll = (async () => {
    await writer.write(data);
    await writer.close();
  })();
  await Promise.all([readAll, writeAll]);
  return concatBytes(chunks);
}

export async function inflateRaw(data) {
  if (data.length === 0) return new Uint8Array(0);
  if (typeof DecompressionStream === 'function') {
    try {
      return await pump(new DecompressionStream('deflate-raw'), data);
    } catch (e) {
      // 아래 JS 구현으로 재시도
    }
  }
  return inflateRawSync(data);
}

export async function deflateRaw(data) {
  if (typeof CompressionStream === 'function') {
    try {
      return await pump(new CompressionStream('deflate-raw'), data);
    } catch (e) {
      // 아래 무압축 경로
    }
  }
  return deflateStored(data);
}

/** 무압축(stored) deflate 블록으로 감싼다. */
export function deflateStored(data) {
  const parts = [];
  let pos = 0;
  if (data.length === 0) return new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]);
  while (pos < data.length) {
    const n = Math.min(0xffff, data.length - pos);
    const last = pos + n >= data.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = last;
    head[1] = n & 0xff; head[2] = n >> 8;
    head[3] = ~n & 0xff; head[4] = (~n >> 8) & 0xff;
    parts.push(head, data.subarray(pos, pos + n));
    pos += n;
  }
  return concatBytes(parts);
}

// ---------------------------------------------------------------------------
// 순수 JS inflate (RFC 1951). 끝에 남는 바이트는 무시한다.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuff(lengths, n) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  let i = 0;
  for (; i < 144; i++) l[i] = 8;
  for (; i < 256; i++) l[i] = 9;
  for (; i < 280; i++) l[i] = 7;
  for (; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: buildHuff(l, 288), dist: buildHuff(d, 30) };
  return FIXED;
}

export function inflateRawSync(src) {
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let op = 0;
  let ip = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const grow = (need) => {
    if (op + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < op + need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(out.subarray(0, op));
    out = nb;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (ip >= src.length) throw new Error('압축 데이터가 중간에 끊겼습니다.');
      bitBuf |= src[ip++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const cnt = h.count[len];
      if (code - cnt < first) return h.symbol[index + (code - first)];
      index += cnt;
      first += cnt;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('잘못된 허프만 부호입니다.');
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      if (ip + 4 > src.length) throw new Error('압축 데이터가 중간에 끊겼습니다.');
      const len = src[ip] | (src[ip + 1] << 8);
      ip += 4;
      if (ip + len > src.length) throw new Error('압축 데이터가 중간에 끊겼습니다.');
      grow(len);
      out.set(src.subarray(ip, ip + len), op);
      op += len; ip += len;
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) {
        ({ lit, dist } = fixedTables());
      } else {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        const clh = buildHuff(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const sym = decode(clh);
          if (sym < 16) { lens[i++] = sym; continue; }
          let prev = 0, rep = 0;
          if (sym === 16) {
            if (i === 0) throw new Error('잘못된 부호 길이입니다.');
            prev = lens[i - 1]; rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) throw new Error('잘못된 부호 길이입니다.');
          while (rep--) lens[i++] = prev;
        }
        lit = buildHuff(lens.subarray(0, hlit), hlit);
        dist = buildHuff(lens.subarray(hlit), hdist);
      }
      for (;;) {
        let sym = decode(lit);
        if (sym < 256) {
          grow(1);
          out[op++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          sym -= 257;
          if (sym >= 29) throw new Error('잘못된 길이 부호입니다.');
          const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
          const ds = decode(dist);
          if (ds >= 30) throw new Error('잘못된 거리 부호입니다.');
          const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
          if (d > op) throw new Error('잘못된 거리 값입니다.');
          grow(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
        }
      }
    } else {
      throw new Error('알 수 없는 압축 블록입니다.');
    }
  } while (!last);
  return out.slice(0, op);
}

// ---------------------------------------------------------------------------

let CRC_TABLE = null;
export function crc32(data, crc = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
