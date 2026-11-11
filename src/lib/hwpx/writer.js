// 문서 모델 + 저장 모델 → HWPX 바이트
//
// 원칙: 바뀌지 않은 문단/구역은 원본 XML 을 그대로 내보낸다. 바뀐 문단은 run 을 다시 만들고
// 줄 배치 정보(linesegarray)는 넣지 않아 한글이 다시 계산하게 한다. 원본 XML 트리는 바꾸지 않는다.

import { utf8Encode } from '../bytes.js';
import { writeZip } from '../zip.js';
import { XElement, parseXml, serializeXml } from '../xml.js';
import { sniffImage, pt2hu, mimeForExt } from '../model.js';

const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const LANG_NAMES = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const ALIGN = { justify: 'JUSTIFY', left: 'LEFT', right: 'RIGHT', center: 'CENTER', distribute: 'DISTRIBUTE' };
const LS_TYPE = { percent: 'PERCENT', fixed: 'FIXED', spaceOnly: 'BETWEEN_LINES', minimum: 'AT_LEAST' };
const BORDER_TYPE = {
  none: 'NONE', solid: 'SOLID', dash: 'DASH', dot: 'DOT', dashdot: 'DASH_DOT', dashdotdot: 'DASH_DOT_DOT', longdash: 'LONG_DASH',
  circle: 'CIRCLE', double: 'DOUBLE_SLIM', thinthick: 'SLIM_THICK', thickthin: 'THICK_SLIM', triple: 'SLIM_THICK_SLIM', wave: 'WAVE', doublewave: 'DOUBLE_WAVE',
};

const isEl = (o) => !!o && o.type === 'el' && typeof o.name === 'string';

/** 원본 요소의 parent 를 건드리지 않고 새 요소를 만든다. */
function mk(name, attrs = [], children = []) {
  const el = new XElement(name, Array.isArray(attrs) ? attrs.map((a) => [a[0], String(a[1])]) : Object.entries(attrs).map(([k, v]) => [k, String(v)]), []);
  el.children = children;
  return el;
}
const shallow = (el, children) => { const n = mk(el.name, el.attrs.map((a) => [a[0], a[1]]), children); n.selfClose = el.selfClose; return n; };
const txt = (value) => ({ type: 'text', value });
const prefixOf = (el) => { const i = el.name.indexOf(':'); return i < 0 ? '' : el.name.slice(0, i + 1); };

let idSeed = Math.floor(Math.random() * 0x3fffffff) + 0x40000000;
const nextId = () => { idSeed = (idSeed + 1) & 0x7fffffff; return idSeed; };

// ---------------------------------------------------------------------------
// header.xml

