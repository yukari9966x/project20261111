// HWPX (OWPML, ZIP+XML) → 문서 모델

import { utf8Decode } from '../bytes.js';
import { readZip } from '../zip.js';
import { parseXml } from '../xml.js';
import { Doc, nextUid, mimeForExt, DEFAULT_CHAR_SHAPE, DEFAULT_PARA_SHAPE } from '../model.js';

const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const LANG_NAMES = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];

const ALIGN = { JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'distribute', DISTRIBUTE_SPACE: 'distribute' };
const LS_TYPE = { PERCENT: 'percent', FIXED: 'fixed', BETWEEN_LINES: 'spaceOnly', AT_LEAST: 'minimum' };
const BORDER_TYPE = {
  NONE: 'none', SOLID: 'solid', DASH: 'dash', DOT: 'dot', DASH_DOT: 'dashdot', DASH_DOT_DOT: 'dashdotdot', LONG_DASH: 'longdash',
  CIRCLE: 'circle', DOUBLE_SLIM: 'double', SLIM_THICK: 'thinthick', THICK_SLIM: 'thickthin', SLIM_THICK_SLIM: 'triple',
  WAVE: 'wave', DOUBLE_WAVE: 'doublewave',
};
const REAL_STRIKE = new Set(['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE']);

const SHAPE_LABEL = {
  rect: '사각형', ellipse: '타원', line: '선', arc: '호', polygon: '다각형', curve: '곡선', connectLine: '연결선',
  container: '묶음 개체', ole: 'OLE 개체', equation: '수식', textart: '글맵시', chart: '차트', video: '동영상',
  compose: '글자 겹침', dutmal: '덧말', btn: '양식 개체', radioBtn: '양식 개체', checkBtn: '양식 개체',
  comboBox: '양식 개체', edit: '양식 개체', listBox: '양식 개체', scrollBar: '양식 개체',
};
const ANCHOR_LABEL = { newNum: '새 번호', pageNum: '쪽 번호 위치', pageHiding: '감추기', bookmark: '책갈피', indexmark: '찾아보기 표시', hiddenComment: '숨은 설명', pageNumCtrl: '홀짝 쪽 조정' };

const cssColor = (v) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
const mmValue = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0.12; };

export function parseCharPr(el, faces) {
  const fontRef = el.child('fontRef');
  const get = (name, lang, dflt) => { const c = el.child(name); return c ? c.num(lang, dflt) : dflt; };
  const ul = el.child('underline');
  const ulType = ul ? ul.get('type', 'NONE') : 'NONE';
  const so = el.child('strikeout');
  const shade = el.get('shadeColor', 'none');
  return {
    fonts: LANGS.map((lang, i) => {
      const id = fontRef ? fontRef.num(lang, 0) : 0;
      return (faces[i] && faces[i].get(id)) || DEFAULT_CHAR_SHAPE.fonts[0];
    }),
    size: el.num('height', 1000) / 100,
    bold: !!el.child('bold'),
    italic: !!el.child('italic'),
    underline: ulType === 'BOTTOM' || ulType === 'CENTER' ? 'bottom' : ulType === 'TOP' ? 'top' : 'none',
    strike: !!so && REAL_STRIKE.has(so.get('shape', 'NONE')),
    sup: !!el.child('supscript'),
    sub: !!el.child('subscript'),
    color: cssColor(el.get('textColor')) || '#000000',
    shade: cssColor(shade),
    spacing: get('spacing', 'hangul', 0), ratio: get('ratio', 'hangul', 100), relSize: get('relSz', 'hangul', 100), offset: get('offset', 'hangul', 0),
  };
}

