// 복합 파일(Compound File Binary, OLE2) 읽기/쓰기
// HWP 5.0 파일의 컨테이너 형식이다.

import { Reader, concatBytes, utf16leDecode } from './bytes.js';

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;
const MINI_CUTOFF = 4096;

export function isCfb(u8) {
  if (u8.length < 512) return false;
  for (let i = 0; i < 8; i++) if (u8[i] !== SIG[i]) return false;
  return true;
}

/**
 * 복합 파일을 읽는다.
 * 반환: { rootClsid, entries: [{ path, name, type: 'storage'|'stream', data, clsid, stateBits, ctime, mtime }] }
 * entries 는 디렉터리 트리를 (저장소 먼저, 이름순) 순회한 순서이다.
 */
export function readCfb(u8) {
  if (!isCfb(u8)) throw new Error('복합 파일(OLE) 형식이 아닙니다.');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sectorShift = dv.getUint16(0x1e, true);
  const miniShift = dv.getUint16(0x20, true);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('지원하지 않는 섹터 크기입니다.');
  const ssz = 1 << sectorShift;
  const msz = 1 << miniShift;
  const numFat = dv.getUint32(0x2c, true);
  const firstDir = dv.getUint32(0x30, true);
  const cutoff = dv.getUint32(0x38, true) || MINI_CUTOFF;
  const firstMiniFat = dv.getUint32(0x3c, true);
  const firstDifat = dv.getUint32(0x44, true);
  const numDifat = dv.getUint32(0x48, true);
  const totalSectors = Math.floor((u8.length - ssz) / ssz) + (((u8.length - ssz) % ssz) ? 1 : 0);
  const sectorOff = (n) => (n + 1) * ssz;

  // DIFAT
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getUint32(0x4c + i * 4, true);
    if (s !== FREESECT && s < totalSectors) fatSectors.push(s);
  }
  {
    let s = firstDifat;
    let guard = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < totalSectors && guard++ <= numDifat + 16) {
      const off = sectorOff(s);
      const per = ssz / 4 - 1;
      for (let i = 0; i < per; i++) {
        const v = dv.getUint32(off + i * 4, true);
        if (v !== FREESECT && v < totalSectors) fatSectors.push(v);
      }
      s = dv.getUint32(off + per * 4, true);
    }
  }
  void numFat;

  // FAT
  const perFat = ssz / 4;
  const fat = new Uint32Array(fatSectors.length * perFat);
  fatSectors.forEach((s, i) => {
    const off = sectorOff(s);
    for (let k = 0; k < perFat; k++) {
      const p = off + k * 4;
      fat[i * perFat + k] = p + 4 <= u8.length ? dv.getUint32(p, true) : FREESECT;
    }
  });

  const chain = (start, limitBytes) => {
    const list = [];
    let s = start;
    const seen = new Set();
    while (s !== ENDOFCHAIN && s !== FREESECT && s < totalSectors) {
      if (seen.has(s)) throw new Error('복합 파일의 섹터 사슬이 순환합니다.');
      seen.add(s);
      list.push(s);
      if (limitBytes !== undefined && list.length * ssz >= limitBytes) break;
      s = s < fat.length ? fat[s] : ENDOFCHAIN;
    }
    return list;
  };
  const readChain = (start, size) => {
    const sectors = chain(start, size);
    const out = new Uint8Array(sectors.length * ssz);
    sectors.forEach((s, i) => {
      const off = sectorOff(s);
      const part = u8.subarray(off, Math.min(off + ssz, u8.length));
      out.set(part, i * ssz);
    });
    return size === undefined ? out : out.subarray(0, Math.min(size, out.length));
  };

  // 디렉터리
  const dirBytes = readChain(firstDir);
  const dirDv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const nEntries = Math.floor(dirBytes.length / 128);
  const raw = [];
  for (let i = 0; i < nEntries; i++) {
    const o = i * 128;
    const nameLen = dirDv.getUint16(o + 0x40, true);
    const type = dirBytes[o + 0x42];
    const name = nameLen >= 2 ? utf16leDecode(dirBytes.subarray(o, o + Math.min(nameLen - 2, 62))) : '';
    raw.push({
      name, type,
      left: dirDv.getUint32(o + 0x44, true),
      right: dirDv.getUint32(o + 0x48, true),
      child: dirDv.getUint32(o + 0x4c, true),
      clsid: dirBytes.slice(o + 0x50, o + 0x60),
      stateBits: dirDv.getUint32(o + 0x60, true),
      ctime: dirBytes.slice(o + 0x64, o + 0x6c),
      mtime: dirBytes.slice(o + 0x6c, o + 0x74),
      start: dirDv.getUint32(o + 0x74, true),
      size: dirDv.getUint32(o + 0x78, true),
    });
  }
  if (!raw.length || raw[0].type !== 5) throw new Error('복합 파일의 루트 항목이 없습니다.');
  const root = raw[0];

  // 미니 스트림
  const miniStream = root.start !== ENDOFCHAIN && root.size > 0 ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatBytes = firstMiniFat !== ENDOFCHAIN ? readChain(firstMiniFat) : new Uint8Array(0);
  const miniFatDv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFatLen = Math.floor(miniFatBytes.length / 4);
  const readMini = (start, size) => {
    const out = new Uint8Array(size);
    let s = start;
    let done = 0;
    const seen = new Set();
    while (done < size && s !== ENDOFCHAIN && s !== FREESECT) {
      if (seen.has(s)) throw new Error('복합 파일의 미니 섹터 사슬이 순환합니다.');
      seen.add(s);
      const off = s * msz;
      const n = Math.min(msz, size - done);
      out.set(miniStream.subarray(off, off + n), done);
      done += n;
      s = s < miniFatLen ? miniFatDv.getUint32(s * 4, true) : ENDOFCHAIN;
    }
    return out;
  };

  const entries = [];
  const visited = new Set();
  const walk = (idx, prefix) => {
    // 형제 트리를 중위 순회
    const stack = [];
    let cur = idx;
    const order = [];
    while ((cur !== NOSTREAM && cur < raw.length) || stack.length) {
      while (cur !== NOSTREAM && cur < raw.length) {
        if (visited.has(cur)) { cur = NOSTREAM; break; }
        visited.add(cur);
        stack.push(cur);
        cur = raw[cur].left;
      }
      if (!stack.length) break;
      const n = stack.pop();
      order.push(n);
      cur = raw[n].right;
    }
    for (const n of order) {
      const e = raw[n];
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === 1) {
        entries.push({ path, name: e.name, type: 'storage', data: null, clsid: e.clsid, stateBits: e.stateBits, ctime: e.ctime, mtime: e.mtime });
        if (e.child !== NOSTREAM) walk(e.child, path);
      } else if (e.type === 2) {
        const data = e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size).slice();
        entries.push({ path, name: e.name, type: 'stream', data, clsid: e.clsid, stateBits: e.stateBits, ctime: e.ctime, mtime: e.mtime });
      }
    }
  };
  if (root.child !== NOSTREAM) walk(root.child, '');

  return { rootClsid: root.clsid, rootCtime: root.ctime, rootMtime: root.mtime, entries };
}

