// HWP 5.0 (복합 파일) → 문서 모델

import { Reader, utf16leDecode } from '../bytes.js';
import { readCfb } from '../cfb.js';
import { inflateRaw } from '../zlibx.js';
import { Doc, nextUid, colorRefToCss, BORDER_WIDTH_MM, mimeForExt, DEFAULT_CHAR_SHAPE, DEFAULT_PARA_SHAPE } from '../model.js';
import { TAG, parseRecords, buildTree, ctrlIdToString, ctrlCharKind } from './records.js';

const SIGNATURE = 'HWP Document File';

export function parseFileHeader(data) {
  if (data.length < 256) throw new Error('HWP 파일 머리(FileHeader)가 손상되었습니다.');
  let sig = '';
  for (let i = 0; i < 32 && data[i]; i++) sig += String.fromCharCode(data[i]);
  if (!sig.startsWith(SIGNATURE)) throw new Error('HWP 5.0 문서가 아닙니다.');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint32(32, true);
  const flags = dv.getUint32(36, true);
  return {
    version,
    versionText: `${version >>> 24}.${(version >>> 16) & 0xff}.${(version >>> 8) & 0xff}.${version & 0xff}`,
    flags,
    compressed: !!(flags & 1),
    encrypted: !!(flags & 2),
    distribution: !!(flags & 4),
  };
}

const ALIGN = ['justify', 'left', 'right', 'center', 'distribute', 'distribute'];
const LS_TYPE = ['percent', 'fixed', 'spaceOnly', 'minimum'];
const BORDER_TYPE = ['none', 'solid', 'dash', 'dot', 'dashdot', 'dashdotdot', 'longdash', 'circle', 'double', 'thinthick', 'thickthin', 'triple', 'wave', 'doublewave', 'thick3d', 'thick3drev', '3d', '3drev'];

export function parseCharShape(data, faces) {
  const r = new Reader(data);
  const faceIds = []; const ratios = []; const spacings = []; const relSizes = []; const offsets = [];
  for (let i = 0; i < 7; i++) faceIds.push(r.u16());
  for (let i = 0; i < 7; i++) ratios.push(r.u8_());
  for (let i = 0; i < 7; i++) spacings.push(r.i8());
  for (let i = 0; i < 7; i++) relSizes.push(r.u8_());
  for (let i = 0; i < 7; i++) offsets.push(r.i8());
  const baseSize = r.i32();
  const attr = r.u32();
  r.skip(2);
  const textColor = r.u32();
  r.skip(4);
  const shadeColor = r.u32();
  const ul = (attr >> 2) & 3;
  const strikeBits = (attr >> 18) & 7;
  const strikeShape = (attr >> 26) & 0xf;
  return {
    fonts: faceIds.map((id, lang) => (faces[lang] && faces[lang][id] ? faces[lang][id] : DEFAULT_CHAR_SHAPE.fonts[0])),
    size: baseSize / 100,
    italic: !!(attr & 1),
    bold: !!(attr & 2),
    underline: ul === 1 ? 'bottom' : ul === 3 ? 'top' : 'none', // 값 2 는 '없음' 자리표시
    strike: strikeBits !== 0 && strikeShape <= 12,
    sup: !!(attr & (1 << 15)),
    sub: !!(attr & (1 << 16)),
    color: colorRefToCss(textColor & 0xffffff),
    shade: shadeColor === 0xffffffff || (shadeColor >>> 24) !== 0 ? null : colorRefToCss(shadeColor),
    spacing: spacings[0], ratio: ratios[0], relSize: relSizes[0], offset: offsets[0],
  };
}