export function parseParaPr(el) {
  const align = el.child('align');
  const brk = el.child('breakSetting');
  const heading = el.child('heading');
  // 여백/줄 간격은 hp:switch 안에 있을 수 있다. case(HwpUnitChar)는 1배, 그 외는 2배 단위.
  let scale = 2;
  let marginEl = el.child('margin');
  let lsEl = el.child('lineSpacing');
  const sw = el.child('switch');
  if (sw) {
    const cs = sw.child('case');
    const df = sw.child('default');
    if (cs && cs.child('margin')) { marginEl = cs.child('margin'); lsEl = cs.child('lineSpacing') || lsEl; scale = 1; }
    else if (df && df.child('margin')) { marginEl = df.child('margin'); lsEl = df.child('lineSpacing') || lsEl; scale = 2; }
  }
  const mv = (name) => {
    const c = marginEl ? marginEl.child(name) : null;
    return c ? Math.trunc(c.num('value', 0) / scale) / 100 : 0;
  };
  const lsType = LS_TYPE[lsEl ? lsEl.get('type', 'PERCENT') : 'PERCENT'] || 'percent';
  const lsVal = lsEl ? lsEl.num('value', 160) : 160;
  return {
    align: ALIGN[align ? align.get('horizontal', 'JUSTIFY') : 'JUSTIFY'] || 'justify',
    marginLeft: mv('left'), marginRight: mv('right'), indent: mv('intent'), spaceBefore: mv('prev'), spaceAfter: mv('next'),
    lineSpacingType: lsType,
    lineSpacing: lsType === 'percent' ? lsVal : Math.trunc(lsVal / scale) / 100,
    pageBreakBefore: brk ? brk.get('pageBreakBefore') === '1' : false,
    keepWithNext: brk ? brk.get('keepWithNext') === '1' : false,
    headType: heading ? ({ NONE: 0, OUTLINE: 1, NUMBER: 2, BULLET: 3 }[heading.get('type', 'NONE')] || 0) : 0,
    headLevel: heading ? heading.num('level', 0) : 0,
    numberingId: heading ? heading.num('idRef', 0) : 0,
  };
}

export function parseBorderFillEl(el) {
  const side = (name) => {
    const c = el.child(name);
    if (!c) return { type: 'none', width: 0.1, color: '#000000' };
    return { type: BORDER_TYPE[c.get('type', 'NONE')] || 'solid', width: mmValue(c.get('width', '0.12 mm')), color: cssColor(c.get('color')) || '#000000' };
  };
  let fill = null;
  const fb = el.child('fillBrush');
  if (fb) {
    const wb = fb.child('winBrush');
    if (wb) fill = cssColor(wb.get('faceColor'));
  }
  return { left: side('leftBorder'), right: side('rightBorder'), top: side('topBorder'), bottom: side('bottomBorder'), fill };
}

class SectionParser {
  constructor(doc) {
    this.doc = doc;
    this.counters = { footnote: 0, endnote: 0 };
  }

  parseParas(container) {
    const out = [];
    for (const c of container.children) if (c.type === 'el' && c.localName === 'p') out.push(this.parsePara(c));
    return out;
  }

  parsePara(el) {
    const para = {
      uid: nextUid(), origin: el,
      paraShapeId: el.num('paraPrIDRef', 0), styleId: el.num('styleIDRef', 0),
      pageBreak: el.get('pageBreak') === '1', columnBreak: el.get('columnBreak') === '1', items: [],
    };
    try {
      for (const run of el.children) {
        if (run.type !== 'el' || run.localName !== 'run') continue;
        const cs = run.num('charPrIDRef', 0);
        if (para.cs0 === undefined) para.cs0 = cs;
        for (const c of run.children) {
          if (c.type !== 'el') continue;
          if (c.localName === 't') this.parseText(c, cs, para.items);
          else para.items.push({ t: 'ctrl', cs, ctrl: this.parseCtrl(c) });
        }
      }
      // 같은 글자 모양으로 이어지는 텍스트는 하나로 합친다.
      const merged = [];
      for (const it of para.items) {
        const last = merged[merged.length - 1];
        if (it.t === 'text' && last && last.t === 'text' && last.cs === it.cs) last.text += it.text;
        else merged.push(it);
      }
      para.items = merged;
    } catch (e) {
      para.items = [];
      para.broken = true;
      this.doc.warnings.push(`문단을 읽지 못했습니다: ${e.message}`);
    }
    return para;
  }

