// 편집 DOM → 저장용 모델
//
// 1) extractPlist: DOM 을 읽어 문단/항목 목록(X 모델)을 만든다.
// 2) buildSaveModel: X 모델을 원본 문서 모델과 맞춰 보고, 바뀌지 않은 문단은 원본을 그대로
//    쓰도록 표시한 저장 모델(S 모델)을 만든다.

const CS_RE = /(?:^|\s)c(\d+)(?:\s|$)/;
const PS_RE = /(?:^|\s)p(\d+)(?:\s|$)/;
const BF_RE = /(?:^|\s)b(\d+)(?:\s|$)/;

export const csOf = (el) => { const m = el && el.className && typeof el.className === 'string' ? CS_RE.exec(el.className) : null; return m ? Number(m[1]) : null; };
export const psOf = (el) => { const m = el && typeof el.className === 'string' ? PS_RE.exec(el.className) : null; return m ? Number(m[1]) : null; };
export const bfOf = (el) => { const m = el && typeof el.className === 'string' ? BF_RE.exec(el.className) : null; return m ? Number(m[1]) : null; };

const isPara = (n) => n.nodeType === 1 && n.classList.contains('para');

/** 표 DOM 의 격자 정보를 계산한다. */
export function tableGrid(table) {
  const body = table.tBodies[0];
  const trs = body ? Array.from(body.rows) : [];
  const occ = [];
  const cells = [];
  let cols = 0;
  trs.forEach((tr, r) => {
    occ[r] = occ[r] || [];
    let c = 0;
    for (const td of Array.from(tr.cells)) {
      while (occ[r][c]) c++;
      const rs = Math.max(1, td.rowSpan || 1);
      const cs = Math.max(1, td.colSpan || 1);
      const cell = { el: td, r, c, rs, cs };
      cells.push(cell);
      for (let i = 0; i < rs; i++) {
        occ[r + i] = occ[r + i] || [];
        for (let j = 0; j < cs; j++) occ[r + i][c + j] = cell;
      }
      c += cs;
      cols = Math.max(cols, c);
    }
  });
  const rows = Math.max(trs.length, occ.length);
  return { rows, cols, cells, occ, trs, at: (r, c) => (occ[r] ? occ[r][c] || null : null) };
}

export class Extractor {
  constructor(root, reg) {
    this.root = root;
    this.reg = reg;
  }

  /** 문단 목록 컨테이너(.plist)의 문단들을 읽는다. */
  extractPlist(container) {
    const out = [];
    let stray = null;
    const flushStray = () => {
      if (!stray) return;
      const x = { el: null, pid: null, ps: stray.ps, st: stray.st, pb: false, items: [] };
      for (const n of stray.nodes) this.walkInline(n, x, stray.cs);
      this.finishPara(x, stray.cs);
      if (x.items.length || stray.forced) out.push(x);
      stray = null;
    };
    for (const n of Array.from(container.childNodes)) {
      if (isPara(n)) { flushStray(); out.push(this.extractPara(n)); continue; }
      if (n.nodeType === 1 && (n.classList.contains('cap') || n.tagName === 'COLGROUP')) continue;
      if (n.nodeType === 3 && !n.nodeValue.replace(/[​\s]/g, '')) continue;
      if (n.nodeType !== 1 && n.nodeType !== 3) continue;
      if (!stray) {
        const prev = out[out.length - 1];
        stray = { nodes: [], ps: prev ? prev.ps : 0, st: prev ? prev.st : 0, cs: prev ? prev.cs0 : 0, forced: false };
      }
      // 블록 요소(div 등)는 각각 한 문단으로
      if (n.nodeType === 1 && /^(DIV|P|LI|H[1-6])$/.test(n.tagName)) {
        flushStray();
        const prev = out[out.length - 1];
        stray = { nodes: Array.from(n.childNodes), ps: psOf(n) ?? (prev ? prev.ps : 0), st: prev ? prev.st : 0, cs: prev ? prev.cs0 : 0, forced: true };
        flushStray();
      } else stray.nodes.push(n);
    }
    flushStray();
    return out;
  }