export function parseParaShape(data) {
  const r = new Reader(data);
  const attr1 = r.u32();
  const marginLeft = r.i32();
  const marginRight = r.i32();
  const indent = r.i32();
  const spaceBefore = r.i32();
  const spaceAfter = r.i32();
  const lineSpacingOld = r.i32();
  let type = attr1 & 3;
  let value = lineSpacingOld;
  let numberingId = 0;
  if (r.remaining >= 6) { r.skip(2); numberingId = r.u16(); r.skip(2); }
  if (r.remaining >= 8) r.skip(8); // 테두리 간격
  if (r.remaining >= 4) r.skip(4); // 속성 2
  if (r.remaining >= 8) {
    const attr3 = r.u32();
    const v2 = r.u32();
    type = attr3 & 0x1f;
    value = v2;
  }
  const half = (v) => Math.trunc(v / 2) / 100;
  const lsType = LS_TYPE[type] || 'percent';
  return {
    align: ALIGN[(attr1 >> 2) & 7] || 'justify',
    marginLeft: half(marginLeft), marginRight: half(marginRight), indent: half(indent),
    spaceBefore: half(spaceBefore), spaceAfter: half(spaceAfter),
    lineSpacingType: lsType,
    lineSpacing: lsType === 'percent' ? value : half(value),
    pageBreakBefore: !!(attr1 & (1 << 19)),
    keepWithNext: !!(attr1 & (1 << 17)),
    headType: (attr1 >> 23) & 3,
    headLevel: (attr1 >> 25) & 7,
    numberingId,
  };
}

export function parseBorderFill(data) {
  const r = new Reader(data);
  r.skip(2);
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const type = r.u8_();
    const width = r.u8_();
    const color = r.u32();
    sides.push({ type: BORDER_TYPE[type] || 'solid', width: BORDER_WIDTH_MM[width] ?? 0.12, color: colorRefToCss(color & 0xffffff) });
  }
  let fill = null;
  try {
    r.skip(6); // 대각선
    const fillType = r.u32();
    if (fillType & 1) {
      const bg = r.u32();
      if ((bg >>> 24) === 0) fill = colorRefToCss(bg);
    }
  } catch { /* 채우기 정보가 없는 짧은 레코드 */ }
  return { left: sides[0], right: sides[1], top: sides[2], bottom: sides[3], fill };
}

function parseDocInfo(flat, doc, fileHeader) {
  const info = { sectionCount: 1, counts: null, faces: [[], [], [], [], [], [], []], binItems: [] };
  let faceLang = 0;
  let faceInLang = 0;
  for (const rec of flat) {
    try {
      switch (rec.tag) {
        case TAG.DOCUMENT_PROPERTIES: {
          const r = new Reader(rec.data);
          info.sectionCount = r.u16();
          break;
        }
        case TAG.ID_MAPPINGS: {
          const r = new Reader(rec.data);
          const c = [];
          while (r.remaining >= 4) c.push(r.i32());
          info.counts = c;
          break;
        }
        case TAG.BIN_DATA: {
          const r = new Reader(rec.data);
          const attr = r.u16();
          const type = attr & 0xf;
          const item = { attr, type, compress: (attr >> 4) & 3, record: rec, index: info.binItems.length + 1 };
          if (type === 0) { item.absPath = r.lwstr(); item.relPath = r.lwstr(); }
          else {
            item.storageId = r.u16();
            if (type === 1) item.ext = r.lwstr();
          }
          info.binItems.push(item);
          break;
        }
        case TAG.FACE_NAME: {
          const r = new Reader(rec.data);
          r.skip(1);
          const name = r.lwstr();
          if (info.counts) {
            while (faceLang < 7 && faceInLang >= info.counts[1 + faceLang]) { faceLang++; faceInLang = 0; }
          }
          if (faceLang < 7) { info.faces[faceLang].push(name); faceInLang++; }
          break;
        }
        case TAG.BORDER_FILL: {
          const bf = parseBorderFill(rec.data);
          bf.id = doc.borderFills.length + 1; // 테두리/배경 ID 는 1부터
          bf.origin = rec;
          doc.borderFills.push(bf);
          break;
        }
        case TAG.CHAR_SHAPE: {
          const cs = parseCharShape(rec.data, info.faces);
          cs.id = doc.charShapes.length;
          cs.origin = rec;
          doc.charShapes.push(cs);
          break;
        }
        case TAG.PARA_SHAPE: {
          const ps = parseParaShape(rec.data);
          ps.id = doc.paraShapes.length;
          ps.origin = rec;
          doc.paraShapes.push(ps);
          break;
        }
        case TAG.STYLE: {
          const r = new Reader(rec.data);
          const name = r.lwstr();
          const engName = r.lwstr();
          const attr = r.u8_();
          r.skip(1);
          r.skip(2);
          const paraShapeId = r.u16();
          const charShapeId = r.u16();
          doc.styles.push({ id: doc.styles.length, name, engName, type: (attr & 7) === 1 ? 'char' : 'para', paraShapeId, charShapeId, origin: rec });
          break;
        }
        default: break;
      }
    } catch (e) {
      doc.warnings.push(`문서 정보 레코드(${rec.tag})를 읽지 못했습니다: ${e.message}`);
    }
  }
  void fileHeader;
  return info;
}