  parseText(t, cs, items) {
    let buf = '';
    const flush = () => { if (buf) { items.push({ t: 'text', text: buf, cs }); buf = ''; } };
    for (const c of t.children) {
      if (c.type === 'text' || c.type === 'cdata') { buf += c.value; continue; }
      if (c.type !== 'el') continue;
      switch (c.localName) {
        case 'tab': flush(); items.push({ t: 'tab', cs, origin: c }); break;
        case 'lineBreak': flush(); items.push({ t: 'br', cs }); break;
        case 'nbSpace': buf += ' '; break;
        case 'fwSpace': buf += ' '; break;
        case 'hyphen': buf += '­'; break;
        default:
          flush();
          items.push({ t: 'ctrl', cs, ctrl: { cid: nextUid(), kind: 'anchor', label: '', origin: c, inText: true } });
          break;
      }
    }
    flush();
  }

  parseCtrl(el) {
    const name = el.localName;
    const ctrl = { cid: nextUid(), kind: 'anchor', label: '', origin: el };
    try {
      switch (name) {
        case 'secPr': ctrl.kind = 'secdef'; this.parseSecPr(ctrl, el); break;
        case 'ctrl': this.parseCtrlElement(ctrl, el); break;
        case 'tbl': this.parseTable(ctrl, el); break;
        case 'pic': this.parsePicture(ctrl, el); break;
        default: {
          this.parseCommon(ctrl, el);
          const dt = el.child('drawText');
          const sub = dt ? dt.child('subList') : null;
          if (sub) {
            ctrl.kind = 'textbox';
            ctrl.label = SHAPE_LABEL[name] || '글상자';
            ctrl.paras = this.parseParas(sub);
            ctrl.subList = sub;
            const ls = el.child('lineShape');
            const fb = el.child('fillBrush');
            const wb = fb ? fb.child('winBrush') : null;
            ctrl.box = {
              line: !!ls && (ls.get('style', 'SOLID') || '').toUpperCase() !== 'NONE' && ls.num('width', 0) > 0,
              lineColor: (ls && cssColor(ls.get('color'))) || '#000000',
              lineWidth: Math.max(0.4, (ls ? ls.num('width', 33) : 33) / 100),
              fill: wb ? cssColor(wb.get('faceColor')) : null,
            };
          } else {
            ctrl.kind = 'object';
            ctrl.label = SHAPE_LABEL[name] || '개체';
            if (name === 'equation') { const sc = el.child('script'); if (sc) ctrl.script = sc.text; }
          }
          const cap = el.child('caption');
          if (cap && cap.child('subList')) ctrl.caption = { subList: cap.child('subList'), paras: this.parseParas(cap.child('subList')) };
          break;
        }
      }
    } catch (e) {
      ctrl.kind = ctrl.kind === 'secdef' || ctrl.kind === 'coldef' ? ctrl.kind : 'object';
      ctrl.label = ctrl.label || '개체';
      delete ctrl.cells; delete ctrl.paras;
      this.doc.warnings.push(`컨트롤(${name})을 읽지 못했습니다: ${e.message}`);
    }
    return ctrl;
  }

  parseSecPr(ctrl, el) {
    const pp = el.child('pagePr');
    if (!pp) return;
    const m = pp.child('margin');
    const w = pp.num('width', 59528), h = pp.num('height', 84188);
    const landscape = (pp.get('landscape', 'WIDELY') || '').toUpperCase() === 'NARROWLY';
    const mv = (n, d) => (m ? m.num(n, d) : d) / 100;
    ctrl.page = {
      width: (landscape ? h : w) / 100, height: (landscape ? w : h) / 100,
      marginLeft: mv('left', 8504), marginRight: mv('right', 8504), marginTop: mv('top', 5668), marginBottom: mv('bottom', 4252),
      marginHeader: mv('header', 4252), marginFooter: mv('footer', 4252), gutter: mv('gutter', 0), landscape,
    };
  }