  extractPara(el) {
    const pid = el.dataset.pid ? Number(el.dataset.pid) : null;
    const orig = pid !== null ? this.reg.paras.get(pid) : null;
    const x = {
      el, pid,
      ps: psOf(el) ?? (orig ? orig.paraShapeId : 0),
      st: el.dataset.st !== undefined ? Number(el.dataset.st) : orig ? orig.styleId : 0,
      pb: el.dataset.pb === '1',
      items: [],
    };
    const dflt = orig ? (orig.items.length ? orig.items[0].cs : orig.cs0 ?? 0) : 0;
    for (const n of Array.from(el.childNodes)) this.walkInline(n, x, dflt);
    this.finishPara(x, dflt);
    return x;
  }

  finishPara(x, dflt) {
    const items = x.items;
    // 문단 끝의 채움용 <br> 하나는 버린다.
    if (items.length && items[items.length - 1].t === 'br') {
      x.cs0 = items[items.length - 1].cs;
      items.pop();
    }
    // 같은 글자 모양의 이웃 텍스트 합치기
    const merged = [];
    for (const it of items) {
      const last = merged[merged.length - 1];
      if (it.t === 'text' && last && last.t === 'text' && last.cs === it.cs) last.text += it.text;
      else merged.push(it);
    }
    x.items = merged;
    if (x.cs0 === undefined) x.cs0 = merged.length ? merged[merged.length - 1].cs : dflt;
    x.sig = this.signature(x);
  }

  signature(x) {
    const parts = [x.ps, x.st, x.pb ? 1 : 0];
    for (const it of x.items) {
      if (it.t === 'text') parts.push('t', it.cs, it.text);
      else if (it.t === 'tab') parts.push('b', it.cs, it.tab ?? -1);
      else if (it.t === 'br') parts.push('n', it.cs);
      else parts.push('c', it.cid ?? `new${it.newKind}`, it.cs);
    }
    if (!x.items.length) parts.push('e', x.cs0);
    return JSON.stringify(parts);
  }