// ---------------------------------------------------------------------------
// 본문

const SHAPE_LABEL = {
  '$lin': '선', '$rec': '사각형', '$ell': '타원', '$arc': '호', '$pol': '다각형', '$cur': '곡선',
  '$con': '묶음 개체', '$ole': 'OLE 개체', '$pic': '그림', '$tat': '글맵시', '$col': '연결선',
};

const ANCHOR_LABEL = {
  'nwno': '새 번호', 'pgnp': '쪽 번호 위치', 'pghd': '감추기', 'bokm': '책갈피', 'idxm': '찾아보기 표시',
  'pgct': '홀짝 쪽 조정', 'tcmt': '숨은 설명', 'cold': '단 정의', 'secd': '구역 정의',
};

class BodyParser {
  constructor(doc) {
    this.doc = doc;
    this.counters = { footnote: 0, endnote: 0, picture: 0, table: 0, equation: 0 };
  }

  /** 형제 레코드 목록에서 문단들을 읽는다. */
  parseParas(nodes) {
    const paras = [];
    for (const n of nodes) {
      if (n.tag !== TAG.PARA_HEADER) continue;
      paras.push(this.parsePara(n));
    }
    return paras;
  }

  parsePara(node) {
    const para = { uid: nextUid(), origin: node, paraShapeId: 0, styleId: 0, pageBreak: false, columnBreak: false, items: [] };
    try {
      const r = new Reader(node.data);
      r.u32(); // 글자 수
      r.u32(); // 컨트롤 마스크
      para.paraShapeId = r.u16();
      para.styleId = r.u8_();
      const brk = r.u8_();
      para.pageBreak = !!(brk & 4);
      para.columnBreak = !!(brk & 8);
      para.breakType = brk;
      let text = null;
      let csRuns = [];
      const ctrlNodes = [];
      for (const c of node.children) {
        if (c.tag === TAG.PARA_TEXT) text = c.data;
        else if (c.tag === TAG.PARA_CHAR_SHAPE) {
          const cr = new Reader(c.data);
          while (cr.remaining >= 8) csRuns.push([cr.u32(), cr.u32()]);
        } else if (c.tag === TAG.CTRL_HEADER) ctrlNodes.push(c);
      }
      if (!csRuns.length) csRuns = [[0, 0]];
      para.cs0 = csRuns[0][1];
      this.buildItems(para, text, csRuns, ctrlNodes);
    } catch (e) {
      para.items = [];
      para.broken = true;
      this.doc.warnings.push(`문단을 읽지 못했습니다: ${e.message}`);
    }
    return para;
  }

  buildItems(para, text, csRuns, ctrlNodes) {
    const items = para.items;
    if (!text) return;
    const dv = new DataView(text.buffer, text.byteOffset, text.byteLength);
    const n = text.length >> 1;
    let runIdx = 0;
    let cs = csRuns[0][1];
    let buf = '';
    let ctrlIdx = 0;
    const flush = () => { if (buf) { items.push({ t: 'text', text: buf, cs }); buf = ''; } };
    let i = 0;
    while (i < n) {
      while (runIdx + 1 < csRuns.length && csRuns[runIdx + 1][0] <= i) {
        runIdx++;
        if (csRuns[runIdx][1] !== cs) { flush(); cs = csRuns[runIdx][1]; }
      }
      const c = dv.getUint16(i * 2, true);
      if (c >= 32) { buf += String.fromCharCode(c); i++; continue; }
      const kind = ctrlCharKind(c);
      if (kind === 'char') {
        if (c === 13) { i++; continue; }
        if (c === 10) { flush(); items.push({ t: 'br', cs }); }
        else if (c === 24) buf += '­';
        else if (c === 30) buf += ' ';
        else if (c === 31) buf += ' ';
        i++;
        continue;
      }
      // 8 코드 유닛 제어 문자
      const raw = text.slice(i * 2, Math.min(i * 2 + 16, text.length));
      flush();
      if (kind === 'inline') {
        if (c === 9) items.push({ t: 'tab', cs, raw });
        else if (c === 4) items.push({ t: 'ctrl', cs, ctrl: { cid: nextUid(), kind: 'fieldEnd', raw, origin: null } });
        else items.push({ t: 'ctrl', cs, ctrl: { cid: nextUid(), kind: 'anchor', label: '', raw, origin: null } });
      } else {
        const node = ctrlNodes[ctrlIdx++] || null;
        items.push({ t: 'ctrl', cs, ctrl: this.parseCtrl(raw, node) });
      }
      i += 8;
    }
    flush();
  }

