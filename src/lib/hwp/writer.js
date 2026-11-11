// 문서 모델 + 저장 모델 → HWP 5.0 바이트
//
// 원칙: 바뀌지 않은 문단/컨트롤/구역은 원본 레코드를 바이트 그대로 내보낸다.
// 바뀐 문단만 다시 만들고, 줄 배치 정보(PARA_LINE_SEG)는 비워서 한글이 다시 계산하게 한다.

import { Writer, utf16leEncode } from '../bytes.js';
import { writeCfb } from '../cfb.js';
import { deflateRaw } from '../zlibx.js';
import { cssToColorRef, borderWidthIndex, sniffImage, pt2hu } from '../model.js';
import { TAG, serializeRecords, shiftLevel, ctrlIdFromString } from './records.js';

const BORDER_TYPE = ['none', 'solid', 'dash', 'dot', 'dashdot', 'dashdotdot', 'longdash', 'circle', 'double', 'thinthick', 'thickthin', 'triple', 'wave', 'doublewave'];
const ALIGN = { justify: 0, left: 1, right: 2, center: 3, distribute: 4 };
const LS_TYPE = { percent: 0, fixed: 1, spaceOnly: 2, minimum: 3 };

const isRecord = (o) => !!o && typeof o.tag === 'number' && o.data instanceof Uint8Array;
const relevel = (node, level) => shiftLevel(node, level - node.level);

function defaultLineSeg() {
  const d = new Uint8Array(36);
  new DataView(d.buffer).setUint32(32, 0x00060000, true);
  return d;
}

function ctrlChar(code, id) {
  const d = new Uint8Array(16);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, code, true);
  dv.setUint32(2, ctrlIdFromString(id), true);
  dv.setUint16(14, code, true);
  return d;
}

function defaultTab() {
  const d = new Uint8Array(16);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, 9, true);
  dv.setUint32(2, 4000, true);
  d[6] = 0; d[7] = 1;
  dv.setUint16(14, 9, true);
  return d;
}

function patchU32Msb(data, last) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = dv.getUint32(0, true);
  const want = ((v & 0x7fffffff) | (last ? 0x80000000 : 0)) >>> 0;
  if (v === want) return data;
  const out = data.slice();
  new DataView(out.buffer).setUint32(0, want, true);
  return out;
}

function patchListCount(node, count) {
  const data = node.data.slice();
  if (data.length >= 2) new DataView(data.buffer).setUint16(0, count, true);
  return { tag: node.tag, level: node.level, data, children: node.children };
}

let instanceSeed = (Math.floor(Math.random() * 0x3fffffff) + 0x40000000) >>> 0;
const nextInstanceId = () => { instanceSeed = (instanceSeed + 1) >>> 0; return instanceSeed; };

// ---------------------------------------------------------------------------
// 문서 정보(DocInfo)

function buildCharShapeData(cs, doc, faceId) {
  const base = doc.charShape(cs.baseId ?? cs.id);
  let d;
  if (base.origin && isRecord(base.origin) && base.origin.data.length >= 68) d = base.origin.data.slice();
  else {
    d = new Uint8Array(74);
    const dv0 = new DataView(d.buffer);
    for (let i = 0; i < 7; i++) { d[14 + i] = 100; d[28 + i] = 100; }
    dv0.setInt32(42, 1000, true);
    d[50] = 10; d[51] = 10;
    dv0.setUint32(60, 0xffffffff, true);
    dv0.setUint32(64, 0x00b2b2b2, true);
  }
  const dv = new DataView(d.buffer);
  const ref = base.origin && isRecord(base.origin) ? base : null;
  for (let lang = 0; lang < 7; lang++) {
    if (!ref || cs.fonts[lang] !== ref.fonts[lang]) dv.setUint16(lang * 2, faceId(lang, cs.fonts[lang]), true);
  }
  for (let i = 0; i < 7; i++) {
    if (!ref || cs.ratio !== ref.ratio) d[14 + i] = Math.max(50, Math.min(200, cs.ratio || 100));
    if (!ref || cs.spacing !== ref.spacing) d[21 + i] = Math.max(-50, Math.min(50, cs.spacing || 0)) & 0xff;
    if (!ref || cs.relSize !== ref.relSize) d[28 + i] = Math.max(10, Math.min(250, cs.relSize || 100));
    if (!ref || cs.offset !== ref.offset) d[35 + i] = Math.max(-100, Math.min(100, cs.offset || 0)) & 0xff;
  }
  dv.setInt32(42, Math.round(cs.size * 100), true);
  let attr = dv.getUint32(46, true);
  const setBit = (bit, on) => { attr = on ? (attr | (1 << bit)) >>> 0 : (attr & ~(1 << bit)) >>> 0; };
  setBit(0, cs.italic);
  setBit(1, cs.bold);
  if (!ref || cs.underline !== ref.underline) {
    attr = (attr & ~0xc) >>> 0;
    if (cs.underline === 'bottom' || cs.underline === 'top') {
      attr = (attr & ~0xf0) >>> 0; // 밑줄 모양: 실선
      attr = (attr | ((cs.underline === 'top' ? 3 : 1) << 2)) >>> 0;
    }
  }
  if (!ref || cs.strike !== ref.strike) {
    attr = (attr & ~(7 << 18)) >>> 0;
    if (cs.strike) { attr = (attr | (1 << 18)) >>> 0; attr = (attr & ~(0xf << 26)) >>> 0; }
  }
  setBit(15, cs.sup);
  setBit(16, cs.sub);
  dv.setUint32(46, attr >>> 0, true);
  dv.setUint32(52, cssToColorRef(cs.color), true);
  if (!ref || cs.shade !== ref.shade) dv.setUint32(60, cs.shade ? cssToColorRef(cs.shade) : 0xffffffff, true);
  return d;
}

