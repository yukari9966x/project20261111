// 형식 중립 문서 모델 도우미.
//
// Doc {
//   format: 'hwp' | 'hwpx', backing: 형식별 원본 보존 구조,
//   charShapes / paraShapes / borderFills / styles: 중립 속성 목록 (id 는 원본 형식의 번호),
//   sections: [{ page, columns, paras, headers/footers 는 문단 속 컨트롤로 존재 }],
//   bin: Map(id → { id, ext, mime, getBytes() })
// }
// Para { uid, origin, paraShapeId, styleId, pageBreak, columnBreak, items }
// Item  { t:'text', text, cs } | { t:'tab', cs, raw? } | { t:'br', cs } | { t:'ctrl', cs, ctrl }

export const HWPUNIT_PER_PT = 100;
export const hu2pt = (v) => v / HWPUNIT_PER_PT;
export const pt2hu = (v) => Math.round(v * HWPUNIT_PER_PT);
export const mm2pt = (mm) => (mm * 72) / 25.4;
export const pt2mm = (pt) => (pt * 25.4) / 72;

/** HWP COLORREF(0x00BBGGRR) → '#rrggbb' */
export function colorRefToCss(v) {
  const r = v & 0xff, g = (v >> 8) & 0xff, b = (v >> 16) & 0xff;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** '#rrggbb' → COLORREF */
export function cssToColorRef(css) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css || '');
  if (!m) return 0;
  return parseInt(m[1], 16) | (parseInt(m[2], 16) << 8) | (parseInt(m[3], 16) << 16);
}

export const BORDER_WIDTH_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
export function borderWidthIndex(mm) {
  let best = 0;
  let diff = Infinity;
  BORDER_WIDTH_MM.forEach((w, i) => { const d = Math.abs(w - mm); if (d < diff) { diff = d; best = i; } });
  return best;
}

export const DEFAULT_CHAR_SHAPE = {
  fonts: ['함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕'],
  size: 10, bold: false, italic: false, underline: 'none', strike: false, sup: false, sub: false,
  color: '#000000', shade: null, spacing: 0, ratio: 100, relSize: 100, offset: 0,
};
export const DEFAULT_PARA_SHAPE = {
  align: 'justify', marginLeft: 0, marginRight: 0, indent: 0, spaceBefore: 0, spaceAfter: 0,
  lineSpacingType: 'percent', lineSpacing: 160, pageBreakBefore: false, keepWithNext: false,
};