  parseCtrl(raw, node) {
    const ctrl = { cid: nextUid(), kind: 'anchor', label: '', raw, origin: node };
    if (!node || node.data.length < 4) return ctrl;
    const dv = new DataView(node.data.buffer, node.data.byteOffset, node.data.byteLength);
    const id = ctrlIdToString(dv.getUint32(0, true));
    ctrl.ctrlId = id;
    try {
      switch (id) {
        case 'secd': ctrl.kind = 'secdef'; this.parseSecDef(ctrl, node); break;
        case 'cold': ctrl.kind = 'coldef'; this.parseColDef(ctrl, node); break;
        case 'tbl ': this.parseTable(ctrl, node); break;
        case 'gso ': this.parseGso(ctrl, node); break;
        case 'eqed': ctrl.kind = 'object'; ctrl.label = '수식'; this.parseObjectSize(ctrl, node); this.parseEquation(ctrl, node); break;
        case 'form': ctrl.kind = 'object'; ctrl.label = '양식 개체'; this.parseObjectSize(ctrl, node); break;
        case 'head': case 'foot': {
          ctrl.kind = 'hf';
          ctrl.hfKind = id === 'head' ? 'header' : 'footer';
          const apply = node.data.length >= 8 ? dv.getUint32(4, true) & 3 : 0;
          ctrl.applyTo = apply === 1 ? 'even' : apply === 2 ? 'odd' : 'both';
          this.parseListInto(ctrl, node.children);
          break;
        }
        case 'fn  ': case 'en  ': {
          ctrl.kind = 'note';
          ctrl.noteKind = id === 'fn  ' ? 'footnote' : 'endnote';
          ctrl.number = ++this.counters[ctrl.noteKind];
          this.parseListInto(ctrl, node.children);
          break;
        }
        case 'atno': {
          ctrl.kind = 'autonum';
          const attr = node.data.length >= 8 ? dv.getUint32(4, true) : 0;
          const numType = attr & 0xf;
          ctrl.numType = ['page', 'footnote', 'endnote', 'picture', 'table', 'equation'][numType] || 'page';
          break;
        }
        case 'tdut': ctrl.kind = 'object'; ctrl.label = '덧말'; break;
        case 'tcps': ctrl.kind = 'object'; ctrl.label = '글자 겹침'; break;
        default:
          if (id[0] === '%') { ctrl.kind = 'fieldBegin'; ctrl.label = '필드'; }
          else { ctrl.kind = 'anchor'; ctrl.label = ANCHOR_LABEL[id] || ''; }
          break;
      }
    } catch (e) {
      ctrl.kind = ctrl.kind === 'secdef' || ctrl.kind === 'coldef' ? ctrl.kind : 'object';
      ctrl.label = ctrl.label || '개체';
      delete ctrl.cells; delete ctrl.paras;
      this.doc.warnings.push(`컨트롤(${id})을 읽지 못했습니다: ${e.message}`);
    }
    return ctrl;
  }

  parseSecDef(ctrl, node) {
    for (const c of node.children) {
      if (c.tag !== TAG.PAGE_DEF || c.data.length < 40) continue;
      const r = new Reader(c.data);
      const w = r.u32(), h = r.u32();
      const ml = r.u32(), mr = r.u32(), mt = r.u32(), mb = r.u32(), mh = r.u32(), mf = r.u32(), mg = r.u32();
      const attr = r.u32();
      const landscape = !!(attr & 1);
      ctrl.page = {
        width: (landscape ? h : w) / 100, height: (landscape ? w : h) / 100,
        marginLeft: ml / 100, marginRight: mr / 100, marginTop: mt / 100, marginBottom: mb / 100,
        marginHeader: mh / 100, marginFooter: mf / 100, gutter: mg / 100, landscape,
      };
      break;
    }
  }