function buildParaShapeData(ps, doc) {
  const base = doc.paraShape(ps.baseId ?? ps.id);
  let d;
  if (base.origin && isRecord(base.origin) && base.origin.data.length >= 28) d = base.origin.data.slice();
  else {
    d = new Uint8Array(54);
    new DataView(d.buffer).setUint32(0, 0x80, true);
  }
  const dv = new DataView(d.buffer);
  let attr1 = dv.getUint32(0, true);
  attr1 = (attr1 & ~(7 << 2)) >>> 0;
  attr1 = (attr1 | ((ALIGN[ps.align] ?? 0) << 2)) >>> 0;
  attr1 = ps.pageBreakBefore ? (attr1 | (1 << 19)) >>> 0 : (attr1 & ~(1 << 19)) >>> 0;
  attr1 = ps.keepWithNext ? (attr1 | (1 << 17)) >>> 0 : (attr1 & ~(1 << 17)) >>> 0;
  const type = LS_TYPE[ps.lineSpacingType] ?? 0;
  const value = type === 0 ? Math.round(ps.lineSpacing) : Math.round(ps.lineSpacing * 200);
  attr1 = (attr1 & ~3) >>> 0;
  attr1 = (attr1 | (type < 3 ? type : 0)) >>> 0;
  dv.setUint32(0, attr1, true);
  const dbl = (pt) => Math.round((pt || 0) * 200);
  dv.setInt32(4, dbl(ps.marginLeft), true);
  dv.setInt32(8, dbl(ps.marginRight), true);
  dv.setInt32(12, dbl(ps.indent), true);
  dv.setInt32(16, dbl(ps.spaceBefore), true);
  dv.setInt32(20, dbl(ps.spaceAfter), true);
  dv.setInt32(24, type < 3 ? value : 100, true);
  if (d.length >= 54) {
    const attr3 = dv.getUint32(46, true);
    dv.setUint32(46, ((attr3 & ~0x1f) | type) >>> 0, true);
    dv.setUint32(50, value, true);
  }
  return d;
}

function buildBorderFillData(bf) {
  const w = new Writer(64);
  w.u16(0);
  for (const side of [bf.left, bf.right, bf.top, bf.bottom]) {
    const s = side || { type: 'none', width: 0.1, color: '#000000' };
    const ti = BORDER_TYPE.indexOf(s.type);
    w.u8(ti < 0 ? 1 : ti).u8(borderWidthIndex(s.width || 0.12)).u32(cssToColorRef(s.color || '#000000'));
  }
  w.u8(1).u8(0).u32(0);
  w.u32(1).u32(bf.fill ? cssToColorRef(bf.fill) : 0xffffffff).u32(0xff000000).u32(0xffffffff);
  w.u32(0).u8(0);
  return w.toBytes();
}

function buildFaceData(name) {
  const w = new Writer(32);
  w.u8(0).lwstr(name);
  return w.toBytes();
}