  parseCtrlElement(ctrl, el) {
    const first = el.elements[0];
    if (!first) return;
    const n = first.localName;
    switch (n) {
      case 'colPr':
        ctrl.kind = 'coldef';
        ctrl.colCount = Math.max(1, first.num('colCount', 1));
        ctrl.colGap = first.num('sameGap', 0) / 100;
        break;
      case 'header': case 'footer': {
        ctrl.kind = 'hf';
        ctrl.hfKind = n;
        const at = first.get('applyPageType', 'BOTH');
        ctrl.applyTo = at === 'EVEN' ? 'even' : at === 'ODD' ? 'odd' : 'both';
        const sub = first.child('subList');
        ctrl.subList = sub;
        ctrl.paras = sub ? this.parseParas(sub) : [];
        break;
      }
      case 'footNote': case 'endNote': {
        ctrl.kind = 'note';
        ctrl.noteKind = n === 'footNote' ? 'footnote' : 'endnote';
        ctrl.number = ++this.counters[ctrl.noteKind];
        const sub = first.child('subList');
        ctrl.subList = sub;
        ctrl.paras = sub ? this.parseParas(sub) : [];
        break;
      }
      case 'autoNum': {
        ctrl.kind = 'autonum';
        const t = first.get('numType', 'PAGE');
        ctrl.numType = { PAGE: 'page', FOOTNOTE: 'footnote', ENDNOTE: 'endnote', PICTURE: 'picture', TABLE: 'table', EQUATION: 'equation', TOTAL_PAGE: 'page' }[t] || 'page';
        ctrl.numValue = first.num('num', 0);
        break;
      }
      case 'fieldBegin': ctrl.kind = 'fieldBegin'; ctrl.label = '필드'; break;
      case 'fieldEnd': ctrl.kind = 'fieldEnd'; break;
      default: ctrl.kind = 'anchor'; ctrl.label = ANCHOR_LABEL[n] || ''; break;
    }
  }

  parseCommon(ctrl, el) {
    const sz = el.child('sz');
    const pos = el.child('pos');
    if (sz) { ctrl.width = sz.num('width', 0) / 100; ctrl.height = sz.num('height', 0) / 100; }
    if (pos) {
      ctrl.inline = pos.get('treatAsChar') === '1';
      ctrl.horzAlign = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', INSIDE: 'left', OUTSIDE: 'right' }[pos.get('horzAlign', 'LEFT')] || 'left';
      ctrl.horzRel = { PAPER: 0, PAGE: 1, COLUMN: 2, PARA: 3 }[pos.get('horzRelTo', 'PARA')] ?? 3;
      ctrl.vertRel = { PAPER: 0, PAGE: 1, PARA: 2 }[pos.get('vertRelTo', 'PARA')] ?? 2;
      ctrl.offsetX = pos.num('horzOffset', 0) / 100;
      ctrl.offsetY = pos.num('vertOffset', 0) / 100;
    } else ctrl.inline = true;
    const wrap = el.get('textWrap', 'TOP_AND_BOTTOM');
    ctrl.wrap = { SQUARE: 0, TOP_AND_BOTTOM: 1, BEHIND_TEXT: 2, IN_FRONT_OF_TEXT: 3, TIGHT: 0, THROUGH: 0 }[wrap] ?? 1;
    const om = el.child('outMargin');
    if (om) ctrl.margin = [om.num('left', 0) / 100, om.num('right', 0) / 100, om.num('top', 0) / 100, om.num('bottom', 0) / 100];
  }