const CHAR_KEYS = ['fonts', 'size', 'bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'color', 'shade', 'spacing', 'ratio', 'relSize', 'offset'];
const PARA_KEYS = ['align', 'marginLeft', 'marginRight', 'indent', 'spaceBefore', 'spaceAfter', 'lineSpacingType', 'lineSpacing', 'pageBreakBefore', 'keepWithNext'];

function shapeKey(shape, keys) {
  return keys.map((k) => JSON.stringify(shape[k] === undefined ? null : shape[k])).join('|');
}

let uidCounter = 1;
export const nextUid = () => uidCounter++;

export class Doc {
  constructor(format) {
    this.format = format;
    this.backing = null;
    this.charShapes = [];
    this.paraShapes = [];
    this.borderFills = [];
    this.styles = [];
    this.sections = [];
    this.bin = new Map();
    this.warnings = [];
    this._csIndex = null;
    this._psIndex = null;
    this._bfIndex = null;
  }
  _index(list, cacheName) {
    let m = this[cacheName];
    if (!m || m.size !== list.length) {
      m = new Map();
      for (const s of list) m.set(s.id, s);
      this[cacheName] = m;
    }
    return m;
  }
  charShape(id) {
    return this._index(this.charShapes, '_csIndex').get(id) || this.charShapes[0] || { id: 0, ...DEFAULT_CHAR_SHAPE };
  }
  paraShape(id) {
    return this._index(this.paraShapes, '_psIndex').get(id) || this.paraShapes[0] || { id: 0, ...DEFAULT_PARA_SHAPE };
  }
  borderFill(id) {
    return this._index(this.borderFills, '_bfIndex').get(id) || null;
  }
  style(id) {
    return this.styles.find((s) => s.id === id) || this.styles[0] || null;
  }
  _nextId(list) {
    let max = -1;
    for (const s of list) if (s.id > max) max = s.id;
    return max + 1;
  }
  /** baseId 의 글자 모양에 changes 를 적용한 모양의 id 를 돌려준다 (없으면 새로 만든다). */
  deriveCharShape(baseId, changes) {
    const base = this.charShape(baseId);
    const next = { ...base, ...changes };
    if (changes.fonts) next.fonts = [...changes.fonts];
    const key = shapeKey(next, CHAR_KEYS);
    if (key === shapeKey(base, CHAR_KEYS)) return base.id;
    // 원본과 연결된(같은 base 를 가진) 모양 중 같은 것이 있으면 재사용
    for (const s of this.charShapes) {
      if (shapeKey(s, CHAR_KEYS) === key && (s.id === base.id || s.baseId === (base.baseId ?? base.id) || !s.isNew)) return s.id;
    }
    const id = this._nextId(this.charShapes);
    const created = { ...next, id, isNew: true, baseId: base.baseId ?? base.id, origin: null };
    this.charShapes.push(created);
    this._csIndex = null;
    return id;
  }
  deriveParaShape(baseId, changes) {
    const base = this.paraShape(baseId);
    const next = { ...base, ...changes };
    const key = shapeKey(next, PARA_KEYS);
    if (key === shapeKey(base, PARA_KEYS)) return base.id;
    for (const s of this.paraShapes) {
      if (shapeKey(s, PARA_KEYS) === key && (s.id === base.id || s.baseId === (base.baseId ?? base.id))) return s.id;
    }
    const id = this._nextId(this.paraShapes);
    const created = { ...next, id, isNew: true, baseId: base.baseId ?? base.id, origin: null };
    this.paraShapes.push(created);
    this._psIndex = null;
    return id;
  }
  /** 모든 변에 같은 실선 테두리를 가진 테두리/배경 id 를 찾거나 만든다. */
  ensureBorderFill(spec) {
    const key = JSON.stringify(spec);
    for (const b of this.borderFills) if (b._key === key) return b.id;
    for (const b of this.borderFills) {
      if (borderFillKey(b) === key) { b._key = key; return b.id; }
    }
    const id = this._nextId(this.borderFills);
    this.borderFills.push({ ...JSON.parse(key), id, isNew: true, origin: null, _key: key });
    this._bfIndex = null;
    return id;
  }
}

export function borderFillKey(b) {
  const side = (s) => (s ? { type: s.type, width: s.width, color: s.color } : { type: 'none', width: 0.1, color: '#000000' });
  return JSON.stringify({ left: side(b.left), right: side(b.right), top: side(b.top), bottom: side(b.bottom), fill: b.fill || null });
}

export function solidBorderSpec(widthMm = 0.12, color = '#000000', fill = null) {
  const s = { type: 'solid', width: widthMm, color };
  return { left: { ...s }, right: { ...s }, top: { ...s }, bottom: { ...s }, fill };
}

export function makePara(props = {}) {
  return {
    uid: nextUid(), origin: null, paraShapeId: 0, styleId: 0, pageBreak: false, columnBreak: false, items: [],
    ...props,
  };
}

/** 문단의 순수 텍스트 */
export function paraText(para) {
  let s = '';
  for (const it of para.items) {
    if (it.t === 'text') s += it.text;
    else if (it.t === 'tab') s += '\t';
    else if (it.t === 'br') s += '\n';
  }
  return s;
}

/** 문서 전체 문단을 (표 셀·글상자·각주 속 포함) 순서대로 방문한다. */
export function walkParas(paras, fn) {
  for (const p of paras) {
    fn(p);
    for (const it of p.items) {
      if (it.t !== 'ctrl') continue;
      const c = it.ctrl;
      if (c.cells) for (const cell of c.cells) walkParas(cell.paras, fn);
      if (c.paras) walkParas(c.paras, fn);
      if (c.caption && c.caption.paras) walkParas(c.caption.paras, fn);
    }
  }
}

export function docPlainText(doc, limit = Infinity) {
  const lines = [];
  let total = 0;
  for (const sec of doc.sections) {
    walkParas(sec.paras, (p) => {
      if (total > limit) return;
      const t = paraText(p);
      lines.push(t);
      total += t.length + 1;
    });
  }
  return lines.join('\r\n');
}

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', wmf: 'image/wmf', emf: 'image/emf' };
export const mimeForExt = (ext) => MIME_BY_EXT[(ext || '').toLowerCase()] || 'application/octet-stream';

/** 이미지 바이트에서 종류와 픽셀 크기를 알아낸다. */
export function sniffImage(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { ext: 'png', mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (u8.length > 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (u8.length > 26 && u8[0] === 0x42 && u8[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp', width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
  }
  if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let p = 2;
    while (p + 9 < u8.length) {
      if (u8[p] !== 0xff) { p++; continue; }
      const marker = u8[p + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { p += marker === 0xff ? 1 : 2; continue; }
      const len = dv.getUint16(p + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { ext: 'jpg', mime: 'image/jpeg', width: dv.getUint16(p + 7), height: dv.getUint16(p + 5) };
      }
      p += 2 + len;
    }
    return { ext: 'jpg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}