function buildDocInfo(doc, ctx) {
  const b = doc.backing;
  const flat = b.docInfoFlat.map((r) => ({ tag: r.tag, level: r.level, data: r.data }));
  const counts = b.info.counts ? b.info.counts.slice() : null;
  if (!counts) throw new Error('문서 정보(ID_MAPPINGS)가 없어 저장할 수 없습니다.');
  const lastIndexOf = (tag) => { for (let i = flat.length - 1; i >= 0; i--) if (flat[i].tag === tag) return i; return -1; };
  const idMapIdx = flat.findIndex((r) => r.tag === TAG.ID_MAPPINGS);
  const insertAfterTag = (tag, fallbackTags, rec) => {
    let i = lastIndexOf(tag);
    for (const t of fallbackTags) { if (i >= 0) break; i = lastIndexOf(t); }
    if (i < 0) i = idMapIdx;
    flat.splice(i + 1, 0, rec);
  };

  // 글꼴: 언어별 이름 → 번호
  const faces = b.info.faces.map((list) => list.slice());
  const faceId = (lang, name) => {
    const list = faces[lang];
    let id = list.indexOf(name);
    if (id >= 0) return id;
    // 해당 언어 묶음의 끝에 새 글꼴 레코드를 끼운다.
    const firstFace = flat.findIndex((r) => r.tag === TAG.FACE_NAME);
    let pos = firstFace < 0 ? idMapIdx + 1 : firstFace;
    for (let l = 0; l <= lang; l++) pos += faces[l].length;
    flat.splice(pos, 0, { tag: TAG.FACE_NAME, level: 1, data: buildFaceData(name) });
    list.push(name);
    counts[1 + lang] = list.length;
    return list.length - 1;
  };

  const newCs = doc.charShapes.filter((s) => s.isNew).sort((a, b2) => a.id - b2.id);
  const newPs = doc.paraShapes.filter((s) => s.isNew).sort((a, b2) => a.id - b2.id);
  const newBf = doc.borderFills.filter((s) => s.isNew).sort((a, b2) => a.id - b2.id);
  for (const cs of newCs) {
    const data = buildCharShapeData(cs, doc, faceId);
    insertAfterTag(TAG.CHAR_SHAPE, [TAG.BORDER_FILL, TAG.FACE_NAME], { tag: TAG.CHAR_SHAPE, level: 1, data });
  }
  if (newCs.length) counts[9] = Math.max(counts[9], newCs[newCs.length - 1].id + 1);
  for (const ps of newPs) {
    insertAfterTag(TAG.PARA_SHAPE, [TAG.BULLET, TAG.NUMBERING, TAG.TAB_DEF, TAG.CHAR_SHAPE], { tag: TAG.PARA_SHAPE, level: 1, data: buildParaShapeData(ps, doc) });
  }
  if (newPs.length) counts[13] = Math.max(counts[13], newPs[newPs.length - 1].id + 1);
  for (const bf of newBf) {
    insertAfterTag(TAG.BORDER_FILL, [TAG.FACE_NAME], { tag: TAG.BORDER_FILL, level: 1, data: buildBorderFillData(bf) });
  }
  if (newBf.length) counts[8] = Math.max(counts[8], newBf[newBf.length - 1].id);
  for (const bin of ctx.newBins) {
    const w = new Writer(16);
    w.u16(0x0001).u16(bin.storageId).lwstr(bin.ext);
    insertAfterTag(TAG.BIN_DATA, [], { tag: TAG.BIN_DATA, level: 1, data: w.toBytes() });
  }
  counts[0] += ctx.newBins.length;

  // ID_MAPPINGS / DOCUMENT_PROPERTIES 갱신
  for (const r of flat) {
    if (r.tag === TAG.ID_MAPPINGS) {
      const d = r.data.slice();
      const dv = new DataView(d.buffer);
      for (let i = 0; i < counts.length && i * 4 + 4 <= d.length; i++) dv.setInt32(i * 4, counts[i], true);
      r.data = d;
    } else if (r.tag === TAG.DOCUMENT_PROPERTIES && r.data.length >= 2) {
      const d = r.data.slice();
      new DataView(d.buffer).setUint16(0, ctx.sectionCount, true);
      r.data = d;
    }
  }
  const w = new Writer(8192);
  for (const r of flat) serializeRecords([{ tag: r.tag, level: r.level, data: r.data, children: [] }], w);
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// 본문

class BodyWriter {
  constructor(doc, ctx) {
    this.doc = doc;
    this.ctx = ctx;
    this.firstParas = new Set(doc.sections.map((s) => s.paras[0]).filter(Boolean));
    let len = 22;
    const p0 = doc.sections[0] && doc.sections[0].paras[0];
    if (p0 && isRecord(p0.origin)) len = Math.max(22, Math.min(24, p0.origin.data.length));
    this.paraHeaderLen = len;
  }

  emitList(sparas, level, sec = null) {
    const out = [];
    const n = sparas.length;
    for (let i = 0; i < n; i++) out.push(this.emitPara(sparas[i], level, i === n - 1, i === 0 ? sec : null));
    return out;
  }

  emitPara(sp, level, isLast, sec) {
    const src = sp.src;
    const origin = src && isRecord(src.origin) ? src.origin : null;
    let force = false;
    if (origin) {
      const wasFirst = this.firstParas.has(src);
      const staysFirst = !!sec && !!sec.section && sec.section.paras[0] === src && !sec.pageDirty;
      if (wasFirst !== !!sec || (wasFirst && !staysFirst)) force = true;
    }
    if (origin && !sp.deep && !force) {
      const delta = level - origin.level;
      return { tag: origin.tag, level, data: patchU32Msb(origin.data, isLast), children: delta ? origin.children.map((c) => shiftLevel(c, delta)) : origin.children };
    }
    if (origin && !sp.own && !force) return this.rebuildNested(sp, origin, level, isLast);
    return this.regenPara(sp, origin, level, isLast, sec);
  }

  /** 문단 자체는 그대로이고 속의 표/글상자 내용만 바뀐 경우 */
  rebuildNested(sp, origin, level, isLast) {
    const delta = level - origin.level;
    const map = new Map();
    for (const it of sp.items) {
      if (it.t === 'ctrl' && it.deep && isRecord(it.ctrl.origin)) map.set(it.ctrl.origin, this.rebuildCtrl(it, level + 1));
    }
    const header = patchU32Msb(origin.data, isLast).slice();
    const children = [];
    let hadSeg = false;
    for (const c of origin.children) {
      if (c.tag === TAG.PARA_LINE_SEG) { children.push({ tag: c.tag, level: level + 1, data: defaultLineSeg(), children: [] }); hadSeg = true; }
      else if (map.has(c)) children.push(map.get(c));
      else children.push(delta ? shiftLevel(c, delta) : c);
    }
    if (hadSeg && header.length >= 18) new DataView(header.buffer).setUint16(16, 1, true);
    return { tag: origin.tag, level, data: header, children };
  }

  regenPara(sp, origin, level, isLast, sec) {
    const units = [];
    const runs = [];
    const ctrlNodes = [];
    let mask = 0;
    let curCs = null;
    const setCs = (cs) => {
      if (cs === curCs) return;
      if (runs.length && runs[runs.length - 1][0] === units.length) runs[runs.length - 1][1] = cs;
      else runs.push([units.length, cs]);
      curCs = cs;
    };
    const pushRaw = (raw) => {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < 8; i++) units.push(dv.getUint16(i * 2, true));
      mask |= 1 << units[units.length - 8];
    };
    const firstCs = sp.items.length ? sp.items[0].cs : sp.cs0 ?? 0;
    if (sec) {
      const tmpl = sec.section || this.doc.sections[0];
      for (const key of ['secd', 'cold']) {
        const it = tmpl[key];
        if (!it || !isRecord(it.ctrl.origin) || !it.ctrl.raw) continue;
        setCs(firstCs);
        pushRaw(it.ctrl.raw);
        let node = relevel(it.ctrl.origin, level + 1);
        if (key === 'secd' && sec.pageDirty && sec.page) node = this.patchPageDef(node, sec.page);
        ctrlNodes.push(node);
      }
    }
    for (const it of sp.items) {
      if (it.t === 'text') {
        setCs(it.cs);
        const s = it.text;
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c === 0xa0) c = 30;
          else if (c === 0x2007) c = 31;
          else if (c === 0xad) c = 24;
          else if (c < 32) continue;
          if (c < 32) mask |= 1 << c;
          units.push(c);
        }
      } else if (it.t === 'tab') {
        setCs(it.cs);
        const raw = it.src && it.src.raw && it.src.raw.length === 16 ? it.src.raw : defaultTab();
        pushRaw(raw);
      } else if (it.t === 'br') {
        setCs(it.cs);
        units.push(10);
        mask |= 1 << 10;
      } else if (it.t === 'ctrl') {
        const c = it.ctrl;
        let raw = null;
        let node = null;
        if (it.isNew) {
          if (c.kind === 'table') { node = this.newTable(it, level + 1); raw = ctrlChar(11, 'tbl '); }
          else if (c.kind === 'picture') { node = this.newPicture(it, level + 1); raw = ctrlChar(11, 'gso '); }
        } else if (isRecord(c.origin) && c.raw && c.raw.length === 16) {
          if (c.kind === 'secdef') continue;
          raw = c.raw;
          node = it.deep ? this.rebuildCtrl(it, level + 1) : relevel(c.origin, level + 1);
        } else if (!c.origin && c.raw && c.raw.length === 16) {
          raw = c.raw; // 필드 끝 같은 인라인 제어 문자
        }
        if (!raw) continue;
        setCs(it.cs);
        pushRaw(raw);
        if (node) ctrlNodes.push(node);
      }
    }
    units.push(13);
    if (!runs.length) runs.push([0, sp.cs0 ?? firstCs]);

    let header;
    if (origin) {
      header = new Uint8Array(Math.max(22, origin.data.length));
      header.set(origin.data);
    } else header = new Uint8Array(this.paraHeaderLen);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, (units.length | (isLast ? 0x80000000 : 0)) >>> 0, true);
    dv.setUint32(4, mask >>> 0, true);
    dv.setUint16(8, sp.paraShapeId, true);
    header[10] = sp.styleId & 0xff;
    let brk = origin ? header[11] : 0;
    brk = sp.pageBreak ? brk | 4 : brk & ~4;
    brk = sec ? brk | 3 : brk & ~3;
    header[11] = brk;
    dv.setUint16(12, runs.length, true);
    dv.setUint16(14, 0, true);
    dv.setUint16(16, 1, true);

    const children = [];
    if (units.length > 1) {
      const t = new Uint8Array(units.length * 2);
      const tdv = new DataView(t.buffer);
      for (let i = 0; i < units.length; i++) tdv.setUint16(i * 2, units[i], true);
      children.push({ tag: TAG.PARA_TEXT, level: level + 1, data: t, children: [] });
    }
    const cs = new Uint8Array(runs.length * 8);
    const cdv = new DataView(cs.buffer);
    runs.forEach((r, i) => { cdv.setUint32(i * 8, r[0], true); cdv.setUint32(i * 8 + 4, r[1], true); });
    children.push({ tag: TAG.PARA_CHAR_SHAPE, level: level + 1, data: cs, children: [] });
    children.push({ tag: TAG.PARA_LINE_SEG, level: level + 1, data: defaultLineSeg(), children: [] });
    for (const n of ctrlNodes) children.push(n);
    return { tag: TAG.PARA_HEADER, level, data: header, children };
  }

  patchPageDef(secdNode, page) {
    const children = secdNode.children.map((c) => {
      if (c.tag !== TAG.PAGE_DEF || c.data.length < 40) return c;
      const d = c.data.slice();
      const dv = new DataView(d.buffer);
      const land = !!page.landscape;
      dv.setUint32(0, pt2hu(land ? page.height : page.width), true);
      dv.setUint32(4, pt2hu(land ? page.width : page.height), true);
      dv.setUint32(8, pt2hu(page.marginLeft), true);
      dv.setUint32(12, pt2hu(page.marginRight), true);
      dv.setUint32(16, pt2hu(page.marginTop), true);
      dv.setUint32(20, pt2hu(page.marginBottom), true);
      dv.setUint32(24, pt2hu(page.marginHeader), true);
      dv.setUint32(28, pt2hu(page.marginFooter), true);
      dv.setUint32(32, pt2hu(page.gutter || 0), true);
      const attr = dv.getUint32(36, true);
      dv.setUint32(36, land ? (attr | 1) >>> 0 : (attr & ~1) >>> 0, true);
      return { tag: c.tag, level: c.level, data: d, children: c.children };
    });
    return { tag: secdNode.tag, level: secdNode.level, data: secdNode.data, children };
  }

  /** 원본이 있는 컨트롤을 속 내용을 바꿔서 다시 만든다. */
  rebuildCtrl(it, lvl) {
    const c = it.ctrl;
    const o = c.origin;
    const delta = lvl - o.level;
    const sh = (n) => (delta ? shiftLevel(n, delta) : n);
    const kids = [];
    const emitCaption = (endIndex) => {
      if (c.caption && it.capParas && isRecord(c.caption.listHeader)) {
        const lh = sh(c.caption.listHeader);
        kids.push(patchListCount(lh, it.capParas.length));
        kids.push(...this.emitList(it.capParas, lh.level));
      } else for (const k of o.children.slice(0, endIndex)) kids.push(sh(k));
    };
    if (c.kind === 'table' && it.cells && c.tableRecord) {
      const ti = o.children.indexOf(c.tableRecord);
      emitCaption(ti);
      const cells = it.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
      let tableRec = sh(c.tableRecord);
      let header = o.data;
      if (it.structChanged) {
        tableRec = { tag: tableRec.tag, level: tableRec.level, data: this.rebuildTableData(c.tableRecord.data, it, cells), children: [] };
        header = this.patchObjSize(header, it, cells);
      }
      kids.push(tableRec);
      const anyCell = c.cells.find((x) => isRecord(x.listHeader));
      for (const cell of cells) {
        const tmpl = (cell.cell && isRecord(cell.cell.listHeader) ? cell.cell : null) || (cell.tmpl && isRecord(cell.tmpl.listHeader) ? cell.tmpl : null) || anyCell;
        const lh = sh(tmpl.listHeader);
        const geom = it.structChanged || !cell.cell;
        kids.push({ tag: lh.tag, level: lh.level, data: this.patchCellHeader(lh.data, cell, geom), children: [] });
        kids.push(...this.emitList(cell.paras, lh.level));
      }
      for (const k of c.tail || []) kids.push(sh(k));
      return { tag: o.tag, level: lvl, data: header, children: kids };
    }
    if (c.kind === 'textbox' && it.paras && c.shapeNode && isRecord(c.listHeader)) {
      const si = o.children.indexOf(c.shapeNode);
      emitCaption(si);
      const sc = sh(c.shapeNode);
      const lhOrig = c.listHeader;
      const skip = new Set(c.paras.map((p) => p.origin));
      const scKids = [];
      for (const k of c.shapeNode.children) {
        if (k === lhOrig) {
          const lh = sh(k);
          scKids.push(patchListCount(lh, it.paras.length));
          scKids.push(...this.emitList(it.paras, lh.level));
        } else if (skip.has(k)) continue;
        else scKids.push(sh(k));
      }
      kids.push({ tag: sc.tag, level: sc.level, data: sc.data, children: scKids });
      for (const k of o.children.slice(si + 1)) kids.push(sh(k));
      return { tag: o.tag, level: lvl, data: o.data, children: kids };
    }
    if ((c.kind === 'note' || c.kind === 'hf') && it.paras && isRecord(c.listHeader)) {
      const skip = new Set(c.paras.map((p) => p.origin));
      for (const k of o.children) {
        if (k === c.listHeader) {
          const lh = sh(k);
          kids.push(patchListCount(lh, it.paras.length));
          kids.push(...this.emitList(it.paras, lh.level));
        } else if (skip.has(k)) continue;
        else kids.push(sh(k));
      }
      return { tag: o.tag, level: lvl, data: o.data, children: kids };
    }
    if (c.caption && it.capParas) {
      const idx = o.children.findIndex((k) => k.tag === TAG.SHAPE_COMPONENT || k.tag === TAG.TABLE);
      emitCaption(idx < 0 ? 0 : idx);
      for (const k of o.children.slice(idx < 0 ? 0 : idx)) kids.push(sh(k));
      return { tag: o.tag, level: lvl, data: o.data, children: kids };
    }
    return sh(o);
  }

  rowHeights(it, cells) {
    const h = new Array(it.rows).fill(0);
    for (const c of cells) if (c.rowSpan === 1 && c.row < h.length) h[c.row] = Math.max(h[c.row], pt2hu(c.height || 0));
    return h;
  }

  patchObjSize(header, it, cells) {
    if (header.length < 24) return header;
    const d = header.slice();
    const dv = new DataView(d.buffer);
    let w = 0;
    if (it.colWidths && it.colWidths.length) for (const x of it.colWidths) w += x;
    else w = it.tableWidth || 0;
    if (w > 0) dv.setUint32(16, pt2hu(w), true);
    const total = this.rowHeights(it, cells).reduce((a, b) => a + b, 0);
    if (total > 0) dv.setUint32(20, total, true);
    return d;
  }

  rebuildTableData(orig, it, cells) {
    const dv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);
    const oldRows = orig.length >= 6 ? dv.getUint16(4, true) : 0;
    const w = new Writer(64);
    w.bytes(orig.subarray(0, 4));
    w.u16(it.rows).u16(it.cols);
    w.bytes(orig.subarray(8, 18));
    const perRow = new Array(it.rows).fill(0);
    for (const c of cells) if (c.row < perRow.length) perRow[c.row]++;
    for (const n of perRow) w.u16(n);
    const rest = 18 + oldRows * 2;
    if (rest <= orig.length) w.bytes(orig.subarray(rest));
    else w.u16(1).u16(0);
    return w.toBytes();
  }

  patchCellHeader(data, cell, geom) {
    const d = data.slice();
    const dv = new DataView(d.buffer);
    if (d.length >= 2) dv.setUint16(0, cell.paras.length, true);
    if (geom && d.length >= 34) {
      dv.setUint16(8, cell.col, true);
      dv.setUint16(10, cell.row, true);
      dv.setUint16(12, cell.colSpan, true);
      dv.setUint16(14, cell.rowSpan, true);
      if (cell.width > 0) dv.setUint32(16, pt2hu(cell.width), true);
      if (cell.height > 0) dv.setUint32(20, pt2hu(cell.height), true);
      if (cell.borderFillId) dv.setUint16(32, cell.borderFillId, true);
      if (d.length >= 38 && cell.width > 0) dv.setUint32(34, pt2hu(cell.width), true);
    }
    return d;
  }

  newCellHeader(cell) {
    const d = new Uint8Array(47);
    const dv = new DataView(d.buffer);
    dv.setUint16(0, cell.paras.length, true);
    dv.setUint32(4, 0x20, true); // 세로 가운데 정렬
    dv.setUint16(8, cell.col, true);
    dv.setUint16(10, cell.row, true);
    dv.setUint16(12, cell.colSpan, true);
    dv.setUint16(14, cell.rowSpan, true);
    dv.setUint32(16, pt2hu(cell.width), true);
    dv.setUint32(20, pt2hu(cell.height), true);
    dv.setUint16(24, 510, true); dv.setUint16(26, 510, true); dv.setUint16(28, 141, true); dv.setUint16(30, 141, true);
    dv.setUint16(32, cell.borderFillId || 1, true);
    dv.setUint32(34, pt2hu(cell.width), true);
    return d;
  }

  newTable(it, lvl) {
    const cells = it.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
    let width = 0;
    if (it.colWidths && it.colWidths.length) for (const x of it.colWidths) width += x;
    else width = it.tableWidth || 0;
    const heights = this.rowHeights(it, cells);
    const total = heights.reduce((a, b) => a + b, 0);
    const h = new Writer(48);
    h.u32(ctrlIdFromString('tbl '));
    h.u32(it.ctrl.inline ? 0x082a2211 : 0x082a2210);
    h.i32(0).i32(0).u32(pt2hu(width)).u32(total).i32(this.ctx.nextZ++);
    h.i16(283).i16(283).i16(283).i16(283);
    h.u32(nextInstanceId()).u32(0).u16(0);
    const t = new Writer(32);
    t.u32(0x04000006).u16(it.rows).u16(it.cols).u16(0);
    t.u16(510).u16(510).u16(141).u16(141);
    const perRow = new Array(it.rows).fill(0);
    for (const c of cells) if (c.row < perRow.length) perRow[c.row]++;
    for (const n of perRow) t.u16(n);
    t.u16(cells.length ? cells[0].borderFillId || 1 : 1).u16(0);
    const kids = [{ tag: TAG.TABLE, level: lvl + 1, data: t.toBytes(), children: [] }];
    for (const cell of cells) {
      kids.push({ tag: TAG.LIST_HEADER, level: lvl + 1, data: this.newCellHeader(cell), children: [] });
      kids.push(...this.emitList(cell.paras, lvl + 1));
    }
    return { tag: TAG.CTRL_HEADER, level: lvl, data: h.toBytes(), children: kids };
  }

  newPicture(it, lvl) {
    const c = it.ctrl;
    const binId = this.ctx.addBin(c.bytes, c.ext);
    const W = Math.max(1, pt2hu(c.width));
    const H = Math.max(1, pt2hu(c.height));
    const info = sniffImage(c.bytes);
    const W0 = info && info.width ? info.width * 75 : W;
    const H0 = info && info.height ? info.height * 75 : H;
    const h = new Writer(48);
    h.u32(ctrlIdFromString('gso ')).u32(0x042a2211);
    h.i32(0).i32(0).u32(W).u32(H).i32(this.ctx.nextZ++);
    h.i16(0).i16(0).i16(0).i16(0);
    h.u32(nextInstanceId()).u32(0).u16(0);
    const s = new Writer(200);
    const pic = ctrlIdFromString('$pic');
    s.u32(pic).u32(pic).i32(0).i32(0).u16(0).u16(1).u32(W0).u32(H0).u32(W).u32(H).u32(0x24080000).i16(0).i32(W >> 1).i32(H >> 1).u16(1);
    const dbl = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); s.bytes(b); };
    for (const v of [1, 0, 0, 0, 1, 0]) dbl(v);
    for (const v of [W / W0, 0, 0, 0, H / H0, 0]) dbl(v);
    for (const v of [1, 0, 0, 0, 1, 0]) dbl(v);
    const p = new Writer(84);
    p.u32(0).i32(0).u32(0);
    p.i32(0).i32(0).i32(W0).i32(0).i32(W0).i32(H0).i32(0).i32(H0);
    p.i32(0).i32(0).i32(W0).i32(H0);
    p.u16(0).u16(0).u16(0).u16(0);
    p.u8(0).u8(0).u8(0).u16(binId).u8(0).u32(nextInstanceId()).u32(0);
    const picNode = { tag: TAG.SHAPE_COMPONENT_PICTURE, level: lvl + 2, data: p.toBytes(), children: [] };
    const scNode = { tag: TAG.SHAPE_COMPONENT, level: lvl + 1, data: s.toBytes(), children: [picNode] };
    return { tag: TAG.CTRL_HEADER, level: lvl, data: h.toBytes(), children: [scNode] };
  }
}