  walkInline(n, x, cs) {
    if (n.nodeType === 3) {
      const text = n.nodeValue.replace(/[​\r\n]/g, '');
      if (text) this.pushText(x, text, cs, null);
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n;
    if (el.tagName === 'BR') { x.items.push({ t: 'br', cs }); return; }
    const own = csOf(el);
    const ecs = own ?? cs;
    if (el.classList.contains('tab')) {
      const tab = el.dataset.tab !== undefined ? Number(el.dataset.tab) : null;
      this.pushText(x, el.textContent.replace(/[​\r\n]/g, ''), ecs, tab);
      return;
    }
    if (el.classList.contains('cap')) return;
    if (el.dataset.cid !== undefined) { x.items.push(this.extractCtrl(el, ecs)); return; }
    if (el.dataset.newimg !== undefined) { x.items.push({ t: 'ctrl', cid: null, newKind: 'picture', cs: ecs, el }); return; }
    if (el.tagName === 'TABLE' && el.classList.contains('tbl')) { x.items.push(this.extractCtrl(el, ecs)); return; }
    if (el.tagName === 'IMG' || el.tagName === 'TABLE') return; // 알 수 없는 개체는 버린다
    for (const c of Array.from(el.childNodes)) this.walkInline(c, x, ecs);
  }

  pushText(x, text, cs, tabIdx) {
    let first = true;
    const segs = text.split('\t');
    segs.forEach((seg, i) => {
      if (i > 0) {
        const it = { t: 'tab', cs };
        if (first && tabIdx !== null) it.tab = tabIdx;
        first = false;
        x.items.push(it);
      }
      if (seg) x.items.push({ t: 'text', text: seg, cs });
    });
  }

  extractCtrl(el, cs) {
    const cid = el.dataset.cid !== undefined ? Number(el.dataset.cid) : null;
    const item = { t: 'ctrl', cid, cs, el };
    const ctrl = cid !== null ? this.reg.ctrls.get(cid) : null;
    if (el.tagName === 'TABLE') {
      if (cid === null) item.newKind = 'table';
      const grid = tableGrid(el);
      item.rows = grid.rows;
      item.cols = grid.cols;
      item.tableWidth = parseFloat(el.style.width) || 0;
      item.colWidths = Array.from(el.querySelectorAll(':scope > colgroup > col')).map((c) => parseFloat(c.style.width) || 0);
      item.cells = grid.cells.map((g) => ({
        idx: g.el.dataset.cell !== undefined ? Number(g.el.dataset.cell) : null,
        row: g.r, col: g.c, rowSpan: g.rs, colSpan: g.cs,
        width: parseFloat(g.el.dataset.w) || 0, height: parseFloat(g.el.dataset.h) || 0,
        bf: bfOf(g.el), paras: this.extractPlist(g.el),
      }));
    } else if (el.classList.contains('tbox')) {
      item.paras = this.extractPlist(el);
    } else if (ctrl && (ctrl.kind === 'note' || ctrl.kind === 'hf')) {
      const sec = el.closest('.sec');
      const host = sec ? sec.querySelector(`.${ctrl.kind}[data-cid="${cid}"]`) : null;
      item.paras = host ? this.extractPlist(host) : null;
    }
    if (cid !== null) {
      const cap = el.parentNode ? Array.from(el.parentNode.children).find((c) => c.classList.contains('cap') && c.dataset.cap === String(cid)) : null;
      if (cap) item.capParas = this.extractPlist(cap);
    }
    return item;
  }

  /** 문서 전체: 구역별 문단 목록 */
  extractDoc() {
    const secs = [];
    for (const secEl of Array.from(this.root.children)) {
      if (!secEl.classList || !secEl.classList.contains('sec')) continue;
      const body = secEl.querySelector(':scope > .body');
      let page = null;
      if (secEl.dataset.page) { try { page = JSON.parse(secEl.dataset.page); } catch { page = null; } }
      secs.push({ index: Number(secEl.dataset.sec), el: secEl, page, paras: body ? this.extractPlist(body) : [] });
    }
    return secs;
  }
}

/** 렌더 직후의 기준 서명(문단 uid → 서명)을 만든다. */
export function buildBaseline(root, reg) {
  const ex = new Extractor(root, reg);
  const sigs = new Map();
  const visit = (paras) => {
    for (const x of paras) {
      if (x.pid !== null && !sigs.has(x.pid)) sigs.set(x.pid, x.sig);
      for (const it of x.items) {
        if (it.t !== 'ctrl') continue;
        if (it.cells) for (const c of it.cells) visit(c.paras);
        if (it.paras) visit(it.paras);
        if (it.capParas) visit(it.capParas);
      }
    }
  };
  for (const s of ex.extractDoc()) visit(s.paras);
  return { sigs };
}

function sameList(sparas, origParas) {
  if (!origParas || sparas.length !== origParas.length) return false;
  for (let i = 0; i < sparas.length; i++) if (sparas[i].src !== origParas[i] || sparas[i].deep) return false;
  return true;
}

/**
 * 저장 모델을 만든다.
 * 반환: { sections: [{ section, paras: [SPara] }] }
 *   SPara  { src, own, deep, paraShapeId, styleId, pageBreak, cs0, items }
 *   SItem  text/tab/br 는 그대로, ctrl 은 { t:'ctrl', cs, ctrl, isNew, deep, cells?, paras?, capParas?, ... }
 */
export function buildSaveModel(doc, root, reg, baseline, newImages) {
  const ex = new Extractor(root, reg);
  const seenP = new Set();
  const seenC = new Set();

  const makeParas = (xs) => xs.map(makePara);
  function makePara(x) {
    let src = null;
    if (x.pid !== null && !seenP.has(x.pid) && reg.paras.has(x.pid)) { src = reg.paras.get(x.pid); seenP.add(x.pid); }
    // 읽지 못한 문단(broken)은 다시 만들 수 없으므로 언제나 원본 그대로 둔다.
    const own = src && src.broken ? false : !src || baseline.sigs.get(x.pid) !== x.sig;
    const sp = { src, own, deep: false, paraShapeId: x.ps, styleId: x.st, pageBreak: x.pb, cs0: x.cs0, items: [] };
    let deep = sp.own;
    for (const it of x.items) {
      if (it.t !== 'ctrl') {
        if (it.t === 'tab' && it.tab !== undefined && it.tab !== null && reg.tabs[it.tab]) sp.items.push({ t: 'tab', cs: it.cs, src: reg.tabs[it.tab] });
        else sp.items.push({ t: it.t, cs: it.cs, text: it.text });
        continue;
      }
      const si = makeCtrl(it);
      if (!si) continue;
      if (si.deep) deep = true;
      sp.items.push(si);
    }
    sp.deep = deep;
    return sp;
  }

  function makeCtrl(it) {
    if (it.cid === null) {
      if (it.newKind === 'picture') {
        const img = newImages.get(it.el.dataset.newimg);
        if (!img) return null;
        return {
          t: 'ctrl', cs: it.cs, isNew: true, deep: true,
          ctrl: { kind: 'picture', isNew: true, bytes: img.bytes, ext: img.ext, mime: img.mime, width: parseFloat(it.el.style.width) || 100, height: parseFloat(it.el.style.height) || 100, inline: true },
        };
      }
      if (it.newKind === 'table') {
        return {
          t: 'ctrl', cs: it.cs, isNew: true, deep: true, structChanged: true,
          ctrl: { kind: 'table', isNew: true, inline: false, horzAlign: 'left' },
          rows: it.rows, cols: it.cols, tableWidth: it.tableWidth, colWidths: it.colWidths,
          cells: it.cells.map((c) => ({ cell: null, row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, width: c.width, height: c.height, borderFillId: c.bf ?? 0, paras: makeParas(c.paras), listChanged: true })),
        };
      }
      return null;
    }
    const ctrl = reg.ctrls.get(it.cid);
    if (!ctrl) return null;
    const copy = seenC.has(it.cid);
    seenC.add(it.cid);
    const si = { t: 'ctrl', cs: it.cs, ctrl, copy, deep: copy };
    if (ctrl.kind === 'table' && it.cells) {
      si.rows = it.rows; si.cols = it.cols; si.tableWidth = it.tableWidth; si.colWidths = it.colWidths;
      let struct = it.cells.length !== ctrl.cells.length || it.rows !== ctrl.rows || it.cols < ctrl.cols;
      si.cells = it.cells.map((c) => {
        const cell = !copy && c.idx !== null && ctrl.cells[c.idx] ? ctrl.cells[c.idx] : null;
        const tmpl = c.idx !== null && ctrl.cells[c.idx] ? ctrl.cells[c.idx] : null;
        const paras = makeParas(c.paras);
        const listChanged = !cell || !sameList(paras, cell.paras);
        if (!tmpl || tmpl.row !== c.row || tmpl.col !== c.col || tmpl.rowSpan !== c.rowSpan || tmpl.colSpan !== c.colSpan) struct = true;
        if (listChanged) si.deep = true;
        return { cell, tmpl, row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, width: c.width, height: c.height, borderFillId: c.bf ?? (tmpl ? tmpl.borderFillId : 0), paras, listChanged };
      });
      si.structChanged = struct;
      if (struct) si.deep = true;
    } else if (it.paras) {
      si.paras = makeParas(it.paras);
      if (copy || !sameList(si.paras, ctrl.paras)) si.deep = true;
    }
    if (it.capParas && ctrl.caption) {
      si.capParas = makeParas(it.capParas);
      if (copy || !sameList(si.capParas, ctrl.caption.paras)) si.deep = true;
    }
    return si;
  }

  const sections = [];
  for (const s of ex.extractDoc()) {
    const section = doc.sections[s.index] || null;
    const paras = makeParas(s.paras);
    if (!paras.length) paras.push({ src: null, own: true, deep: true, paraShapeId: 0, styleId: 0, pageBreak: false, cs0: 0, items: [] });
    const pageDirty = !!s.page && (!section || JSON.stringify(s.page) !== JSON.stringify(section.page));
    sections.push({ section, paras, page: s.page || (section ? section.page : null), pageDirty, clean: !!section && !pageDirty && sameList(paras, section.paras) });
  }
  return { sections };
}

/** 저장 모델의 순수 텍스트 (미리 보기 텍스트 등) */
export function saveModelText(model, limit = 4000) {
  const lines = [];
  let total = 0;
  const visit = (paras) => {
    for (const p of paras) {
      if (total > limit) return;
      let line = '';
      for (const it of p.items) {
        if (it.t === 'text') line += it.text;
        else if (it.t === 'tab') line += '\t';
        else if (it.t === 'br') line += '\n';
      }
      lines.push(line);
      total += line.length + 2;
      for (const it of p.items) {
        if (it.t !== 'ctrl') continue;
        if (it.cells) for (const c of it.cells) visit(c.paras);
        if (it.paras && it.ctrl.kind === 'textbox') visit(it.paras);
      }
    }
  };
  for (const s of model.sections) visit(s.paras);
  return lines.join('\r\n');
}