  parseColDef(ctrl, node) {
    const dv = new DataView(node.data.buffer, node.data.byteOffset, node.data.byteLength);
    const attr = node.data.length >= 6 ? dv.getUint16(4, true) : 0;
    ctrl.colCount = Math.max(1, (attr >> 2) & 0xff);
    ctrl.colGap = node.data.length >= 8 ? dv.getInt16(6, true) / 100 : 0;
  }

  /** 개체 공통 속성 (ctrl id 뒤) */
  parseCommon(ctrl, node) {
    const d = node.data;
    if (d.length < 24) return;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const attr = dv.getUint32(4, true);
    ctrl.inline = !!(attr & 1);
    ctrl.vertRel = (attr >> 3) & 3;
    ctrl.horzRel = (attr >> 8) & 3;
    ctrl.horzAlign = ['left', 'center', 'right', 'left', 'right'][(attr >> 10) & 7] || 'left';
    ctrl.wrap = (attr >> 21) & 7; // 0 어울림, 1 자리 차지, 2 글 뒤로, 3 글 앞으로
    ctrl.offsetY = dv.getInt32(8, true) / 100;
    ctrl.offsetX = dv.getInt32(12, true) / 100;
    ctrl.width = dv.getUint32(16, true) / 100;
    ctrl.height = dv.getUint32(20, true) / 100;
    if (d.length >= 36) {
      ctrl.margin = [dv.getInt16(28, true) / 100, dv.getInt16(30, true) / 100, dv.getInt16(32, true) / 100, dv.getInt16(34, true) / 100];
    }
  }
  parseObjectSize(ctrl, node) { this.parseCommon(ctrl, node); }

  parseEquation(ctrl, node) {
    for (const c of node.children) {
      if (c.tag !== TAG.EQEDIT || c.data.length < 6) continue;
      const r = new Reader(c.data);
      r.skip(4);
      ctrl.script = r.lwstr();
    }
  }

  /** LIST_HEADER + 문단들로 이루어진 자식 목록을 ctrl.paras 로 읽는다. */
  parseListInto(target, children) {
    const li = children.findIndex((c) => c.tag === TAG.LIST_HEADER);
    target.listHeader = li >= 0 ? children[li] : null;
    target.paras = this.parseParas(children.slice(li + 1));
  }