function previewText(model, limit = 1000) {
  const lines = [];
  let total = 0;
  const visit = (paras) => {
    for (const p of paras) {
      if (total >= limit) return;
      let line = '';
      for (const it of p.items) {
        if (it.t === 'text') line += it.text;
        else if (it.t === 'tab') line += '\t';
      }
      const cellTexts = [];
      for (const it of p.items) {
        if (it.t === 'ctrl' && it.cells) {
          for (const c of it.cells) { const sub = []; const save = lines.length; visit(c.paras); sub.push(...lines.splice(save)); cellTexts.push(`<${sub.join(' ')}>`); }
        }
      }
      line += cellTexts.join('');
      lines.push(line);
      total += line.length + 2;
    }
  };
  for (const s of model.sections) visit(s.paras);
  return lines.join('\r\n').slice(0, limit);
}

/**
 * HWP 5.0 으로 저장한다. doc.backing 은 바꾸지 않는다.
 */
export async function writeHwp(doc, model) {
  const b = doc.backing;
  if (!b || b.kind !== 'hwp') throw new Error('HWP 원본 정보가 없는 문서입니다.');
  const compressed = b.header.compressed;
  const pack = async (bytes) => (compressed ? deflateRaw(bytes) : bytes);

  let maxStorage = 0;
  for (const item of b.info.binItems) if (item.storageId > maxStorage) maxStorage = item.storageId;
  const ctx = {
    newBins: [],
    nextZ: 1000,
    sectionCount: model.sections.length,
    addBin(bytes, ext) {
      const found = this.newBins.find((x) => x.bytes === bytes);
      if (found) return found.index;
      const entry = { bytes, ext: (ext || 'png').toLowerCase(), storageId: ++maxStorage, index: b.info.binItems.length + this.newBins.length + 1 };
      this.newBins.push(entry);
      return entry.index;
    },
  };

  const writer = new BodyWriter(doc, ctx);
  const origByPath = new Map(b.cfb.entries.map((e) => [e.path, e]));
  const sectionStreams = [];
  for (let i = 0; i < model.sections.length; i++) {
    const ms = model.sections[i];
    const si = ms.section ? doc.sections.indexOf(ms.section) : -1;
    const orig = si >= 0 ? origByPath.get(b.sections[si].path) : null;
    if (ms.clean && orig) { sectionStreams.push(orig.data); continue; }
    const nodes = writer.emitList(ms.paras, 0, { section: ms.section, page: ms.page, pageDirty: ms.pageDirty });
    sectionStreams.push(await pack(serializeRecords(nodes).toBytes()));
  }
  const docInfo = await pack(buildDocInfo(doc, ctx));

  const entries = [];
  let bodyDone = false;
  const pushBody = () => {
    if (bodyDone) return;
    bodyDone = true;
    entries.push({ path: 'BodyText', type: 'storage' });
    sectionStreams.forEach((data, i) => entries.push({ path: `BodyText/Section${i}`, type: 'stream', data }));
  };
  for (const e of b.cfb.entries) {
    if (e.path === 'BodyText' || e.path.startsWith('BodyText/')) { pushBody(); continue; }
    if (e.path === 'DocInfo') { entries.push({ ...e, data: docInfo }); continue; }
    if (e.path === 'PrvText') { entries.push({ ...e, data: utf16leEncode(previewText(model)) }); continue; }
    entries.push(e);
  }
  pushBody();
  for (const bin of ctx.newBins) {
    const name = `BIN${bin.storageId.toString(16).toUpperCase().padStart(4, '0')}.${bin.ext}`;
    entries.push({ path: `BinData/${name}`, type: 'stream', data: await pack(bin.bytes) });
  }
  return writeCfb({ rootClsid: b.cfb.rootClsid, rootCtime: b.cfb.rootCtime, rootMtime: b.cfb.rootMtime, entries });
}