  parseTable(ctrl, el) {
    ctrl.kind = 'table';
    this.parseCommon(ctrl, el);
    ctrl.rows = el.num('rowCnt', 0);
    ctrl.cols = el.num('colCnt', 0);
    ctrl.cellSpacing = el.num('cellSpacing', 0) / 100;
    ctrl.borderFillId = el.num('borderFillIDRef', 0);
    const im = el.child('inMargin');
    ctrl.padding = im ? [im.num('left', 0) / 100, im.num('right', 0) / 100, im.num('top', 0) / 100, im.num('bottom', 0) / 100] : [0, 0, 0, 0];
    const cap = el.child('caption');
    if (cap && cap.child('subList')) ctrl.caption = { subList: cap.child('subList'), paras: this.parseParas(cap.child('subList')) };
    ctrl.cells = [];
    for (const tr of el.childrenNamed('tr')) {
      for (const tc of tr.childrenNamed('tc')) {
        const sub = tc.child('subList');
        const addr = tc.child('cellAddr');
        const span = tc.child('cellSpan');
        const sz = tc.child('cellSz');
        const cm = tc.child('cellMargin');
        const va = sub ? sub.get('vertAlign', 'TOP') : 'TOP';
        ctrl.cells.push({
          origin: tc, subList: sub,
          paras: sub ? this.parseParas(sub) : [],
          col: addr ? addr.num('colAddr', 0) : 0, row: addr ? addr.num('rowAddr', 0) : 0,
          colSpan: Math.max(1, span ? span.num('colSpan', 1) : 1), rowSpan: Math.max(1, span ? span.num('rowSpan', 1) : 1),
          width: sz ? sz.num('width', 0) / 100 : 0, height: sz ? sz.num('height', 0) / 100 : 0,
          padding: cm ? [cm.num('left', 0) / 100, cm.num('right', 0) / 100, cm.num('top', 0) / 100, cm.num('bottom', 0) / 100] : [0, 0, 0, 0],
          borderFillId: tc.num('borderFillIDRef', 0),
          vAlign: va === 'CENTER' ? 'middle' : va === 'BOTTOM' ? 'bottom' : 'top',
        });
      }
    }
  }

  parsePicture(ctrl, el) {
    this.parseCommon(ctrl, el);
    const img = el.child('img');
    ctrl.kind = 'picture';
    ctrl.binId = img ? img.get('binaryItemIDRef', '') : '';
    if (!ctrl.width) {
      const cur = el.child('curSz');
      if (cur) { ctrl.width = cur.num('width', 0) / 100; ctrl.height = cur.num('height', 0) / 100; }
    }
    const cap = el.child('caption');
    if (cap && cap.child('subList')) ctrl.caption = { subList: cap.child('subList'), paras: this.parseParas(cap.child('subList')) };
  }
}