// ---------------------------------------------------------------------------
// 쓰기

function cmpNames(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  for (let i = 0; i < ua.length; i++) {
    const d = ua.charCodeAt(i) - ub.charCodeAt(i);
    if (d) return d;
  }
  return 0;
}

/**
 * 복합 파일을 만든다.
 * input: { rootClsid?, entries: [{ path, type: 'storage'|'stream', data?, clsid?, stateBits?, ctime?, mtime? }] }
 * 저장소 항목이 빠져 있어도 스트림 경로에서 자동으로 만들어진다.
 */
export function writeCfb(input) {
  const SSZ = 512;
  const MSZ = 64;
  // 1) 트리 구성
  const rootNode = { name: 'Root Entry', type: 5, children: new Map(), clsid: input.rootClsid, ctime: input.rootCtime, mtime: input.rootMtime, data: null };
  const ensureStorage = (parts) => {
    let node = rootNode;
    for (const p of parts) {
      let c = node.children.get(p);
      if (!c) {
        c = { name: p, type: 1, children: new Map(), data: null };
        node.children.set(p, c);
      }
      if (c.type !== 1) throw new Error(`경로 충돌: ${parts.join('/')}`);
      node = c;
    }
    return node;
  };
  for (const e of input.entries) {
    const parts = e.path.split('/');
    for (const p of parts) if (p.length > 31) throw new Error(`이름이 너무 깁니다: ${p}`);
    if (e.type === 'storage') {
      const n = ensureStorage(parts);
      n.clsid = e.clsid; n.stateBits = e.stateBits; n.ctime = e.ctime; n.mtime = e.mtime;
    } else {
      const parent = ensureStorage(parts.slice(0, -1));
      const name = parts[parts.length - 1];
      parent.children.set(name, { name, type: 2, children: null, data: e.data || new Uint8Array(0), clsid: e.clsid, stateBits: e.stateBits, ctime: e.ctime, mtime: e.mtime });
    }
  }
  // 2) 디렉터리 항목 번호 부여 (루트=0, 이후 깊이 우선)
  const dir = [rootNode];
  rootNode.index = 0;
  const assign = (node) => {
    const kids = [...node.children.values()].sort((a, b) => cmpNames(a.name, b.name));
    for (const k of kids) { k.index = dir.length; dir.push(k); }
    // 균형 이진 트리
    const build = (lo, hi) => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1;
      const n = kids[mid];
      n.left = build(lo, mid - 1);
      n.right = build(mid + 1, hi);
      return n.index;
    };
    node.child = build(0, kids.length - 1);
    for (const k of kids) if (k.type === 1) assign(k);
  };
  assign(rootNode);

  // 3) 스트림 배치
  const streams = dir.filter((n) => n.type === 2);
  const bigStreams = streams.filter((n) => n.data.length >= MINI_CUTOFF);
  const miniStreams = streams.filter((n) => n.data.length < MINI_CUTOFF);
  // 미니 스트림 컨테이너
  let miniSectors = 0;
  for (const n of miniStreams) {
    if (n.data.length === 0) { n.start = ENDOFCHAIN; continue; }
    n.start = miniSectors;
    miniSectors += Math.ceil(n.data.length / MSZ);
  }
  const miniContainer = new Uint8Array(miniSectors * MSZ);
  const miniFat = new Uint32Array(Math.ceil(miniSectors / (SSZ / 4)) * (SSZ / 4)).fill(FREESECT);
  for (const n of miniStreams) {
    if (n.data.length === 0) continue;
    miniContainer.set(n.data, n.start * MSZ);
    const cnt = Math.ceil(n.data.length / MSZ);
    for (let i = 0; i < cnt; i++) miniFat[n.start + i] = i === cnt - 1 ? ENDOFCHAIN : n.start + i + 1;
  }

  const secCount = (bytes) => Math.ceil(bytes / SSZ);
  let next = 0;
  const alloc = (count) => { const s = next; next += count; return s; };
  const layout = [];
  for (const n of bigStreams) {
    const c = secCount(n.data.length);
    n.start = alloc(c);
    layout.push({ start: n.start, count: c, data: n.data });
  }
  const miniContSecs = secCount(miniContainer.length);
  const miniContStart = miniContSecs ? alloc(miniContSecs) : ENDOFCHAIN;
  if (miniContSecs) layout.push({ start: miniContStart, count: miniContSecs, data: miniContainer });
  const miniFatBytes = new Uint8Array(miniFat.buffer);
  const miniFatSecs = secCount(miniFatBytes.length);
  const miniFatStart = miniFatSecs ? alloc(miniFatSecs) : ENDOFCHAIN;
  if (miniFatSecs) layout.push({ start: miniFatStart, count: miniFatSecs, data: miniFatBytes });
  const dirSecs = Math.ceil(dir.length / 4);
  const dirStart = alloc(dirSecs);
  const dataSectors = next;

  // 4) FAT / DIFAT 크기 결정
  let fatSecs = 0;
  let difSecs = 0;
  for (;;) {
    const total = dataSectors + fatSecs + difSecs;
    const needFat = Math.ceil(total / (SSZ / 4));
    const needDif = needFat > 109 ? Math.ceil((needFat - 109) / (SSZ / 4 - 1)) : 0;
    if (needFat === fatSecs && needDif === difSecs) break;
    fatSecs = needFat; difSecs = needDif;
  }
  const fatStart = alloc(fatSecs);
  const difStart = difSecs ? alloc(difSecs) : ENDOFCHAIN;
  const totalSecs = next;

  const fat = new Uint32Array(fatSecs * (SSZ / 4)).fill(FREESECT);
  const link = (start, count) => {
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
  };
  for (const l of layout) link(l.start, l.count);
  link(dirStart, dirSecs);
  for (let i = 0; i < fatSecs; i++) fat[fatStart + i] = FATSECT;
  for (let i = 0; i < difSecs; i++) fat[difStart + i] = DIFSECT;

  // 5) 파일 조립
  const out = new Uint8Array((totalSecs + 1) * SSZ);
  const dv = new DataView(out.buffer);
  out.set(SIG, 0);
  dv.setUint16(0x18, 0x003e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x28, 0, true);
  dv.setUint32(0x2c, fatSecs, true);
  dv.setUint32(0x30, dirStart, true);
  dv.setUint32(0x34, 0, true);
  dv.setUint32(0x38, MINI_CUTOFF, true);
  dv.setUint32(0x3c, miniFatStart, true);
  dv.setUint32(0x40, miniFatSecs, true);
  dv.setUint32(0x44, difStart, true);
  dv.setUint32(0x48, difSecs, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, i < fatSecs ? fatStart + i : FREESECT, true);
  const off = (s) => (s + 1) * SSZ;
  for (const l of layout) out.set(l.data, off(l.start));
  // 디렉터리
  const dirOff = off(dirStart);
  for (let i = 0; i < dirSecs * 4; i++) {
    const o = dirOff + i * 128;
    const n = dir[i];
    if (!n) {
      dv.setUint32(o + 0x44, NOSTREAM, true);
      dv.setUint32(o + 0x48, NOSTREAM, true);
      dv.setUint32(o + 0x4c, NOSTREAM, true);
      continue;
    }
    for (let k = 0; k < n.name.length; k++) dv.setUint16(o + k * 2, n.name.charCodeAt(k), true);
    dv.setUint16(o + 0x40, (n.name.length + 1) * 2, true);
    out[o + 0x42] = n.type;
    out[o + 0x43] = 1; // 검정
    dv.setUint32(o + 0x44, n.type === 5 ? NOSTREAM : n.left, true);
    dv.setUint32(o + 0x48, n.type === 5 ? NOSTREAM : n.right, true);
    dv.setUint32(o + 0x4c, n.type === 2 ? NOSTREAM : n.child, true);
    if (n.clsid && n.clsid.length === 16) out.set(n.clsid, o + 0x50);
    dv.setUint32(o + 0x60, n.stateBits || 0, true);
    if (n.ctime && n.ctime.length === 8) out.set(n.ctime, o + 0x64);
    if (n.mtime && n.mtime.length === 8) out.set(n.mtime, o + 0x6c);
    if (n.type === 5) {
      dv.setUint32(o + 0x74, miniContStart, true);
      dv.setUint32(o + 0x78, miniContainer.length, true);
    } else if (n.type === 2) {
      dv.setUint32(o + 0x74, n.data.length ? n.start : ENDOFCHAIN, true);
      dv.setUint32(o + 0x78, n.data.length, true);
    } else {
      dv.setUint32(o + 0x74, 0, true);
      dv.setUint32(o + 0x78, 0, true);
    }
  }
  // FAT
  out.set(new Uint8Array(fat.buffer), off(fatStart));
  // DIFAT 섹터
  if (difSecs) {
    const per = SSZ / 4 - 1;
    let idx = 109;
    for (let i = 0; i < difSecs; i++) {
      const o = off(difStart + i);
      for (let k = 0; k < per; k++, idx++) dv.setUint32(o + k * 4, idx < fatSecs ? fatStart + idx : FREESECT, true);
      dv.setUint32(o + per * 4, i === difSecs - 1 ? ENDOFCHAIN : difStart + i + 1, true);
    }
  }
  return out;
}

export { Reader, concatBytes };