  /** LIST_HEADER 의 문단 수 */
  listParaCount(rec) {
    if (rec.data.length < 2) return 0;
    return new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength).getUint16(0, true);
  }

  parseTable(ctrl, node) {
    ctrl.kind = 'table';
    this.parseCommon(ctrl, node);
    const kids = node.children;
    const ti = kids.findIndex((c) => c.tag === TAG.TABLE);
    if (ti < 0) throw new Error('표 레코드가 없습니다.');
    // 캡션: TABLE 앞의 LIST_HEADER + 문단
    if (ti > 0 && kids[0].tag === TAG.LIST_HEADER) {
      ctrl.caption = { listHeader: kids[0], paras: this.parseParas(kids.slice(1, ti)) };
    }
    const t = kids[ti];
    ctrl.tableRecord = t;
    const r = new Reader(t.data);
    r.u32();
    ctrl.rows = r.u16();
    ctrl.cols = r.u16();
    ctrl.cellSpacing = r.u16() / 100;
    ctrl.padding = [r.u16() / 100, r.u16() / 100, r.u16() / 100, r.u16() / 100];
    r.skip(ctrl.rows * 2);
    ctrl.borderFillId = r.remaining >= 2 ? r.u16() : 0;
    ctrl.cells = [];
    ctrl.tail = [];
    let i = ti + 1;
    while (i < kids.length) {
      const k = kids[i];
      if (k.tag !== TAG.LIST_HEADER) { ctrl.tail.push(k); i++; continue; }
      const count = this.listParaCount(k);
      const paraNodes = [];
      let j = i + 1;
      while (j < kids.length && paraNodes.length < count && kids[j].tag === TAG.PARA_HEADER) paraNodes.push(kids[j++]);
      const cell = { listHeader: k, paras: this.parseParas(paraNodes) };
      const d = k.data;
      if (d.length >= 34) {
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const lattr = dv.getUint32(4, true);
        cell.vAlign = ['top', 'middle', 'bottom'][(lattr >> 5) & 3] || 'top';
        cell.col = dv.getUint16(8, true);
        cell.row = dv.getUint16(10, true);
        cell.colSpan = Math.max(1, dv.getUint16(12, true));
        cell.rowSpan = Math.max(1, dv.getUint16(14, true));
        cell.width = dv.getUint32(16, true) / 100;
        cell.height = dv.getUint32(20, true) / 100;
        cell.padding = [dv.getUint16(24, true) / 100, dv.getUint16(26, true) / 100, dv.getUint16(28, true) / 100, dv.getUint16(30, true) / 100];
        cell.borderFillId = dv.getUint16(32, true);
      } else {
        cell.col = 0; cell.row = ctrl.cells.length; cell.colSpan = 1; cell.rowSpan = 1; cell.width = 0; cell.height = 0; cell.padding = [0, 0, 0, 0]; cell.borderFillId = 0; cell.vAlign = 'top';
      }
      ctrl.cells.push(cell);
      i = j;
    }
    this.counters.table++;
  }

  parseGso(ctrl, node) {
    this.parseCommon(ctrl, node);
    const kids = node.children;
    const si = kids.findIndex((c) => c.tag === TAG.SHAPE_COMPONENT);
    if (si > 0 && kids[0].tag === TAG.LIST_HEADER) {
      ctrl.caption = { listHeader: kids[0], paras: this.parseParas(kids.slice(1, si)) };
    }
    ctrl.kind = 'object';
    ctrl.label = '그리기 개체';
    if (si < 0) return;
    const sc = kids[si];
    const scId = sc.data.length >= 4 ? ctrlIdToString(new DataView(sc.data.buffer, sc.data.byteOffset, sc.data.byteLength).getUint32(0, true)) : '';
    ctrl.shapeId = scId;
    ctrl.label = SHAPE_LABEL[scId] || '그리기 개체';
    const pic = sc.children.find((c) => c.tag === TAG.SHAPE_COMPONENT_PICTURE);
    if (pic && pic.data.length >= 73) {
      const dv = new DataView(pic.data.buffer, pic.data.byteOffset, pic.data.byteLength);
      ctrl.kind = 'picture';
      ctrl.binId = dv.getUint16(71, true);
      this.counters.picture++;
      return;
    }
    const li = sc.children.findIndex((c) => c.tag === TAG.LIST_HEADER);
    if (li >= 0) {
      ctrl.kind = 'textbox';
      const lh = sc.children[li];
      const count = this.listParaCount(lh);
      const paraNodes = [];
      let j = li + 1;
      while (j < sc.children.length && paraNodes.length < count && sc.children[j].tag === TAG.PARA_HEADER) paraNodes.push(sc.children[j++]);
      ctrl.listHeader = lh;
      ctrl.paras = this.parseParas(paraNodes);
      ctrl.shapeNode = sc;
      // 테두리 선 / 채우기 (화면 표시용)
      try {
        const d = sc.data;
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const cnt = d.length >= 52 ? dv.getUint16(50, true) : 0;
        const base = 52 + 48 * (1 + 2 * cnt);
        if (d.length >= base + 13) {
          const lineColor = dv.getUint32(base, true);
          const thick = dv.getInt32(base + 4, true);
          const lattr = dv.getUint32(base + 8, true);
          const box = { line: (lattr & 0x3f) !== 0 && thick > 0, lineColor: colorRefToCss(lineColor & 0xffffff), lineWidth: Math.max(0.4, thick / 100), fill: null };
          if (d.length >= base + 21) {
            const fillType = dv.getUint32(base + 13, true);
            const bg = dv.getUint32(base + 17, true);
            if ((fillType & 1) && (bg >>> 24) === 0) box.fill = colorRefToCss(bg);
          }
          ctrl.box = box;
        }
      } catch { /* 표시용 정보일 뿐이므로 무시 */ }
    }
  }
}