function sectionNumber(name) {
  const m = /section(\d+)\.xml$/i.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

export async function readHwpx(u8) {
  const entries = readZip(u8);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const readText = async (name) => {
    const e = byName.get(name);
    if (!e) return null;
    return utf8Decode(await e.getData());
  };
  const mimetype = await readText('mimetype');
  if (mimetype !== null && !/hwp\+zip/.test(mimetype) && !byName.has('Contents/header.xml')) throw new Error('HWPX 문서가 아닙니다.');
  const headerSrc = await readText('Contents/header.xml');
  if (headerSrc === null) {
    const manifest = await readText('META-INF/manifest.xml');
    if (manifest && /encryption-data/.test(manifest)) throw new Error('암호가 걸린 문서는 열 수 없습니다.');
    throw new Error('HWPX 문서가 아닙니다 (header.xml 없음).');
  }
  {
    const manifest = await readText('META-INF/manifest.xml');
    if (manifest && /encryption-data/.test(manifest)) throw new Error('암호가 걸린 문서는 열 수 없습니다.');
  }
  const doc = new Doc('hwpx');
  const header = parseXml(headerSrc);
  const refList = header.root.find('refList') || header.root;

  // 글꼴
  const faces = LANG_NAMES.map(() => new Map());
  const fontfaces = refList.child('fontfaces');
  if (fontfaces) {
    for (const ff of fontfaces.childrenNamed('fontface')) {
      const li = LANG_NAMES.indexOf((ff.get('lang', '') || '').toUpperCase());
      if (li < 0) continue;
      for (const f of ff.childrenNamed('font')) faces[li].set(f.num('id', 0), f.get('face', ''));
    }
  }
  const each = (listName, itemName, fn) => {
    const list = refList.child(listName);
    if (!list) return;
    for (const el of list.childrenNamed(itemName)) {
      try { fn(el); } catch (e) { doc.warnings.push(`문서 정보(${itemName})를 읽지 못했습니다: ${e.message}`); }
    }
  };
  each('borderFills', 'borderFill', (el) => { const b = parseBorderFillEl(el); b.id = el.num('id', 0); b.origin = el; doc.borderFills.push(b); });
  each('charProperties', 'charPr', (el) => { const c = parseCharPr(el, faces); c.id = el.num('id', 0); c.origin = el; doc.charShapes.push(c); });
  each('paraProperties', 'paraPr', (el) => { const p = parseParaPr(el); p.id = el.num('id', 0); p.origin = el; doc.paraShapes.push(p); });
  each('styles', 'style', (el) => {
    doc.styles.push({
      id: el.num('id', 0), name: el.get('name', ''), engName: el.get('engName', ''), type: el.get('type', 'PARA') === 'CHAR' ? 'char' : 'para',
      paraShapeId: el.num('paraPrIDRef', 0), charShapeId: el.num('charPrIDRef', 0), origin: el,
    });
  });
  if (!doc.charShapes.length) doc.charShapes.push({ id: 0, ...DEFAULT_CHAR_SHAPE, origin: null });
  if (!doc.paraShapes.length) doc.paraShapes.push({ id: 0, ...DEFAULT_PARA_SHAPE, origin: null });

  // 바이너리 항목 (content.hpf 의 manifest)
  let hpf = null;
  const hpfSrc = await readText('Contents/content.hpf');
  if (hpfSrc) {
    try {
      hpf = parseXml(hpfSrc);
      for (const item of hpf.root.findAll('item')) {
        const href = item.get('href', '');
        const id = item.get('id', '');
        if (!/^BinData\//i.test(href)) continue;
        const entry = byName.get(href);
        if (!entry) continue;
        const ext = (href.split('.').pop() || '').toLowerCase();
        doc.bin.set(id, { id, ext, mime: item.get('media-type') || mimeForExt(ext), entryName: href, getBytes: () => entry.getData() });
      }
    } catch (e) {
      doc.warnings.push(`content.hpf 를 읽지 못했습니다: ${e.message}`);
    }
  }
  for (const e of entries) {
    if (!/^BinData\//i.test(e.name)) continue;
    const base = e.name.slice(8);
    const id = base.replace(/\.[^.]*$/, '');
    if (doc.bin.has(id)) continue;
    const ext = (base.split('.').pop() || '').toLowerCase();
    doc.bin.set(id, { id, ext, mime: mimeForExt(ext), entryName: e.name, getBytes: () => e.getData() });
  }

  // 구역
  const secNames = entries.map((e) => e.name).filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => sectionNumber(a) - sectionNumber(b));
  if (!secNames.length) throw new Error('본문 구역이 없습니다.');
  const parser = new SectionParser(doc);
  const sectionBacking = [];
  for (const name of secNames) {
    const xml = parseXml(await readText(name));
    const paras = parser.parseParas(xml.root);
    const section = { paras, page: null, columns: { count: 1, gap: 0 }, secd: null, cold: null, path: name };
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
    sectionBacking.push({ path: name, xml });
  }
  doc.backing = { kind: 'hwpx', entries, header, hpf, sections: sectionBacking };
  return doc;
}