function buildHeader(doc, ctx) {
  const b = doc.backing;
  const newCs = doc.charShapes.filter((s) => s.isNew).sort((a, c) => a.id - c.id);
  const newPs = doc.paraShapes.filter((s) => s.isNew).sort((a, c) => a.id - c.id);
  const newBf = doc.borderFills.filter((s) => s.isNew).sort((a, c) => a.id - c.id);
  if (!newCs.length && !newPs.length && !newBf.length) return null;
  const root = b.header.root.clone();
  const refList = root.find('refList') || root;
  const hh = prefixOf(refList) || 'hh:';
  const hcEl = refList.find('fillBrush') || refList.find('pt') || refList.find('intent') || refList.find('left');
  const hc = hcEl ? prefixOf(hcEl) : 'hc:';

  const fontfaces = refList.child('fontfaces');
  const faceId = (lang, name) => {
    if (!fontfaces) return 0;
    const ff = fontfaces.childrenNamed('fontface').find((f) => (f.get('lang', '') || '').toUpperCase() === LANG_NAMES[lang]);
    if (!ff) return 0;
    const fonts = ff.childrenNamed('font');
    const hit = fonts.find((f) => f.get('face') === name);
    if (hit) return hit.num('id', 0);
    let max = -1;
    for (const f of fonts) max = Math.max(max, f.num('id', 0));
    const id = max + 1;
    const el = mk(`${hh}font`, [['id', id], ['face', name], ['type', 'TTF'], ['isEmbedded', '0']], []);
    const ti = fonts.length ? fonts[0].child('typeInfo') : null;
    if (ti) el.children = [ti.clone()];
    ff.children.push(el);
    ff.set('fontCnt', fonts.length + 1);
    return id;
  };

  const setLangAttrs = (el, childName, value) => {
    let c = el.child(childName);
    if (!c) { c = mk(`${hh}${childName}`, [], []); el.children.push(c); }
    for (const l of LANGS) c.set(l, value);
  };
  const setFlag = (el, name, on, after) => {
    const cur = el.child(name);
    if (on && !cur) {
      const n = mk(`${hh}${name}`, [], []);
      let idx = -1;
      for (const a of after) { const i = el.children.findIndex((c) => c.type === 'el' && c.localName === a); if (i > idx) idx = i; }
      el.children.splice(idx + 1, 0, n);
    } else if (!on && cur) el.children = el.children.filter((c) => c !== cur);
  };

  const charProps = refList.child('charProperties');
  if (charProps && newCs.length) {
    for (const cs of newCs) {
      const base = doc.charShape(cs.baseId ?? cs.id);
      const src = isEl(base.origin) ? base.origin : charProps.childrenNamed('charPr')[0];
      // base.origin 은 원본 트리의 요소이므로, 복제한 트리에서 같은 id 의 요소를 찾아 복제한다.
      const srcId = src ? src.get('id') : null;
      const tmpl = charProps.childrenNamed('charPr').find((e) => e.get('id') === srcId) || charProps.childrenNamed('charPr')[0];
      const el = tmpl.clone();
      el.set('id', cs.id);
      el.set('height', Math.round(cs.size * 100));
      el.set('textColor', (cs.color || '#000000').toUpperCase());
      el.set('shadeColor', cs.shade ? cs.shade.toUpperCase() : 'none');
      let fr = el.child('fontRef');
      if (!fr) { fr = mk(`${hh}fontRef`, [], []); el.children.unshift(fr); }
      LANGS.forEach((l, i) => {
        if (!isEl(base.origin) || cs.fonts[i] !== base.fonts[i] || !fr.has(l)) fr.set(l, faceId(i, cs.fonts[i]));
      });
      if (cs.ratio !== base.ratio) setLangAttrs(el, 'ratio', cs.ratio);
      if (cs.spacing !== base.spacing) setLangAttrs(el, 'spacing', cs.spacing);
      if (cs.relSize !== base.relSize) setLangAttrs(el, 'relSz', cs.relSize);
      if (cs.offset !== base.offset) setLangAttrs(el, 'offset', cs.offset);
      setFlag(el, 'italic', cs.italic, ['fontRef', 'ratio', 'spacing', 'relSz', 'offset']);
      setFlag(el, 'bold', cs.bold, ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic']);
      if (cs.underline !== base.underline || !el.child('underline')) {
        let u = el.child('underline');
        if (!u) {
          u = mk(`${hh}underline`, [['type', 'NONE'], ['shape', 'SOLID'], ['color', '#000000']], []);
          let idx = -1;
          for (const a of ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold']) { const i = el.children.findIndex((c) => c.type === 'el' && c.localName === a); if (i > idx) idx = i; }
          el.children.splice(idx + 1, 0, u);
        }
        u.set('type', cs.underline === 'bottom' ? 'BOTTOM' : cs.underline === 'top' ? 'TOP' : 'NONE');
      }
      if (cs.strike !== base.strike || !el.child('strikeout')) {
        let s = el.child('strikeout');
        if (!s) {
          s = mk(`${hh}strikeout`, [['shape', 'NONE'], ['color', '#000000']], []);
          const i = el.children.findIndex((c) => c.type === 'el' && c.localName === 'underline');
          el.children.splice(i + 1, 0, s);
        }
        s.set('shape', cs.strike ? 'SOLID' : 'NONE');
      }
      setFlag(el, 'supscript', cs.sup, ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold', 'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave']);
      setFlag(el, 'subscript', cs.sub, ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold', 'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave', 'supscript']);
      charProps.children.push(el);
    }
    charProps.set('itemCnt', charProps.childrenNamed('charPr').length);
  }

  const paraProps = refList.child('paraProperties');
  if (paraProps && newPs.length) {
    for (const ps of newPs) {
      const base = doc.paraShape(ps.baseId ?? ps.id);
      const srcId = isEl(base.origin) ? base.origin.get('id') : null;
      const tmpl = paraProps.childrenNamed('paraPr').find((e) => e.get('id') === srcId) || paraProps.childrenNamed('paraPr')[0];
      const el = tmpl.clone();
      el.set('id', ps.id);
      const align = el.child('align');
      if (align) align.set('horizontal', ALIGN[ps.align] || 'JUSTIFY');
      const brk = el.child('breakSetting');
      if (brk) { brk.set('pageBreakBefore', ps.pageBreakBefore ? '1' : '0'); brk.set('keepWithNext', ps.keepWithNext ? '1' : '0'); }
      const applyTo = (holder, scale) => {
        if (!holder) return;
        const m = holder.child('margin');
        if (m) {
          const setv = (name, pt) => { const c = m.child(name); if (c) { c.set('value', Math.round((pt || 0) * 100 * scale)); c.set('unit', 'HWPUNIT'); } };
          setv('intent', ps.indent); setv('left', ps.marginLeft); setv('right', ps.marginRight); setv('prev', ps.spaceBefore); setv('next', ps.spaceAfter);
        }
        const ls = holder.child('lineSpacing');
        if (ls) {
          ls.set('type', LS_TYPE[ps.lineSpacingType] || 'PERCENT');
          ls.set('value', ps.lineSpacingType === 'percent' || !ps.lineSpacingType ? Math.round(ps.lineSpacing) : Math.round(ps.lineSpacing * 100 * scale));
        }
      };
      const sw = el.child('switch');
      if (sw) { applyTo(sw.child('case'), 1); applyTo(sw.child('default'), 2); }
      if (el.child('margin')) applyTo(el, 2);
      paraProps.children.push(el);
    }
    paraProps.set('itemCnt', paraProps.childrenNamed('paraPr').length);
  }

  const borderFills = refList.child('borderFills');
  if (borderFills && newBf.length) {
    for (const bf of newBf) {
      const side = (name, s) => {
        const v = s || { type: 'none', width: 0.1, color: '#000000' };
        return mk(`${hh}${name}`, [['type', BORDER_TYPE[v.type] || 'SOLID'], ['width', `${v.width || 0.12} mm`], ['color', (v.color || '#000000').toUpperCase()]], []);
      };
      const kids = [
        mk(`${hh}slash`, [['type', 'NONE'], ['Crooked', '0'], ['isCounter', '0']], []),
        mk(`${hh}backSlash`, [['type', 'NONE'], ['Crooked', '0'], ['isCounter', '0']], []),
        side('leftBorder', bf.left), side('rightBorder', bf.right), side('topBorder', bf.top), side('bottomBorder', bf.bottom),
        mk(`${hh}diagonal`, [['type', 'SOLID'], ['width', '0.1 mm'], ['color', '#000000']], []),
      ];
      if (bf.fill) kids.push(mk(`${hc}fillBrush`, [], [mk(`${hc}winBrush`, [['faceColor', bf.fill.toUpperCase()], ['hatchColor', '#999999'], ['alpha', '0']], [])]));
      borderFills.children.push(mk(`${hh}borderFill`, [['id', bf.id], ['threeD', '0'], ['shadow', '0'], ['centerLine', 'NONE'], ['breakCellSeparateLine', '0']], kids));
    }
    borderFills.set('itemCnt', borderFills.childrenNamed('borderFill').length);
  }
  void ctx;
  return serializeXml({ prolog: b.header.prolog, root, epilog: b.header.epilog });
}

// ---------------------------------------------------------------------------
// 구역 XML

class SectionWriter {
  constructor(doc, ctx) {
    this.doc = doc;
    this.ctx = ctx;
    this.firstParas = new Set(doc.sections.map((s) => s.paras[0]).filter(Boolean));
    const sample = doc.backing.sections[0].xml.root.child('p');
    this.hp = sample ? prefixOf(sample) : 'hp:';
    const any = doc.backing.sections[0].xml.root.find('pt0') || doc.backing.header.root.find('intent');
    this.hc = any ? prefixOf(any) : 'hc:';
  }

  emitList(sparas, sec = null) {
    return sparas.map((sp, i) => this.emitPara(sp, i === 0 ? sec : null));
  }

  emitPara(sp, sec) {
    const src = sp.src;
    const origin = src && isEl(src.origin) && src.origin.localName === 'p' ? src.origin : null;
    let force = false;
    if (origin) {
      const wasFirst = this.firstParas.has(src);
      const staysFirst = !!sec && !!sec.section && sec.section.paras[0] === src && !sec.pageDirty;
      if (wasFirst !== !!sec || (wasFirst && !staysFirst)) force = true;
    }
    if (origin && !sp.deep && !force) return origin;
    if (origin && !sp.own && !force) return this.rebuildNested(sp, origin);
    return this.regenPara(sp, origin, sec);
  }

  rebuildNested(sp, origin) {
    const map = new Map();
    for (const it of sp.items) if (it.t === 'ctrl' && it.deep && isEl(it.ctrl.origin)) map.set(it.ctrl.origin, this.rebuildCtrl(it));
    const kids = [];
    for (const c of origin.children) {
      if (c.type === 'el' && c.localName === 'linesegarray') continue;
      if (c.type === 'el' && c.localName === 'run') kids.push(shallow(c, c.children.map((k) => map.get(k) || k)));
      else kids.push(c);
    }
    return shallow(origin, kids);
  }

  regenPara(sp, origin, sec) {
    const hp = this.hp;
    const attrs = origin ? origin.attrs.map((a) => [a[0], a[1]]) : [['id', '0'], ['paraPrIDRef', '0'], ['styleIDRef', '0'], ['pageBreak', '0'], ['columnBreak', '0'], ['merged', '0']];
    const p = mk(`${hp}p`, attrs, []);
    p.set('paraPrIDRef', sp.paraShapeId);
    p.set('styleIDRef', sp.styleId);
    p.set('pageBreak', sp.pageBreak ? '1' : '0');
    const runs = [];
    let run = null;
    let tEl = null;
    const firstCs = sp.items.length ? sp.items[0].cs : sp.cs0 ?? 0;
    const openRun = (cs) => {
      if (run && run.get('charPrIDRef') === String(cs)) return run;
      run = mk(`${hp}run`, [['charPrIDRef', cs]], []);
      runs.push(run);
      tEl = null;
      return run;
    };
    const openT = (cs) => {
      openRun(cs);
      if (!tEl) { tEl = mk(`${hp}t`, [], []); run.children.push(tEl); }
      return tEl;
    };
    const pushText = (s) => {
      const last = tEl.children[tEl.children.length - 1];
      if (last && last.type === 'text') last.value += s;
      else tEl.children.push(txt(s));
    };
    if (sec) {
      const tmpl = sec.section || this.doc.sections[0];
      const r = openRun(firstCs);
      if (tmpl.secd && isEl(tmpl.secd.ctrl.origin)) r.children.push(sec.pageDirty && sec.page ? this.patchSecPr(tmpl.secd.ctrl.origin, sec.page) : tmpl.secd.ctrl.origin);
      if (tmpl.cold && isEl(tmpl.cold.ctrl.origin)) r.children.push(tmpl.cold.ctrl.origin);
    }
    for (const it of sp.items) {
      if (it.t === 'text') {
        openT(it.cs);
        let buf = '';
        for (const ch of it.text) {
          let special = null;
          if (ch === ' ') special = 'nbSpace';
          else if (ch === ' ') special = 'fwSpace';
          else if (ch === '­') special = 'hyphen';
          else if (ch < ' ' && ch !== '\t') continue;
          if (special) { if (buf) { pushText(buf); buf = ''; } tEl.children.push(mk(`${hp}${special}`, [], [])); }
          else buf += ch;
        }
        if (buf) pushText(buf);
      } else if (it.t === 'tab') {
        openT(it.cs);
        const o = it.src && isEl(it.src.origin) ? it.src.origin : null;
        tEl.children.push(o || mk(`${hp}tab`, [['width', '4000'], ['leader', '0'], ['type', '1']], []));
      } else if (it.t === 'br') {
        openT(it.cs);
        tEl.children.push(mk(`${hp}lineBreak`, [], []));
      } else if (it.t === 'ctrl') {
        const c = it.ctrl;
        let el = null;
        if (it.isNew) {
          if (c.kind === 'table') el = this.newTable(it);
          else if (c.kind === 'picture') el = this.newPicture(it);
        } else if (isEl(c.origin)) {
          if (c.kind === 'secdef') continue;
          if (c.inText) { openT(it.cs); tEl.children.push(c.origin); continue; }
          el = it.deep ? this.rebuildCtrl(it) : c.origin;
        }
        if (!el) continue;
        openRun(it.cs);
        run.children.push(el);
        tEl = null;
      }
    }
    if (!runs.length) runs.push(mk(`${hp}run`, [['charPrIDRef', sp.cs0 ?? firstCs]], []));
    p.children = runs;
    return p;
  }

  patchSecPr(secPr, page) {
    const kids = secPr.children.map((c) => {
      if (c.type !== 'el' || c.localName !== 'pagePr') return c;
      const pp = shallow(c, c.children.map((m) => {
        if (m.type !== 'el' || m.localName !== 'margin') return m;
        const mm = shallow(m, m.children);
        mm.set('header', pt2hu(page.marginHeader)); mm.set('footer', pt2hu(page.marginFooter)); mm.set('gutter', pt2hu(page.gutter || 0));
        mm.set('left', pt2hu(page.marginLeft)); mm.set('right', pt2hu(page.marginRight)); mm.set('top', pt2hu(page.marginTop)); mm.set('bottom', pt2hu(page.marginBottom));
        return mm;
      }));
      const land = !!page.landscape;
      pp.set('landscape', land ? 'NARROWLY' : 'WIDELY');
      pp.set('width', pt2hu(land ? page.height : page.width));
      pp.set('height', pt2hu(land ? page.width : page.height));
      return pp;
    });
    return shallow(secPr, kids);
  }

  subListWith(sub, paras) {
    const kids = [];
    let done = false;
    for (const c of sub.children) {
      if (c.type === 'el' && c.localName === 'p') {
        if (!done) { kids.push(...this.emitList(paras)); done = true; }
      } else kids.push(c);
    }
    if (!done) kids.push(...this.emitList(paras));
    return shallow(sub, kids);
  }

  /** 요소 트리에서 target(subList)을 새 것으로 바꾼 사본을 만든다 (경로 위의 요소만 복제). */
  replaceDeep(el, target, replacement) {
    if (el === target) return replacement;
    let changed = false;
    const kids = el.children.map((c) => {
      if (c.type !== 'el') return c;
      const n = this.replaceDeep(c, target, replacement);
      if (n !== c) changed = true;
      return n;
    });
    return changed ? shallow(el, kids) : el;
  }

  rebuildCtrl(it) {
    const c = it.ctrl;
    let el = c.origin;
    if (c.caption && it.capParas && isEl(c.caption.subList)) el = this.replaceDeep(el, c.caption.subList, this.subListWith(c.caption.subList, it.capParas));
    if (c.kind === 'table' && it.cells) return this.rebuildTable(it, el);
    if (it.paras && isEl(c.subList)) el = this.replaceDeep(el, c.subList, this.subListWith(c.subList, it.paras));
    return el;
  }

  rebuildTable(it, el) {
    const c = it.ctrl;
    const hp = this.hp;
    const cells = it.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
    const anyTc = c.cells.find((x) => isEl(x.origin));
    const rows = [];
    for (let r = 0; r < it.rows; r++) rows.push([]);
    for (const cell of cells) if (cell.row < rows.length) rows[cell.row].push(cell);
    const trTmpl = el.child('tr');
    const trEls = rows.map((row) => {
      const tcs = row.map((cell) => {
        const tmpl = (cell.cell && isEl(cell.cell.origin) ? cell.cell : null) || (cell.tmpl && isEl(cell.tmpl.origin) ? cell.tmpl : null) || anyTc;
        const geom = it.structChanged || !cell.cell;
        const tc = tmpl.origin;
        const kids = tc.children.map((k) => {
          if (k.type !== 'el') return k;
          if (k.localName === 'subList') return this.subListWith(k, cell.paras);
          if (!geom) return k;
          if (k.localName === 'cellAddr') { const n = shallow(k, k.children); n.set('colAddr', cell.col); n.set('rowAddr', cell.row); return n; }
          if (k.localName === 'cellSpan') { const n = shallow(k, k.children); n.set('colSpan', cell.colSpan); n.set('rowSpan', cell.rowSpan); return n; }
          if (k.localName === 'cellSz') { const n = shallow(k, k.children); if (cell.width > 0) n.set('width', pt2hu(cell.width)); if (cell.height > 0) n.set('height', pt2hu(cell.height)); return n; }
          return k;
        });
        const n = shallow(tc, kids);
        if (geom && cell.borderFillId) n.set('borderFillIDRef', cell.borderFillId);
        return n;
      });
      return trTmpl ? shallow(trTmpl, tcs) : mk(`${hp}tr`, [], tcs);
    });
    const kids = [];
    let placed = false;
    for (const k of el.children) {
      if (k.type === 'el' && k.localName === 'tr') {
        if (!placed) { kids.push(...trEls); placed = true; }
        continue;
      }
      if (it.structChanged && k.type === 'el' && k.localName === 'sz') {
        const n = shallow(k, k.children);
        let w = 0;
        if (it.colWidths && it.colWidths.length) for (const x of it.colWidths) w += x;
        if (w > 0) n.set('width', pt2hu(w));
        const hs = new Array(it.rows).fill(0);
        for (const cell of cells) if (cell.rowSpan === 1 && cell.row < hs.length) hs[cell.row] = Math.max(hs[cell.row], pt2hu(cell.height || 0));
        const total = hs.reduce((a, b) => a + b, 0);
        if (total > 0) n.set('height', total);
        kids.push(n);
        continue;
      }
      kids.push(k);
    }
    if (!placed) kids.push(...trEls);
    const out = shallow(el, kids);
    if (it.structChanged) { out.set('rowCnt', it.rows); out.set('colCnt', it.cols); }
    return out;
  }

  newTable(it) {
    const hp = this.hp;
    const cells = it.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
    let width = 0;
    if (it.colWidths && it.colWidths.length) for (const x of it.colWidths) width += x;
    else width = it.tableWidth || 0;
    const hs = new Array(it.rows).fill(0);
    for (const cell of cells) if (cell.rowSpan === 1 && cell.row < hs.length) hs[cell.row] = Math.max(hs[cell.row], pt2hu(cell.height || 0));
    const total = hs.reduce((a, b) => a + b, 0);
    const bf = cells.length ? cells[0].borderFillId || 1 : 1;
    const rows = [];
    for (let r = 0; r < it.rows; r++) rows.push([]);
    for (const cell of cells) if (cell.row < rows.length) rows[cell.row].push(cell);
    const trEls = rows.map((row) => mk(`${hp}tr`, [], row.map((cell) => mk(`${hp}tc`, [['name', ''], ['header', '0'], ['hasMargin', '0'], ['protect', '0'], ['editable', '0'], ['dirty', '0'], ['borderFillIDRef', cell.borderFillId || bf]], [
      mk(`${hp}subList`, [['id', ''], ['textDirection', 'HORIZONTAL'], ['lineWrap', 'BREAK'], ['vertAlign', 'CENTER'], ['linkListIDRef', '0'], ['linkListNextIDRef', '0'], ['textWidth', '0'], ['textHeight', '0'], ['hasTextRef', '0'], ['hasNumRef', '0']], this.emitList(cell.paras)),
      mk(`${hp}cellAddr`, [['colAddr', cell.col], ['rowAddr', cell.row]], []),
      mk(`${hp}cellSpan`, [['colSpan', cell.colSpan], ['rowSpan', cell.rowSpan]], []),
      mk(`${hp}cellSz`, [['width', pt2hu(cell.width)], ['height', pt2hu(cell.height)]], []),
      mk(`${hp}cellMargin`, [['left', '510'], ['right', '510'], ['top', '141'], ['bottom', '141']], []),
    ]))));
    return mk(`${hp}tbl`, [['id', nextId()], ['zOrder', this.ctx.nextZ++], ['numberingType', 'TABLE'], ['textWrap', 'TOP_AND_BOTTOM'], ['textFlow', 'BOTH_SIDES'], ['lock', '0'], ['dropcapstyle', 'None'], ['pageBreak', 'CELL'], ['repeatHeader', '1'], ['rowCnt', it.rows], ['colCnt', it.cols], ['cellSpacing', '0'], ['borderFillIDRef', bf], ['noAdjust', '0']], [
      mk(`${hp}sz`, [['width', pt2hu(width)], ['widthRelTo', 'ABSOLUTE'], ['height', total], ['heightRelTo', 'ABSOLUTE'], ['protect', '0']], []),
      mk(`${hp}pos`, [['treatAsChar', it.ctrl.inline ? '1' : '0'], ['affectLSpacing', '0'], ['flowWithText', '1'], ['allowOverlap', '0'], ['holdAnchorAndSO', '0'], ['vertRelTo', 'PARA'], ['horzRelTo', 'COLUMN'], ['vertAlign', 'TOP'], ['horzAlign', 'LEFT'], ['vertOffset', '0'], ['horzOffset', '0']], []),
      mk(`${hp}outMargin`, [['left', '283'], ['right', '283'], ['top', '283'], ['bottom', '283']], []),
      mk(`${hp}inMargin`, [['left', '510'], ['right', '510'], ['top', '141'], ['bottom', '141']], []),
      ...trEls,
    ]);
  }

  newPicture(it) {
    const hp = this.hp, hc = this.hc;
    const c = it.ctrl;
    const binId = this.ctx.addBin(c.bytes, c.ext);
    const W = Math.max(1, pt2hu(c.width));
    const H = Math.max(1, pt2hu(c.height));
    const info = sniffImage(c.bytes);
    const W0 = info && info.width ? info.width * 75 : W;
    const H0 = info && info.height ? info.height * 75 : H;
    const num = (v) => String(Math.round(v * 1e6) / 1e6);
    const matrix = (name, a, d) => mk(`${hc}${name}`, [['e1', num(a)], ['e2', '0'], ['e3', '0'], ['e4', '0'], ['e5', num(d)], ['e6', '0']], []);
    return mk(`${hp}pic`, [['id', nextId()], ['zOrder', this.ctx.nextZ++], ['numberingType', 'PICTURE'], ['textWrap', 'TOP_AND_BOTTOM'], ['textFlow', 'BOTH_SIDES'], ['lock', '0'], ['dropcapstyle', 'None'], ['href', ''], ['groupLevel', '0'], ['instid', nextId()], ['reverse', '0']], [
      mk(`${hp}offset`, [['x', '0'], ['y', '0']], []),
      mk(`${hp}orgSz`, [['width', W0], ['height', H0]], []),
      mk(`${hp}curSz`, [['width', W], ['height', H]], []),
      mk(`${hp}flip`, [['horizontal', '0'], ['vertical', '0']], []),
      mk(`${hp}rotationInfo`, [['angle', '0'], ['centerX', W >> 1], ['centerY', H >> 1], ['rotateimage', '1']], []),
      mk(`${hp}renderingInfo`, [], [matrix('transMatrix', 1, 1), matrix('scaMatrix', W / W0, H / H0), matrix('rotMatrix', 1, 1)]),
      mk(`${hc}img`, [['binaryItemIDRef', binId], ['bright', '0'], ['contrast', '0'], ['effect', 'REAL_PIC'], ['alpha', '0']], []),
      mk(`${hp}imgRect`, [], [
        mk(`${hc}pt0`, [['x', '0'], ['y', '0']], []), mk(`${hc}pt1`, [['x', W0], ['y', '0']], []),
        mk(`${hc}pt2`, [['x', W0], ['y', H0]], []), mk(`${hc}pt3`, [['x', '0'], ['y', H0]], []),
      ]),
      mk(`${hp}imgClip`, [['left', '0'], ['right', W0], ['top', '0'], ['bottom', H0]], []),
      mk(`${hp}inMargin`, [['left', '0'], ['right', '0'], ['top', '0'], ['bottom', '0']], []),
      mk(`${hp}imgDim`, [['dimwidth', W0], ['dimheight', H0]], []),
      mk(`${hp}effects`, [], []),
      mk(`${hp}sz`, [['width', W], ['widthRelTo', 'ABSOLUTE'], ['height', H], ['heightRelTo', 'ABSOLUTE'], ['protect', '0']], []),
      mk(`${hp}pos`, [['treatAsChar', '1'], ['affectLSpacing', '0'], ['flowWithText', '1'], ['allowOverlap', '0'], ['holdAnchorAndSO', '0'], ['vertRelTo', 'PARA'], ['horzRelTo', 'COLUMN'], ['vertAlign', 'TOP'], ['horzAlign', 'LEFT'], ['vertOffset', '0'], ['horzOffset', '0']], []),
      mk(`${hp}outMargin`, [['left', '0'], ['right', '0'], ['top', '0'], ['bottom', '0']], []),
    ]);
  }
}

function previewText(model, limit = 2000) {
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
      lines.push(line);
      total += line.length + 2;
      for (const it of p.items) if (it.t === 'ctrl' && it.cells) for (const c of it.cells) visit(c.paras);
    }
  };
  for (const s of model.sections) visit(s.paras);
  return lines.join('\r\n').slice(0, limit);
}

export async function writeHwpx(doc, model) {
  const b = doc.backing;
  if (!b || b.kind !== 'hwpx') throw new Error('HWPX 원본 정보가 없는 문서입니다.');
  let maxImage = 0;
  for (const e of b.entries) {
    const m = /^BinData\/image(\d+)\./i.exec(e.name);
    if (m) maxImage = Math.max(maxImage, Number(m[1]));
  }
  const ctx = {
    newBins: [],
    nextZ: 1000,
    addBin(bytes, ext) {
      const found = this.newBins.find((x) => x.bytes === bytes);
      if (found) return found.id;
      const id = `image${++maxImage}`;
      const e = (ext || 'png').toLowerCase();
      this.newBins.push({ id, bytes, ext: e, name: `BinData/${id}.${e}` });
      return id;
    },
  };
  const writer = new SectionWriter(doc, ctx);
  const tmplXml = b.sections[0].xml;
  const sectionOut = [];
  for (let i = 0; i < model.sections.length; i++) {
    const ms = model.sections[i];
    const si = ms.section ? doc.sections.indexOf(ms.section) : -1;
    const ob = si >= 0 ? b.sections[si] : null;
    const name = `Contents/section${i}.xml`;
    const origEntry = ob ? b.entries.find((e) => e.name === ob.path) : null;
    if (ms.clean && origEntry) { sectionOut.push({ name, passthrough: origEntry }); continue; }
    const src = ob ? ob.xml : tmplXml;
    const paras = writer.emitList(ms.paras, { section: ms.section, page: ms.page, pageDirty: ms.pageDirty });
    const others = src.root.children.filter((c) => !(c.type === 'el' && c.localName === 'p'));
    const root = shallow(src.root, [...paras, ...others.filter((c) => c.type !== 'text')]);
    sectionOut.push({ name, data: utf8Encode(serializeXml({ prolog: src.prolog, root, epilog: src.epilog })) });
  }
  const headerXml = buildHeader(doc, ctx);

  // content.hpf: 새 그림/구역 항목
  let hpfData = null;
  const origSecCount = b.sections.length;
  if (b.hpf && (ctx.newBins.length || model.sections.length !== origSecCount)) {
    const root = b.hpf.root.clone();
    const manifest = root.find('manifest');
    const spine = root.find('spine');
    if (manifest) {
      const pre = prefixOf(manifest) || 'opf:';
      for (const bin of ctx.newBins) manifest.children.push(mk(`${pre}item`, [['id', bin.id], ['href', bin.name], ['media-type', mimeForExt(bin.ext)], ['isEmbeded', '1']], []));
      for (let i = 0; i < Math.max(model.sections.length, origSecCount); i++) {
        const id = `section${i}`;
        const have = manifest.childrenNamed('item').find((x) => x.get('id') === id);
        if (i < model.sections.length && !have) {
          manifest.children.push(mk(`${pre}item`, [['id', id], ['href', `Contents/${id}.xml`], ['media-type', 'application/xml']], []));
          if (spine) spine.children.push(mk(`${prefixOf(spine) || 'opf:'}itemref`, [['idref', id], ['linear', 'yes']], []));
        } else if (i >= model.sections.length && have) {
          manifest.children = manifest.children.filter((x) => x !== have);
          if (spine) spine.children = spine.children.filter((x) => !(x.type === 'el' && x.get('idref') === id));
        }
      }
    }
    hpfData = utf8Encode(serializeXml({ prolog: b.hpf.prolog, root, epilog: b.hpf.epilog }));
  }

  const out = [];
  const secNames = new Set(b.sections.map((s) => s.path));
  let secPlaced = false;
  const placeSections = () => { if (!secPlaced) { secPlaced = true; out.push(...sectionOut); } };
  for (const e of b.entries) {
    if (e.name === 'mimetype') { out.unshift({ name: e.name, data: await e.getData(), store: true }); continue; }
    if (secNames.has(e.name)) { placeSections(); continue; }
    if (e.name === 'Contents/header.xml' && headerXml) { out.push({ name: e.name, data: utf8Encode(headerXml) }); continue; }
    if (e.name === 'Contents/content.hpf' && hpfData) { out.push({ name: e.name, data: hpfData }); continue; }
    if (e.name === 'Preview/PrvText.txt') { out.push({ name: e.name, data: utf8Encode(previewText(model)) }); continue; }
    out.push({ name: e.name, passthrough: e });
  }
  placeSections();
  if (!out.length || out[0].name !== 'mimetype') out.unshift({ name: 'mimetype', data: utf8Encode('application/hwp+zip'), store: true });
  for (const bin of ctx.newBins) out.push({ name: bin.name, data: bin.bytes, store: /^(png|jpg|jpeg|gif)$/.test(bin.ext) });
  return writeZip(out);
}

export { parseXml };