function streamNumber(path) {
  const m = /(\d+)$/.exec(path);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * HWP 5.0 바이트를 읽어 Doc 을 만든다.
 */
export async function readHwp(u8) {
  const cfb = readCfb(u8);
  const byPath = new Map(cfb.entries.map((e) => [e.path, e]));
  const fh = byPath.get('FileHeader');
  if (!fh) throw new Error('HWP 문서가 아닙니다 (FileHeader 없음).');
  const header = parseFileHeader(fh.data);
  if (header.encrypted) throw new Error('암호가 걸린 문서는 열 수 없습니다.');
  if (header.distribution) throw new Error('배포용 문서는 열 수 없습니다.');
  if ((header.version >>> 24) !== 5) throw new Error(`지원하지 않는 HWP 버전입니다 (${header.versionText}).`);

  const doc = new Doc('hwp');
  const unpack = async (data) => (header.compressed ? inflateRaw(data) : data);

  const di = byPath.get('DocInfo');
  if (!di) throw new Error('문서 정보(DocInfo)가 없습니다.');
  const docInfoFlat = parseRecords(await unpack(di.data));
  const info = parseDocInfo(docInfoFlat, doc, header);
  if (!doc.charShapes.length) doc.charShapes.push({ id: 0, ...DEFAULT_CHAR_SHAPE, origin: null });
  if (!doc.paraShapes.length) doc.paraShapes.push({ id: 0, ...DEFAULT_PARA_SHAPE, origin: null });

  // 바이너리 데이터
  const binStreams = cfb.entries.filter((e) => e.type === 'stream' && e.path.startsWith('BinData/'));
  for (const item of info.binItems) {
    if (item.type === 0) continue;
    const hex = item.storageId.toString(16).toUpperCase().padStart(4, '0');
    const prefix = `BinData/BIN${hex}`;
    const entry = binStreams.find((e) => e.path.toUpperCase().startsWith(prefix.toUpperCase() + '.') || e.path.toUpperCase() === prefix.toUpperCase());
    if (!entry) continue;
    const ext = (item.ext || entry.path.split('.').pop() || '').toLowerCase();
    const compressed = item.compress === 0 ? header.compressed : item.compress === 1;
    let cache = null;
    doc.bin.set(item.index, {
      id: item.index, ext, mime: mimeForExt(ext), entryPath: entry.path,
      getBytes: async () => {
        if (!cache) {
          try { cache = compressed ? await inflateRaw(entry.data) : entry.data; }
          catch { cache = entry.data; }
        }
        return cache;
      },
    });
  }

  // 본문 구역
  const secEntries = cfb.entries
    .filter((e) => e.type === 'stream' && /^BodyText\/Section\d+$/.test(e.path))
    .sort((a, b) => streamNumber(a.path) - streamNumber(b.path));
  if (!secEntries.length) throw new Error('본문(BodyText)이 없습니다.');
  const parser = new BodyParser(doc);
  const sectionBacking = [];
  for (const se of secEntries) {
    const flat = parseRecords(await unpack(se.data));
    const tree = buildTree(flat);
    const paras = parser.parseParas(tree);
    const section = { paras, page: null, columns: { count: 1, gap: 0 }, secd: null, cold: null, path: se.path };
    // 첫 문단 맨 앞의 구역 정의 / 단 정의는 구역 속성으로 떼어 둔다.
    if (paras.length) {
      const first = paras[0];
      const si = first.items.findIndex((it) => it.t === 'ctrl' && it.ctrl.kind === 'secdef');
      if (si >= 0) {
        section.secd = first.items[si];
        section.page = section.secd.ctrl.page || null;
        first.items.splice(si, 1);
        const ci = first.items.findIndex((it) => it.t === 'ctrl' && it.ctrl.kind === 'coldef');
        if (ci >= 0 && ci <= si) {
          section.cold = first.items[ci];
          section.columns = { count: section.cold.ctrl.colCount || 1, gap: section.cold.ctrl.colGap || 0 };
          first.items.splice(ci, 1);
        }
      }
    }
    if (!section.page) {
      section.page = { width: 595.28, height: 841.88, marginLeft: 85.04, marginRight: 85.04, marginTop: 56.68, marginBottom: 42.52, marginHeader: 42.52, marginFooter: 42.52, gutter: 0, landscape: false };
    }
    doc.sections.push(section);
    sectionBacking.push({ path: se.path, tree });
  }

  doc.backing = { kind: 'hwp', cfb, header, docInfoFlat, info, sections: sectionBacking };
  return doc;
}

export { utf16leDecode };
