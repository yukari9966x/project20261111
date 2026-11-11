// 편집기 본체: 렌더링, 입력 처리, 서식/표/그림 명령, 실행 취소

import { Renderer, buildShapeCss, charShapeCss, paraShapeCss, borderFillCss } from './render.js';
import { buildBaseline, buildSaveModel, csOf, psOf, tableGrid } from './extract.js';
import { History } from './history.js';
import { solidBorderSpec, sniffImage } from '../lib/model.js';

const PX_PER_PT = 96 / 72;
const TYPING_TYPES = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'insertFromComposition']);
const FORBIDDEN_INLINE = new Set(['B', 'I', 'U', 'S', 'STRIKE', 'FONT', 'A', 'EM', 'STRONG', 'SMALL', 'BIG', 'CODE', 'MARK']);

export class Editor {
  constructor({ root, styleEl, scroller, onChange, onSelection, notify }) {
    this.root = root;
    this.styleEl = styleEl;
    this.scroller = scroller;
    this.onChange = onChange || (() => {});
    this.onSelection = onSelection || (() => {});
    this.notify = notify || (() => {});
    this.doc = null;
    this.reg = null;
    this.baseline = null;
    this.newImages = new Map();
    this.binUrls = new Map();
    this.imgCounter = 0;
    this.composing = false;
    this.session = Math.random().toString(36).slice(2);
    this.history = new History(root);
    this.ruleSeen = new Set();
    this.bind();
  }

  // ------------------------------------------------------------------ 불러오기

  load(doc) {
    for (const url of this.binUrls.values()) URL.revokeObjectURL(url);
    this.binUrls.clear();
    for (const img of this.newImages.values()) URL.revokeObjectURL(img.url);
    this.newImages.clear();
    this.doc = doc;
    this.reg = { paras: new Map(), ctrls: new Map(), tabs: [] };
    this.styleEl.textContent = buildShapeCss(doc);
    this.ruleSeen = new Set();
    for (const s of doc.charShapes) this.ruleSeen.add(`c${s.id}`);
    for (const s of doc.paraShapes) this.ruleSeen.add(`p${s.id}`);
    for (const s of doc.borderFills) this.ruleSeen.add(`b${s.id}`);
    this.root.innerHTML = new Renderer(doc, this.reg).renderDoc();
    this.baseline = buildBaseline(this.root, this.reg);
    this.history.reset();
    this.loadImages();
    this.caretToStart();
  }

  caretToStart() {
    const first = this.root.querySelector('.body .para');
    if (!first) return;
    const sel = document.getSelection();
    const r = document.createRange();
    r.setStart(first, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  async loadImages() {
    const doc = this.doc;
    const ids = new Set();
    for (const img of this.root.querySelectorAll('img[data-bin]')) ids.add(img.dataset.bin);
    for (const id of ids) {
      const bin = doc.bin.get(id) || doc.bin.get(Number(id));
      if (!bin) continue;
      try {
        const bytes = await bin.getBytes();
        if (this.doc !== doc) return;
        const info = sniffImage(bytes);
        const mime = info ? info.mime : bin.mime;
        if (!/^image\/(png|jpeg|gif|bmp|svg\+xml|webp)$/.test(mime)) continue;
        this.binUrls.set(String(id), URL.createObjectURL(new Blob([bytes], { type: mime })));
      } catch { /* 그림을 읽지 못하면 빈 자리로 둔다 */ }
    }
    if (this.doc === doc) this.fixImages();
  }

  /** src 가 비어 있는 그림에 주소를 채운다 (처음 불러올 때, 실행 취소 뒤). */
  fixImages() {
    for (const img of this.root.querySelectorAll('img.pic')) {
      let url = null;
      if (img.dataset.bin !== undefined) url = this.binUrls.get(img.dataset.bin);
      else if (img.dataset.newimg !== undefined) { const n = this.newImages.get(img.dataset.newimg); url = n ? n.url : null; }
      if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
    }
  }

  get dirty() { return this.history.dirty; }
  markSaved() { this.history.markSaved(); }

  getSaveModel() {
    return buildSaveModel(this.doc, this.root, this.reg, this.baseline, this.newImages);
  }

  // ------------------------------------------------------------------ 스타일 규칙

  ensureRule(key, css) {
    if (this.ruleSeen.has(key)) return;
    this.ruleSeen.add(key);
    this.styleEl.appendChild(document.createTextNode(`\n.${key}{${css}}`));
  }
  ensureCs(id) { this.ensureRule(`c${id}`, charShapeCss(this.doc.charShape(id))); }
  ensurePs(id) { this.ensureRule(`p${id}`, paraShapeCss(this.doc.paraShape(id))); }
  ensureBf(id) { const bf = this.doc.borderFill(id); if (bf) this.ensureRule(`b${id}`, borderFillCss(bf)); }

  // ------------------------------------------------------------------ 선택 영역 도우미

  /** 편집 영역에 포커스를 돌려주고, 선택이 풀렸으면 마지막 선택을 되살린다. */
  focus() {
    if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
    if (!this.getRange() && this.lastRange && this.root.contains(this.lastRange.commonAncestorContainer)) {
      try { this.setRange(this.lastRange); } catch { /* 무시 */ }
    }
    if (!this.getRange()) this.caretToStart();
  }

  getRange() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return this.root.contains(r.commonAncestorContainer) ? r : null;
  }

  /**
   * 문단 밖(구역 여백, 구역 사이 등)에 놓인 위치를 가장 가까운 문단 안의 위치로 바꾼다.
   * 이미 문단 안이면 null. isEnd 는 범위의 끝점인지 여부.
   */
  snap(node, offset, isEnd) {
    if (this.closestPara(node)) return null;
    const el = this.closestEl(node);
    if (!el || !this.root.contains(el)) return null;
    const startOf = (p) => [p, 0];
    const endOf = (p) => [p, p.childNodes.length];
    const pick = (plist, toEnd) => {
      const ps = plist.querySelectorAll(':scope > .para');
      if (!ps.length) return null;
      return toEnd ? endOf(ps[ps.length - 1]) : startOf(ps[0]);
    };
    const plist = el.closest('.plist');
    if (plist) {
      if (node === plist) {
        const kids = Array.from(plist.childNodes);
        if (!isEnd) { for (let i = offset; i < kids.length; i++) if (kids[i].nodeType === 1 && kids[i].classList.contains('para')) return startOf(kids[i]); return pick(plist, true); }
        for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) if (kids[i].nodeType === 1 && kids[i].classList.contains('para')) return endOf(kids[i]);
        return pick(plist, false);
      }
      return pick(plist, isEnd);
    }
    let sec = el.closest('.sec');
    let toEnd = isEnd;
    if (!sec) {
      const secs = Array.from(this.root.querySelectorAll(':scope > .sec'));
      if (!secs.length) return null;
      if (node === this.root) {
        if (isEnd) { sec = secs[Math.max(0, Math.min(offset, secs.length) - 1)]; toEnd = offset > 0; }
        else { sec = secs[Math.min(offset, secs.length - 1)]; toEnd = offset >= secs.length; }
      } else sec = isEnd ? secs[secs.length - 1] : secs[0];
    } else if (node === sec) {
      const body = sec.querySelector(':scope > .body');
      toEnd = offset > Array.prototype.indexOf.call(sec.childNodes, body);
    } else toEnd = !!el.closest('.notes, .hfa-bottom');
    const body = sec.querySelector(':scope > .body');
    return body ? pick(body, toEnd) : null;
  }

  /**
   * 문단 밖으로 나간 캐럿이 갈 자리. 머리말/꼬리말/주석 안에서 움직이다가 밖으로 튕겨 나온
   * 캐럿은 그 영역 안(나간 방향의 끝)에 붙잡아 둔다.
   */
  snapCaret(node, offset) {
    const p = this.snap(node, offset, false);
    if (!p) return null;
    const island = this.lastIsland;
    if (island && island.isConnected && this.root.contains(island)) {
      const ps = island.querySelectorAll(':scope > .para');
      if (ps.length) {
        let after = false;
        try { const isl = document.createRange(); isl.selectNode(island); after = isl.comparePoint(node, offset) > 0; } catch { after = false; }
        const last = ps[ps.length - 1];
        return after ? [last, last.childNodes.length] : [ps[0], 0];
      }
    }
    return p;
  }

  /** 끝점이 문단 밖에 있는 범위를 문단 안으로 맞춘 새 범위를 돌려준다 (바꿀 것이 없으면 원래 범위). */
  clampRange(range) {
    if (!range) return null;
    const a = range.collapsed ? this.snapCaret(range.startContainer, range.startOffset) : this.snap(range.startContainer, range.startOffset, false);
    const b = range.collapsed ? null : this.snap(range.endContainer, range.endOffset, true);
    if (!a && !b) return range;
    const nr = document.createRange();
    try {
      if (a) nr.setStart(a[0], a[1]); else nr.setStart(range.startContainer, range.startOffset);
      if (range.collapsed) nr.collapse(true);
      else if (b) nr.setEnd(b[0], b[1]);
      else nr.setEnd(range.endContainer, range.endOffset);
    } catch { return range; }
    return nr;
  }

  /** 명령을 실행할 범위: 현재 선택을 문단 안으로 맞춰서 돌려준다. */
  commandRange() {
    const r = this.getRange();
    if (!r) return null;
    const nr = this.clampRange(r);
    if (nr !== r) this.setRange(nr);
    return nr;
  }

  /** 구역/문서 바로 아래에 잘못 들어간 내용을 본문 문단으로 옮긴다. */
  sweepStrays() {
    let changed = false;
    const secs = Array.from(this.root.querySelectorAll(':scope > .sec'));
    const lastBody = secs.length ? secs[secs.length - 1].querySelector(':scope > .body') : null;
    const adopt = (node, body) => {
      if (!body) { node.remove(); return; }
      if (node.nodeType === 3 && !node.nodeValue.replace(/\u200b/g, '').trim()) { node.remove(); return; }
      body.appendChild(node);
      changed = true;
    };
    for (const n of Array.from(this.root.childNodes)) {
      if (n.nodeType === 1 && n.classList.contains('sec')) continue;
      adopt(n, lastBody);
    }
    for (const sec of secs) {
      const body = sec.querySelector(':scope > .body');
      for (const n of Array.from(sec.childNodes)) {
        if (n.nodeType === 1 && (n.classList.contains('body') || n.classList.contains('hfa') || n.classList.contains('notes'))) continue;
        adopt(n, body);
      }
      if (changed && body) this.normalizePlist(body);
    }
    return changed;
  }

  setRange(r) {
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  setCaret(node, offset) {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    this.setRange(r);
  }
  closestEl(node) { return node && node.nodeType === 1 ? node : node ? node.parentElement : null; }
  closestPara(node) { const el = this.closestEl(node); return el ? el.closest('.para') : null; }
  closestPlist(node) { const el = this.closestEl(node); return el ? el.closest('.plist') : null; }
  closestCell(node) { const el = this.closestEl(node); return el ? el.closest('td.plist') : null; }

  /** 노드 위치의 글자 모양 id */
  csAt(node) {
    let el = this.closestEl(node);
    while (el && el !== this.root) {
      const cs = csOf(el);
      if (cs !== null) return cs;
      if (el.classList.contains('para')) break;
      el = el.parentElement;
    }
    const para = this.closestPara(node);
    if (para) {
      const span = para.querySelector('span');
      const cs = span ? csOf(span) : null;
      if (cs !== null) return cs;
      const src = this.reg.paras.get(Number(para.dataset.pid));
      if (src) return src.cs0 ?? 0;
    }
    return this.doc.charShapes[0] ? this.doc.charShapes[0].id : 0;
  }

  currentCharShape() {
    const r = this.getRange();
    if (!r) return null;
    let node = r.startContainer;
    if (!r.collapsed && node.nodeType === 3 && r.startOffset >= node.nodeValue.length) {
      // 선택이 글자 경계에서 시작하면 다음 글자의 모양을 본다
      const next = this.nextTextNode(node, r.endContainer);
      if (next) node = next;
    } else if (node.nodeType === 1 && node.childNodes[r.startOffset]) node = node.childNodes[r.startOffset];
    return this.doc.charShape(this.csAt(node));
  }
  nextTextNode(node, limit) {
    const w = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    w.currentNode = node;
    const n = w.nextNode();
    if (!n) return null;
    if (limit && limit !== n && !(limit.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) && !limit.contains(n)) return null;
    return n;
  }
  currentParaShape() {
    const r = this.getRange();
    if (!r) return null;
    const para = this.closestPara(r.startContainer);
    if (!para) return null;
    return this.doc.paraShape(psOf(para) ?? 0);
  }

  parasInRange(range) {
    const sp = this.closestPara(range.startContainer);
    const ep = this.closestPara(range.endContainer);
    if (range.collapsed || sp === ep) return sp ? [sp] : [];
    const ca = this.closestEl(range.commonAncestorContainer);
    const out = [];
    for (const p of ca.querySelectorAll('.para')) if (range.intersectsNode(p)) out.push(p);
    if (!out.length && sp) out.push(sp);
    return out;
  }

  /** 범위 안의 편집 가능한 텍스트 노드들 (경계에서 잘라 준다). */
  textNodesInRange(range) {
    const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
    const ca = this.closestEl(range.commonAncestorContainer);
    const nodes = [];
    const w = document.createTreeWalker(ca, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const pe = n.parentElement;
      if (!pe || !pe.closest('.para') || pe.closest('[contenteditable="false"]')) continue;
      nodes.push(n);
    }
    const out = [];
    for (const n of nodes) {
      let node = n;
      let start = 0;
      let end = n.nodeValue.length;
      if (n === sc) start = Math.min(so, end);
      if (n === ec) end = Math.min(eo, end);
      if (end <= start) continue;
      if (end < node.nodeValue.length) node.splitText(end);
      if (start > 0) node = node.splitText(start);
      out.push(node);
    }
    return out;
  }

  // ------------------------------------------------------------------ 이벤트

  bind() {
    const root = this.root;
    try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch { /* 무시 */ }
    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('compositionstart', () => {
      this.composing = true;
      const r = this.getRange();
      if (r && !r.collapsed && this.closestPlist(r.startContainer) !== this.closestPlist(r.endContainer)) { r.collapse(false); this.setRange(r); }
    });
    root.addEventListener('compositionend', () => {
      this.composing = false;
      this.afterEdit('typing');
    });
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));
    root.addEventListener('dragstart', (e) => e.preventDefault());
    root.addEventListener('drop', (e) => e.preventDefault());
    root.addEventListener('mousedown', (e) => {
      // 어느 편집 영역(본문 / 머리말·꼬리말·주석)을 눌렀는지 바로 기억해 둔다.
      this.lastIsland = e.target instanceof Element ? e.target.closest('.hf, .note') : null;
      for (const el of root.querySelectorAll('img.pic.sel')) el.classList.remove('sel');
      if (e.target instanceof HTMLImageElement && e.target.classList.contains('pic')) {
        e.target.classList.add('sel');
        const r = document.createRange();
        r.selectNode(e.target);
        this.setRange(r);
        e.preventDefault();
        root.focus();
      }
      this.history.breakRun();
    });
    document.addEventListener('selectionchange', () => {
      let r = this.getRange();
      if (!r) return;
      if (r.collapsed && !this.composing) {
        const p = this.snapCaret(r.startContainer, r.startOffset);
        if (p) {
          this.setCaret(p[0], p[1]);
          r = this.getRange();
          if (!r) return;
        }
      }
      const host = this.closestEl(r.startContainer);
      this.lastIsland = host ? host.closest('.hf, .note') : null;
      this.lastRange = r.cloneRange();
      this.onSelection();
    });
  }

  onBeforeInput(e) {
    const t = e.inputType;
    if (t === 'historyUndo') { e.preventDefault(); this.undo(); return; }
    if (t === 'historyRedo') { e.preventDefault(); this.redo(); return; }
    if (t.startsWith('format')) {
      e.preventDefault();
      if (t === 'formatBold') this.toggle('bold');
      else if (t === 'formatItalic') this.toggle('italic');
      else if (t === 'formatUnderline') this.toggle('underline');
      else if (t === 'formatStrikeThrough') this.toggle('strike');
      return;
    }
    if (t === 'insertFromDrop' || t === 'deleteByDrag' || t === 'insertFromPaste' || t === 'insertFromYank') { e.preventDefault(); return; }
    const range = this.commandRange();
    if (!range) return;
    if (!range.collapsed) {
      if (this.closestPlist(range.startContainer) !== this.closestPlist(range.endContainer)) {
        if (!e.cancelable) return;
        e.preventDefault();
        this.deleteAcross(range);
        if (t === 'insertText' && e.data) document.execCommand('insertText', false, e.data);
        else if (t === 'insertParagraph') document.execCommand('insertParagraph');
        this.afterEdit('cmd');
      }
      return;
    }
    if (/^delete.*Backward$/.test(t) && this.atPlistEdge(range, true)) { e.preventDefault(); return; }
    if (/^delete.*Forward$/.test(t) && this.atPlistEdge(range, false)) { e.preventDefault(); }
  }

  /** 캐럿이 문단 목록의 맨 처음(backward) 또는 맨 끝에 있는가 */
  atPlistEdge(range, backward) {
    const para = this.closestPara(range.startContainer);
    if (!para) return false;
    const plist = para.parentElement;
    if (!plist || !plist.classList.contains('plist')) return false;
    const sib = backward ? para.previousElementSibling : para.nextElementSibling;
    if (sib && sib.classList.contains('para')) return false;
    const r = document.createRange();
    if (backward) { r.setStart(para, 0); r.setEnd(range.startContainer, range.startOffset); }
    else { r.setStart(range.startContainer, range.startOffset); r.setEnd(para, para.childNodes.length); }
    if (r.toString().replace(/​/g, '')) return false;
    const frag = r.cloneContents();
    if (frag.querySelector('[data-cid], img, table')) return false;
    if (!backward && frag.querySelectorAll('br').length > 1) return false;
    if (backward && frag.querySelector('br')) return false;
    return true;
  }

  onInput(e) {
    if (this.composing || e.isComposing) return;
    if (e.inputType === 'insertParagraph') {
      const r = this.getRange();
      const para = r ? this.closestPara(r.startContainer) : null;
      if (para && para.dataset.pb) delete para.dataset.pb;
    }
    this.afterEdit(TYPING_TYPES.has(e.inputType) ? 'typing' : 'cmd');
  }

  afterEdit(kind) {
    if (this.root.querySelector(':scope > :not(.sec)') || Array.from(this.root.querySelectorAll(':scope > .sec')).some((sec) => sec.childNodes.length !== 4)) this.sweepStrays();
    this.normalizeAtCaret();
    this.history.record(kind);
    this.onChange();
  }

  /** 명령 실행 뒤 호출 */
  commit() {
    this.history.breakRun();
    this.history.record('cmd');
    this.onChange();
    this.onSelection();
  }

  onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const r = this.getRange();
      const cell = r ? this.closestCell(r.startContainer) : null;
      if (cell) this.moveCell(cell, e.shiftKey ? -1 : 1);
      else if (!e.shiftKey) document.execCommand('insertText', false, '\t');
      return;
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.insertPageBreak(); return; }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (k === 'y') { e.preventDefault(); this.redo(); }
      else if (k === 'b') { e.preventDefault(); this.toggle('bold'); }
      else if (k === 'i') { e.preventDefault(); this.toggle('italic'); }
      else if (k === 'u') { e.preventDefault(); this.toggle('underline'); }
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) this.history.breakRun();
  }

  moveCell(cell, dir) {
    const table = cell.closest('table');
    const cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td'));
    const i = cells.indexOf(cell) + dir;
    if (i < 0 || i >= cells.length) return;
    const target = cells[i];
    const r = document.createRange();
    r.selectNodeContents(target);
    const lastPara = target.querySelector(':scope > .para:last-child');
    if (lastPara && lastPara.querySelector('br') && !target.textContent.replace(/​/g, '')) r.collapse(true);
    this.setRange(r);
  }

  // ------------------------------------------------------------------ 정리(정규화)

  normalizeAtCaret() {
    const r = this.getRange();
    if (!r) return;
    const saved = { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
    let plist = this.closestPlist(r.startContainer);
    if (!plist) {
      // 캐럿이 구역 바깥으로 나간 경우
      const sec = this.closestEl(r.startContainer).closest('.sec') || this.root.querySelector('.sec');
      plist = sec ? sec.querySelector('.body') : null;
    }
    if (!plist) return;
    let changed = this.normalizePlist(plist);
    const para = this.closestPara(saved.sc);
    for (const p of [para, para && para.previousElementSibling, para && para.nextElementSibling]) {
      if (p && p.classList.contains('para')) changed = this.normalizePara(p) || changed;
    }
    // 빈 구역 본문 방지
    for (const body of this.root.querySelectorAll('.sec > .body')) {
      if (!body.querySelector(':scope > .para')) { this.normalizePlist(body); changed = true; }
    }
    if (changed) {
      try {
        if (saved.sc.isConnected && saved.ec.isConnected) {
          const nr = document.createRange();
          nr.setStart(saved.sc, Math.min(saved.so, saved.sc.nodeType === 3 ? saved.sc.nodeValue.length : saved.sc.childNodes.length));
          nr.setEnd(saved.ec, Math.min(saved.eo, saved.ec.nodeType === 3 ? saved.ec.nodeValue.length : saved.ec.childNodes.length));
          this.setRange(nr);
        }
      } catch { /* 무시 */ }
    }
  }

  defaultClassesNear(node) {
    // 가까운 문단의 문단/글자 모양을 빌린다.
    let ref = node;
    let para = null;
    while (ref && !para) {
      if (ref.nodeType === 1 && ref.classList.contains('para')) para = ref;
      ref = ref.previousSibling;
    }
    ref = node;
    while (ref && !para) {
      if (ref.nodeType === 1 && ref.classList.contains('para')) para = ref;
      ref = ref.nextSibling;
    }
    let ps = para ? psOf(para) : null;
    let cs = null;
    let st = para ? para.dataset.st : null;
    if (para) {
      const span = para.querySelector('span');
      cs = span ? csOf(span) : null;
    }
    if (ps === null) ps = this.doc.paraShapes[0] ? this.doc.paraShapes[0].id : 0;
    if (cs === null) cs = this.doc.charShapes[0] ? this.doc.charShapes[0].id : 0;
    return { ps, cs, st: st ?? '0' };
  }

  makeEmptyPara(ps, cs, st = '0') {
    const p = document.createElement('div');
    p.className = `para p${ps}`;
    p.dataset.st = st;
    const s = document.createElement('span');
    s.className = `c${cs}`;
    s.appendChild(document.createElement('br'));
    p.appendChild(s);
    return p;
  }

  normalizePlist(plist) {
    let changed = false;
    let run = null;
    const kids = Array.from(plist.childNodes);
    const isSpecial = (n) => n.nodeType === 1 && (n.classList.contains('cap') || n.tagName === 'COLGROUP');
    for (const n of kids) {
      if (n.nodeType === 1 && n.classList.contains('para')) { run = null; continue; }
      if (isSpecial(n)) { run = null; continue; }
      if (n.nodeType === 3 && !n.nodeValue.replace(/​/g, '')) { continue; }
      changed = true;
      if (n.nodeType === 1 && n.tagName === 'DIV') {
        const d = this.defaultClassesNear(n);
        n.className = `para p${psOf(n) ?? d.ps}`;
        if (n.dataset.st === undefined) n.dataset.st = d.st;
        run = null;
        this.normalizePara(n);
        continue;
      }
      if (!run) {
        const d = this.defaultClassesNear(n);
        run = document.createElement('div');
        run.className = `para p${d.ps}`;
        run.dataset.st = d.st;
        plist.insertBefore(run, n);
      }
      run.appendChild(n);
      this.normalizePara(run);
    }
    if (!plist.querySelector(':scope > .para')) {
      const d = this.defaultClassesNear(plist);
      plist.appendChild(this.makeEmptyPara(d.ps, d.cs, d.st));
      changed = true;
    }
    return changed;
  }

  normalizePara(para) {
    let changed = false;
    // 브라우저가 끼워 넣은 꾸밈 요소/인라인 스타일 제거
    for (const el of Array.from(para.querySelectorAll('span[style], span:not([class]), font, b, i, u, s, strike, a, em, strong'))) {
      if (el.closest('.para') !== para || el.closest('[contenteditable="false"]')) continue;
      if (el.tagName === 'SPAN') {
        if (el.classList.contains('tbox') || el.classList.contains('cap')) continue;
        if (el.hasAttribute('style')) { el.removeAttribute('style'); changed = true; }
        if (csOf(el) === null && !el.classList.length) { el.replaceWith(...Array.from(el.childNodes)); changed = true; }
      } else if (FORBIDDEN_INLINE.has(el.tagName)) {
        el.replaceWith(...Array.from(el.childNodes));
        changed = true;
      }
    }
    // 문단 바로 아래의 텍스트는 글자 모양 span 으로 감싼다.
    for (const n of Array.from(para.childNodes)) {
      if (n.nodeType !== 3) continue;
      if (!n.nodeValue) { n.remove(); continue; }
      const prev = n.previousSibling, next = n.nextSibling;
      let cs = prev && prev.nodeType === 1 ? csOf(prev) : null;
      if (cs === null && next && next.nodeType === 1) cs = csOf(next);
      if (cs === null) cs = this.csAt(para);
      const span = document.createElement('span');
      span.className = `c${cs}`;
      para.insertBefore(span, n);
      span.appendChild(n);
      changed = true;
    }
    // 내용이 전혀 없으면 채움용 <br>
    if (!para.firstChild || (!para.textContent && !para.querySelector('br, img, table, [data-cid]'))) {
      const d = this.defaultClassesNear(para);
      const cs = (() => { const s = para.querySelector('span'); const c = s ? csOf(s) : null; return c ?? d.cs; })();
      para.textContent = '';
      const s = document.createElement('span');
      s.className = `c${cs}`;
      s.appendChild(document.createElement('br'));
      para.appendChild(s);
      changed = true;
    }
    return changed;
  }

  // ------------------------------------------------------------------ 여러 영역에 걸친 지우기

  plistChain(node) {
    const chain = [];
    let p = this.closestPlist(node);
    while (p) { chain.unshift(p); p = p.parentElement ? p.parentElement.closest('.plist') : null; }
    return chain;
  }

  /** 서로 다른 문단 목록(셀·구역 등)에 걸친 선택을 구조를 지키면서 지운다. */
  deleteAcross(range) {
    const ca = this.plistChain(range.startContainer);
    const cb = this.plistChain(range.endContainer);
    let common = null;
    for (let i = 0; i < Math.min(ca.length, cb.length) && ca[i] === cb[i]; i++) common = ca[i];
    const sel = document.getSelection();
    if (common) {
      const objIn = (node) => {
        let el = this.closestEl(node);
        let found = null;
        while (el && el !== common) {
          if ((el.tagName === 'TABLE' || el.classList.contains('tbox')) && this.closestPlist(el.parentNode) === common) found = el;
          el = el.parentElement;
        }
        return found;
      };
      const xa = objIn(range.startContainer);
      const xb = objIn(range.endContainer);
      if (xa && xa === xb) {
        if (xa.tagName === 'TABLE') this.clearCells(xa, range);
        else { range.collapse(true); this.setRange(range); }
        return;
      }
      const nr = document.createRange();
      if (xa) nr.setStartBefore(xa); else nr.setStart(range.startContainer, range.startOffset);
      if (xb) nr.setEndAfter(xb); else nr.setEnd(range.endContainer, range.endOffset);
      sel.removeAllRanges();
      sel.addRange(nr);
      document.execCommand('delete');
      return;
    }
    // 공통 목록이 없다: 구역 본문 사이의 선택만 처리한다.
    const la = ca[0], lb = cb[0];
    if (!la || !lb || !la.classList.contains('body') || !lb.classList.contains('body')) {
      range.collapse(true); this.setRange(range);
      return;
    }
    const bodies = Array.from(this.root.querySelectorAll('.sec > .body'));
    const ia = bodies.indexOf(la), ib = bodies.indexOf(lb);
    const startNode = range.startContainer, startOffset = range.startOffset;
    const endNode = range.endContainer, endOffset = range.endOffset;
    // 뒤쪽부터 지운다.
    const tail = document.createRange();
    tail.setStart(lb, 0); tail.setEnd(endNode, endOffset);
    this.nativeDelete(tail);
    for (let i = ib - 1; i > ia; i--) {
      const d = this.defaultClassesNear(bodies[i].firstChild || bodies[i]);
      bodies[i].textContent = '';
      bodies[i].appendChild(this.makeEmptyPara(d.ps, d.cs, d.st));
    }
    const head = document.createRange();
    head.setStart(startNode, startOffset); head.setEnd(la, la.childNodes.length);
    this.nativeDelete(head);
    for (const b of bodies) this.normalizePlist(b);
  }

  nativeDelete(range) {
    if (range.collapsed) return;
    this.setRange(range);
    document.execCommand('delete');
    const r = this.getRange();
    const plist = r ? this.closestPlist(r.startContainer) : null;
    if (plist) this.normalizePlist(plist);
  }

  clearCells(table, range) {
    const cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td'));
    const cellOf = (node) => { let el = this.closestEl(node); while (el && !(el.tagName === 'TD' && el.parentElement.parentElement.parentElement === table)) el = el.parentElement; return el; };
    const a = cellOf(range.startContainer), b = cellOf(range.endContainer);
    const ia = cells.indexOf(a), ib = cells.indexOf(b);
    if (ia < 0 || ib < 0) return;
    for (let i = ia; i <= ib; i++) {
      const td = cells[i];
      const d = this.defaultClassesNear(td.firstChild || td);
      td.textContent = '';
      td.appendChild(this.makeEmptyPara(d.ps, d.cs, d.st));
    }
    const first = cells[ia].querySelector('.para span') || cells[ia];
    this.setCaret(first, 0);
  }

  // ------------------------------------------------------------------ 글자 서식

  toggle(prop) {
    const cur = this.currentCharShape();
    if (!cur) return;
    if (prop === 'underline') this.applyCharFormat({ underline: cur.underline === 'none' ? 'bottom' : 'none' });
    else if (prop === 'sup') this.applyCharFormat({ sup: !cur.sup, sub: false });
    else if (prop === 'sub') this.applyCharFormat({ sub: !cur.sub, sup: false });
    else this.applyCharFormat({ [prop]: !cur[prop] });
  }

  applyCharFormat(changes) {
    const range = this.commandRange();
    if (!range) return;
    if (range.collapsed) { this.setPendingFormat(changes); this.onSelection(); return; }
    const nodes = this.textNodesInRange(range);
    for (const tn of nodes) {
      let span = tn.parentElement;
      const para = span.closest('.para');
      if (!para) continue;
      let cs = csOf(span);
      if (cs === null || span === para || span.classList.contains('para')) {
        cs = this.csAt(tn);
        const ns = document.createElement('span');
        ns.className = `c${cs}`;
        tn.parentNode.insertBefore(ns, tn);
        ns.appendChild(tn);
        span = ns;
      } else if (span.childNodes.length > 1) {
        span = this.isolate(tn, span);
      }
      const ncs = this.doc.deriveCharShape(cs, changes);
      this.ensureCs(ncs);
      span.className = span.className.replace(/(^|\s)c\d+(?=\s|$)/, `$1c${ncs}`);
    }
    // 범위 안의 번호/주석 표시도 같은 모양으로
    const ca = this.closestEl(range.commonAncestorContainer);
    for (const el of ca.querySelectorAll('.num, .fnref')) {
      if (!range.intersectsNode(el)) continue;
      const cs = csOf(el);
      if (cs === null) continue;
      const ncs = this.doc.deriveCharShape(cs, changes);
      this.ensureCs(ncs);
      el.className = el.className.replace(/(^|\s)c\d+(?=\s|$)/, `$1c${ncs}`);
    }
    if (nodes.length) {
      const nr = document.createRange();
      nr.setStart(nodes[0], 0);
      const last = nodes[nodes.length - 1];
      nr.setEnd(last, last.nodeValue.length);
      this.setRange(nr);
    }
    this.commit();
  }

  /** span 안에서 텍스트 노드 하나만 남도록 span 을 쪼갠다. */
  isolate(tn, span) {
    const before = [];
    const after = [];
    let seen = false;
    for (const n of Array.from(span.childNodes)) {
      if (n === tn) { seen = true; continue; }
      (seen ? after : before).push(n);
    }
    if (before.length) {
      const b = span.cloneNode(false);
      delete b.dataset.tab;
      span.parentNode.insertBefore(b, span);
      for (const n of before) b.appendChild(n);
    }
    if (after.length) {
      const a = span.cloneNode(false);
      delete a.dataset.tab;
      span.parentNode.insertBefore(a, span.nextSibling);
      for (const n of after) a.appendChild(n);
    }
    return span;
  }

  /** 캐럿 위치에 인라인 노드를 넣는다 (글자 모양 span 을 쪼갠다). */
  insertInlineAtCaret(node) {
    const range = this.commandRange();
    if (!range) return false;
    if (!range.collapsed) { document.execCommand('delete'); return this.insertInlineAtCaret(node); }
    let container = range.startContainer;
    const offset = range.startOffset;
    const para = this.closestPara(container);
    if (!para) return false;
    if (container.nodeType === 3) {
      const span = container.parentElement;
      if (csOf(span) !== null && span !== para) {
        const tail = container.splitText(offset);
        const clone = span.cloneNode(false);
        delete clone.dataset.tab;
        let n = tail;
        while (n) { const next = n.nextSibling; clone.appendChild(n); n = next; }
        span.parentNode.insertBefore(node, span.nextSibling);
        if (clone.textContent || clone.querySelector('br')) node.parentNode.insertBefore(clone, node.nextSibling);
        if (!span.textContent && !span.querySelector('br')) span.remove();
        return true;
      }
      range.insertNode(node);
      return true;
    }
    if (container.nodeType === 1 && container !== para && csOf(container) !== null) {
      if (offset === 0) container.parentNode.insertBefore(node, container);
      else container.parentNode.insertBefore(node, container.nextSibling);
      return true;
    }
    range.insertNode(node);
    return true;
  }

  setPendingFormat(changes) {
    const range = this.getRange();
    if (!range) return;
    const cs = this.csAt(range.startContainer);
    const ncs = this.doc.deriveCharShape(cs, changes);
    if (ncs === cs) return;
    this.ensureCs(ncs);
    const span = document.createElement('span');
    span.className = `c${ncs}`;
    span.textContent = '​';
    if (!this.insertInlineAtCaret(span)) return;
    this.setCaret(span.firstChild, 1);
  }

  // ------------------------------------------------------------------ 문단 서식

  applyParaFormat(changes) {
    const range = this.commandRange();
    if (!range) return;
    for (const para of this.parasInRange(range)) {
      const ps = psOf(para) ?? 0;
      const nps = this.doc.deriveParaShape(ps, changes);
      this.ensurePs(nps);
      para.className = para.className.replace(/(^|\s)p\d+(?=\s|$)/, `$1p${nps}`);
      if (psOf(para) === null) para.classList.add(`p${nps}`);
    }
    this.commit();
  }

  insertPageBreak() {
    const range = this.commandRange();
    if (!range) return;
    const plist = this.closestPlist(range.startContainer);
    if (!plist || !plist.classList.contains('body')) { this.notify('쪽 나누기는 본문에서만 넣을 수 있습니다.'); return; }
    document.execCommand('insertParagraph');
    const r = this.getRange();
    const para = r ? this.closestPara(r.startContainer) : null;
    if (para) para.dataset.pb = '1';
    this.normalizeAtCaret();
    this.commit();
  }

  // ------------------------------------------------------------------ 표

  currentTableCell() {
    const r = this.getRange();
    if (!r) return null;
    const td = this.closestCell(r.startContainer);
    if (!td) return null;
    return { td, table: td.closest('table') };
  }

  makeCellLike(ref, height) {
    const td = document.createElement('td');
    td.className = ref.className.replace(/\s*csel\s*/, ' ').trim();
    td.style.cssText = ref.style.cssText;
    td.dataset.w = ref.dataset.w || '0';
    td.dataset.h = height ?? ref.dataset.h ?? '0';
    const refPara = ref.querySelector('.para');
    const refSpan = refPara ? refPara.querySelector('span') : null;
    const ps = refPara ? psOf(refPara) ?? 0 : 0;
    const cs = refSpan ? csOf(refSpan) ?? this.csAt(ref) : this.csAt(ref);
    td.appendChild(this.makeEmptyPara(ps, cs, refPara ? refPara.dataset.st || '0' : '0'));
    return td;
  }

  refreshTable(table) {
    const grid = tableGrid(table);
    table.dataset.rows = String(grid.rows);
    table.dataset.cols = String(grid.cols);
    const cols = Array.from(table.querySelectorAll(':scope > colgroup > col'));
    const widths = cols.map((c) => parseFloat(c.style.width) || 0);
    let total = 0;
    for (const w of widths) total += w;
    table.style.width = `${Math.round(total * 100) / 100}pt`;
    for (const c of grid.cells) {
      let w = 0;
      for (let i = c.c; i < c.c + c.cs; i++) w += widths[i] || 0;
      c.el.dataset.w = String(Math.round(w * 100) / 100);
    }
    return grid;
  }

  tableOp(op) {
    const cur = this.currentTableCell();
    if (!cur) { this.notify('표 안에 커서를 놓고 실행하세요.'); return; }
    const { td, table } = cur;
    const grid = tableGrid(table);
    const me = grid.cells.find((c) => c.el === td);
    if (!me) return;
    const tbody = table.tBodies[0];
    const colgroup = table.querySelector(':scope > colgroup');
    const colEls = colgroup ? Array.from(colgroup.children) : [];
    let focus = td;
    if (op === 'rowAbove' || op === 'rowBelow') {
      const after = op === 'rowBelow';
      const refRow = after ? me.r + me.rs - 1 : me.r;
      const tr = document.createElement('tr');
      tr.style.height = grid.trs[refRow] ? grid.trs[refRow].style.height : '';
      const done = new Set();
      for (let c = 0; c < grid.cols;) {
        const cell = grid.at(refRow, c);
        if (!cell) { c++; continue; }
        const across = after ? cell.r + cell.rs - 1 > refRow : cell.r < refRow;
        if (across) {
          if (!done.has(cell)) { cell.el.rowSpan = cell.rs + 1; done.add(cell); }
        } else {
          const n = this.makeCellLike(cell.el);
          if (cell.cs > 1) n.colSpan = cell.cs;
          tr.appendChild(n);
        }
        c = cell.c + cell.cs;
      }
      const refTr = grid.trs[refRow];
      tbody.insertBefore(tr, after ? refTr.nextSibling : refTr);
      focus = tr.cells[0] || td;
    } else if (op === 'deleteRow') {
      const r = me.r;
      if (grid.rows <= 1) return this.tableOp('deleteTable');
      const nextRowCells = grid.cells.filter((x) => x.r === r + 1).sort((a, b) => a.c - b.c);
      for (const cell of grid.cells) {
        if (cell.r > r || cell.r + cell.rs - 1 < r) continue;
        if (cell.r === r) {
          if (cell.rs > 1 && grid.trs[r + 1]) {
            cell.el.rowSpan = cell.rs - 1;
            const ref = nextRowCells.find((x) => x.c > cell.c);
            grid.trs[r + 1].insertBefore(cell.el, ref ? ref.el : null);
          } else cell.el.remove();
        } else cell.el.rowSpan = cell.rs - 1;
      }
      grid.trs[r].remove();
      const g2 = tableGrid(table);
      const t = g2.at(Math.min(r, g2.rows - 1), Math.min(me.c, g2.cols - 1));
      focus = t ? t.el : table.querySelector('td');
    } else if (op === 'colLeft' || op === 'colRight') {
      const after = op === 'colRight';
      const refCol = after ? me.c + me.cs - 1 : me.c;
      const done = new Set();
      let created = null;
      for (let r = 0; r < grid.rows; r++) {
        const cell = grid.at(r, refCol);
        if (!cell || done.has(cell)) continue;
        done.add(cell);
        const across = after ? cell.c + cell.cs - 1 > refCol : cell.c < refCol;
        if (across) cell.el.colSpan = cell.cs + 1;
        else {
          const n = this.makeCellLike(cell.el);
          if (cell.rs > 1) n.rowSpan = cell.rs;
          cell.el.parentNode.insertBefore(n, after ? cell.el.nextSibling : cell.el);
          if (cell === me) created = n;
          if (!created) created = n;
        }
      }
      if (colgroup) {
        const refEl = colEls[refCol];
        const col = document.createElement('col');
        col.style.width = refEl ? refEl.style.width : '40pt';
        colgroup.insertBefore(col, refEl ? (after ? refEl.nextSibling : refEl) : null);
      }
      focus = created || td;
    } else if (op === 'deleteCol') {
      const c = me.c;
      if (grid.cols <= 1) return this.tableOp('deleteTable');
      const done = new Set();
      for (let r = 0; r < grid.rows; r++) {
        const cell = grid.at(r, c);
        if (!cell || done.has(cell)) continue;
        done.add(cell);
        if (cell.cs > 1) cell.el.colSpan = cell.cs - 1;
        else cell.el.remove();
      }
      if (colEls[c]) colEls[c].remove();
      const g2 = tableGrid(table);
      const t = g2.at(Math.min(me.r, g2.rows - 1), Math.min(c, g2.cols - 1));
      focus = t ? t.el : table.querySelector('td');
    } else if (op === 'deleteTable') {
      const para = table.closest('.para');
      const cap = Array.from(table.parentNode.children).find((x) => x.classList.contains('cap') && x.dataset.cap === table.dataset.cid);
      if (cap) cap.remove();
      table.remove();
      if (para) {
        this.normalizePara(para);
        this.setCaret(para.querySelector('span') || para, 0);
      }
      this.commit();
      return;
    }
    if (table.isConnected) this.refreshTable(table);
    if (focus && focus.isConnected) {
      const p = focus.querySelector('.para span') || focus;
      this.setCaret(p, 0);
    }
    this.commit();
  }

  /** 선택한 셀들(같은 표)의 배경색을 바꾼다. */
  cellsInSelection() {
    const r = this.getRange();
    if (!r) return [];
    const a = this.closestCell(r.startContainer);
    const b = this.closestCell(r.endContainer);
    if (!a) return [];
    if (!b || a === b) return [a];
    const table = a.closest('table');
    if (b.closest('table') !== table) return [a];
    const cells = Array.from(table.querySelectorAll(':scope > tbody > tr > td'));
    const ia = cells.indexOf(a), ib = cells.indexOf(b);
    if (ia < 0 || ib < 0) return [a];
    return cells.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
  }

  setCellFill(color) {
    const cells = this.cellsInSelection();
    if (!cells.length) { this.notify('표 안에 커서를 놓고 실행하세요.'); return; }
    for (const td of cells) {
      const m = /(?:^|\s)b(\d+)(?:\s|$)/.exec(td.className);
      const cur = m ? this.doc.borderFill(Number(m[1])) : null;
      const base = cur || solidBorderSpec(0.12);
      const side = (s) => ({ type: s ? s.type : 'none', width: s ? s.width : 0.1, color: s ? s.color : '#000000' });
      const spec = { left: side(base.left), right: side(base.right), top: side(base.top), bottom: side(base.bottom), fill: color || null };
      const id = this.doc.ensureBorderFill(spec);
      this.ensureBf(id);
      td.className = td.className.replace(/(^|\s)b\d+(?=\s|$)/, '').trim() + ` b${id}`;
    }
    this.commit();
  }

  insertTable(rows, cols) {
    const range = this.commandRange();
    if (!range) return;
    if (!range.collapsed) { range.collapse(false); this.setRange(range); }
    const para = this.closestPara(range.startContainer);
    if (!para) return;
    const plist = para.parentElement;
    const zoom = this.zoom || 1;
    const widthPt = Math.max(60, (plist.clientWidth || para.getBoundingClientRect().width / zoom) / PX_PER_PT - 2);
    const ps = psOf(para) ?? 0;
    const cs = this.csAt(range.startContainer);
    const size = this.doc.charShape(cs).size || 10;
    const bf = this.doc.ensureBorderFill(solidBorderSpec(0.12));
    this.ensureBf(bf);
    // 표 안 문단은 여백 없는 왼쪽 정렬로
    const cellPs = this.doc.deriveParaShape(ps, { marginLeft: 0, marginRight: 0, indent: 0, spaceBefore: 0, spaceAfter: 0, align: 'justify' });
    this.ensurePs(cellPs);
    const colW = Math.floor((widthPt / cols) * 100) / 100;
    const rowH = Math.round((size * 1.6 + 2.82) * 100) / 100;
    const table = document.createElement('table');
    table.className = 'tbl blk al-left';
    table.dataset.new = '1';
    table.dataset.rows = String(rows);
    table.dataset.cols = String(cols);
    table.style.width = `${Math.round(colW * cols * 100) / 100}pt`;
    const cg = document.createElement('colgroup');
    for (let c = 0; c < cols; c++) { const col = document.createElement('col'); col.style.width = `${colW}pt`; cg.appendChild(col); }
    table.appendChild(cg);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      tr.style.height = `${rowH}pt`;
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.className = `plist b${bf}`;
        td.dataset.w = String(colW);
        td.dataset.h = String(rowH);
        td.style.cssText = 'vertical-align:middle;padding:1.41pt 5.1pt 1.41pt 5.1pt';
        td.appendChild(this.makeEmptyPara(cellPs, cs, para.dataset.st || '0'));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const holder = document.createElement('div');
    holder.className = `para p${cellPs}`;
    holder.dataset.st = para.dataset.st || '0';
    holder.appendChild(table);
    // 빈 문단이면 그 자리에, 아니면 다음 문단으로
    const empty = !para.textContent.replace(/​/g, '') && !para.querySelector('img, table, [data-cid]');
    if (empty) plist.insertBefore(holder, para);
    else {
      plist.insertBefore(holder, para.nextSibling);
      if (!holder.nextElementSibling) plist.appendChild(this.makeEmptyPara(ps, cs, para.dataset.st || '0'));
    }
    this.setCaret(table.querySelector('td .para span'), 0);
    this.commit();
  }

  // ------------------------------------------------------------------ 그림

  insertImage(bytes, name = '') {
    const info = sniffImage(bytes);
    if (!info || !/^(png|jpg|gif|bmp)$/.test(info.ext)) { this.notify('지원하지 않는 그림 형식입니다. (PNG, JPG, GIF, BMP 만 가능)', true); return false; }
    const range = this.commandRange();
    if (!range) return false;
    const para = this.closestPara(range.startContainer);
    if (!para) return false;
    const key = `n${++this.imgCounter}`;
    const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
    this.newImages.set(key, { bytes, ext: info.ext, mime: info.mime, url, name });
    const plist = para.parentElement;
    const maxW = Math.max(40, (plist.clientWidth || 400) / PX_PER_PT - 4);
    let w = (info.width || 200) * 0.75;
    let h = (info.height || 200) * 0.75;
    if (w > maxW) { h = (h * maxW) / w; w = maxW; }
    const img = document.createElement('img');
    img.className = 'pic';
    img.dataset.newimg = key;
    img.alt = '그림';
    img.draggable = false;
    img.style.width = `${Math.round(w * 100) / 100}pt`;
    img.style.height = `${Math.round(h * 100) / 100}pt`;
    img.src = url;
    if (!this.insertInlineAtCaret(img)) return false;
    const r = document.createRange();
    r.setStartAfter(img);
    r.collapse(true);
    this.setRange(r);
    this.commit();
    return true;
  }

  /** 선택한 그림의 크기를 비율로 바꾼다. */
  scaleSelectedImage(factor) {
    const img = this.root.querySelector('img.pic.sel');
    if (!img) { this.notify('그림을 먼저 눌러 선택하세요.'); return; }
    const w = parseFloat(img.style.width) || 100, h = parseFloat(img.style.height) || 100;
    img.style.width = `${Math.round(w * factor * 100) / 100}pt`;
    img.style.height = `${Math.round(h * factor * 100) / 100}pt`;
    this.commit();
  }

  // ------------------------------------------------------------------ 복사/붙여넣기

  selectionPlainText() {
    const sel = document.getSelection();
    return sel ? sel.toString().replace(/​/g, '') : '';
  }

  onCopy(e, cut) {
    const range = this.commandRange();
    if (!range || range.collapsed) return;
    e.preventDefault();
    const frag = range.cloneContents();
    for (const el of frag.querySelectorAll('.sel, .csel')) el.classList.remove('sel', 'csel');
    const holder = document.createElement('div');
    holder.appendChild(frag);
    const inline = !holder.querySelector(':scope > .para, :scope > .sec, :scope > .body');
    let html = holder.innerHTML;
    if (holder.querySelector(':scope > .sec, :scope > .body')) {
      // 구역에 걸친 복사: 문단만 모은다.
      const paras = [];
      for (const b of holder.querySelectorAll('.body')) for (const p of Array.from(b.children)) if (p.classList.contains('para')) paras.push(p.outerHTML);
      html = paras.join('');
    }
    e.clipboardData.setData('text/html', `<div data-marohwp="${this.session}" data-inline="${inline ? 1 : 0}">${html}</div>`);
    e.clipboardData.setData('text/plain', this.selectionPlainText());
    if (cut) {
      if (this.closestPlist(range.startContainer) !== this.closestPlist(range.endContainer)) this.deleteAcross(range);
      else document.execCommand('delete');
      this.afterEdit('cmd');
    }
  }

  onPaste(e) {
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    const range = this.commandRange();
    if (!range) return;
    if (!range.collapsed) {
      if (this.closestPlist(range.startContainer) !== this.closestPlist(range.endContainer)) this.deleteAcross(range);
      else document.execCommand('delete');
    }
    // 그림 파일 붙여넣기
    for (const item of Array.from(cd.items || [])) {
      if (item.kind === 'file' && /^image\/(png|jpeg|gif|bmp)$/.test(item.type)) {
        const file = item.getAsFile();
        if (file) {
          file.arrayBuffer().then((buf) => this.insertImage(new Uint8Array(buf), file.name));
          return;
        }
      }
    }
    const html = cd.getData('text/html');
    const marker = html ? /<div data-marohwp="([a-z0-9]+)" data-inline="([01])">/.exec(html) : null;
    if (marker && marker[1] === this.session) {
      const t = document.createElement('template');
      t.innerHTML = html;
      const wrap = t.content.querySelector('div[data-marohwp]');
      if (wrap && this.pasteFragment(wrap, marker[2] === '1')) { this.fixImages(); this.afterEdit('cmd'); return; }
    }
    const text = cd.getData('text/plain');
    if (text) this.pasteText(text);
    this.afterEdit('cmd');
  }

  pasteText(text) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/​/g, '').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand('insertParagraph');
      if (line) document.execCommand('insertText', false, line);
    });
  }

  /** 이 편집기에서 복사한 조각을 붙여 넣는다. */
  pasteFragment(wrap, inline) {
    const range = this.commandRange();
    if (!range) return false;
    const para = this.closestPara(range.startContainer);
    if (!para) return false;
    for (const el of wrap.querySelectorAll('[data-pb]')) delete el.dataset.pb;
    if (inline) {
      const nodes = Array.from(wrap.childNodes);
      if (!nodes.length) return true;
      const marker = document.createElement('span');
      if (!this.insertInlineAtCaret(marker)) return false;
      for (const n of nodes) marker.parentNode.insertBefore(n, marker);
      const r = document.createRange();
      r.setStartBefore(marker);
      r.collapse(true);
      marker.remove();
      this.setRange(r);
      this.normalizePara(para);
      return true;
    }
    const paras = Array.from(wrap.children).filter((c) => c.classList.contains('para'));
    if (!paras.length) return false;
    // 현재 문단을 캐럿에서 둘로 나눈다.
    document.execCommand('insertParagraph');
    const r2 = this.getRange();
    const tailPara = r2 ? this.closestPara(r2.startContainer) : null;
    if (!tailPara) return false;
    const headPara = tailPara.previousElementSibling;
    const plist = tailPara.parentElement;
    const first = paras.shift();
    if (headPara && headPara.classList.contains('para')) {
      const filler = headPara.querySelector(':scope > span > br:only-child');
      if (filler && !headPara.textContent) filler.parentNode.remove();
      for (const n of Array.from(first.childNodes)) headPara.appendChild(n);
      this.normalizePara(headPara);
    } else plist.insertBefore(first, tailPara);
    const last = paras.pop();
    for (const p of paras) plist.insertBefore(p, tailPara);
    if (last) {
      const kids = Array.from(last.childNodes).filter((n) => !(n.nodeType === 1 && n.querySelector && n.querySelector(':scope > br:only-child') && !n.textContent));
      const ref = tailPara.firstChild;
      for (const n of kids) tailPara.insertBefore(n, ref);
      const r = document.createRange();
      if (ref) r.setStartBefore(ref); else r.setStart(tailPara, tailPara.childNodes.length);
      r.collapse(true);
      this.setRange(r);
      this.normalizePara(tailPara);
    }
    return true;
  }

  // ------------------------------------------------------------------ 실행 취소

  undo() {
    if (this.composing) return;
    if (this.history.undo()) { this.fixImages(); this.onChange(); this.onSelection(); this.revealCaret(); }
  }
  redo() {
    if (this.composing) return;
    if (this.history.redo()) { this.fixImages(); this.onChange(); this.onSelection(); this.revealCaret(); }
  }

  revealCaret() {
    const r = this.getRange();
    if (!r || !this.scroller) return;
    let rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      const el = this.closestEl(r.startContainer);
      rect = el ? el.getBoundingClientRect() : null;
    }
    if (!rect) return;
    const box = this.scroller.getBoundingClientRect();
    if (rect.top < box.top + 20) this.scroller.scrollTop += rect.top - box.top - 80;
    else if (rect.bottom > box.bottom - 20) this.scroller.scrollTop += rect.bottom - box.bottom + 80;
  }

  // ------------------------------------------------------------------ 찾기/바꾸기

  cleanZwsp() {
    const w = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    const list = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('​')) list.push(n);
    const r = this.getRange();
    for (const n of list) {
      if (r && (r.startContainer === n || r.endContainer === n)) continue;
      const v = n.nodeValue.replace(/​/g, '');
      if (v) n.nodeValue = v;
      else if (n.parentNode && n.parentNode.childNodes.length > 1) n.remove();
    }
  }

  /** 검색용 색인: 문단별 텍스트 노드 목록 */
  searchIndex() {
    const paras = [];
    for (const para of this.root.querySelectorAll('.para')) {
      const nodes = [];
      let text = '';
      const w = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const pe = n.parentElement;
        if (pe.closest('.para') !== para || pe.closest('[contenteditable="false"]')) continue;
        nodes.push({ node: n, start: text.length });
        text += n.nodeValue;
      }
      if (text) paras.push({ para, nodes, text });
    }
    return paras;
  }

  locate(entry, pos) {
    let hit = entry.nodes[0];
    for (const n of entry.nodes) { if (n.start <= pos) hit = n; else break; }
    return { node: hit.node, offset: pos - hit.start };
  }

  find(query, { backward = false, matchCase = false } = {}) {
    if (!query) return false;
    this.cleanZwsp();
    const index = this.searchIndex();
    if (!index.length) return false;
    const q = matchCase ? query : query.toLowerCase();
    const sel = this.getRange();
    const matches = [];
    for (const entry of index) {
      const hay = matchCase ? entry.text : entry.text.toLowerCase();
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + Math.max(1, q.length))) matches.push({ entry, pos: i });
    }
    if (!matches.length) return false;
    const toRange = (m) => {
      const a = this.locate(m.entry, m.pos);
      const b = this.locate(m.entry, m.pos + q.length - 1);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset + 1);
      return r;
    };
    let pick = null;
    if (sel) {
      if (!backward) {
        pick = matches.find((m) => { const r = toRange(m); return r.compareBoundaryPoints(Range.START_TO_END, sel) >= 0 && r.compareBoundaryPoints(Range.START_TO_START, sel) >= 0 && !(r.compareBoundaryPoints(Range.START_TO_START, sel) === 0 && r.compareBoundaryPoints(Range.END_TO_END, sel) === 0); });
      } else {
        for (let i = matches.length - 1; i >= 0; i--) {
          const r = toRange(matches[i]);
          if (r.compareBoundaryPoints(Range.START_TO_START, sel) < 0) { pick = matches[i]; break; }
        }
      }
    }
    if (!pick) pick = backward ? matches[matches.length - 1] : matches[0];
    const r = toRange(pick);
    this.setRange(r);
    this.revealCaret();
    return { total: matches.length, index: matches.indexOf(pick) + 1 };
  }

  replaceCurrent(query, replacement, opts = {}) {
    const cur = this.selectionPlainText();
    const same = opts.matchCase ? cur === query : cur.toLowerCase() === query.toLowerCase();
    if (same && cur) {
      if (replacement) document.execCommand('insertText', false, replacement);
      else document.execCommand('delete');
      this.afterEdit('cmd');
    }
    return this.find(query, opts);
  }

  replaceAll(query, replacement, { matchCase = false } = {}) {
    if (!query) return 0;
    this.cleanZwsp();
    const q = matchCase ? query : query.toLowerCase();
    let count = 0;
    for (const entry of this.searchIndex()) {
      const hay = matchCase ? entry.text : entry.text.toLowerCase();
      const hits = [];
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) hits.push(i);
      for (let k = hits.length - 1; k >= 0; k--) {
        const a = this.locate(entry, hits[k]);
        const b = this.locate(entry, hits[k] + q.length - 1);
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset + 1);
        r.deleteContents();
        if (replacement) {
          const node = a.node;
          if (node.isConnected) node.insertData(Math.min(a.offset, node.nodeValue.length), replacement);
        }
        count++;
      }
      if (hits.length) this.normalizePara(entry.para);
    }
    if (count) this.commit();
    return count;
  }

  // ------------------------------------------------------------------ 기타

  stats() {
    let chars = 0;
    let paras = 0;
    for (const p of this.root.querySelectorAll('.para')) {
      paras++;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.parentElement.closest('.para') !== p || n.parentElement.closest('.obj')) continue;
        chars += n.nodeValue.replace(/[​\s]/g, '').length;
      }
    }
    return { chars, paras, tables: this.root.querySelectorAll('table.tbl').length, images: this.root.querySelectorAll('img.pic').length };
  }

  /** 쪽 설정을 바꾼다. (구역 요소의 data-page 에 기록해 실행 취소가 되게 한다) */
  setPage(page, allSections = true) {
    const r = this.getRange();
    const curSec = r ? this.closestEl(r.startContainer).closest('.sec') : null;
    for (const sec of this.root.querySelectorAll('.sec')) {
      if (!allSections && curSec && sec !== curSec) continue;
      sec.dataset.page = JSON.stringify(page);
      this.applyPageStyle(sec, page);
    }
    this.commit();
  }

  pageOf(sec) {
    if (sec && sec.dataset.page) { try { return JSON.parse(sec.dataset.page); } catch { /* 아래로 */ } }
    const s = sec ? this.doc.sections[Number(sec.dataset.sec)] : this.doc.sections[0];
    return s ? s.page : this.doc.sections[0].page;
  }

  currentPage() {
    const r = this.getRange();
    const sec = r ? this.closestEl(r.startContainer).closest('.sec') : this.root.querySelector('.sec');
    return this.pageOf(sec || this.root.querySelector('.sec'));
  }

  applyPageStyle(sec, pg) {
    const n2 = (v) => Math.round(v * 100) / 100;
    sec.style.width = `${n2(pg.width)}pt`;
    sec.style.minHeight = `${n2(pg.height)}pt`;
    sec.style.padding = `${n2(pg.marginTop)}pt ${n2(pg.marginRight)}pt ${n2(pg.marginBottom)}pt ${n2(pg.marginLeft + (pg.gutter || 0))}pt`;
    const top = sec.querySelector(':scope > .hfa-top');
    const bottom = sec.querySelector(':scope > .hfa-bottom');
    if (top) top.style.minHeight = `${n2(pg.marginHeader)}pt`;
    if (bottom) bottom.style.minHeight = `${n2(pg.marginFooter)}pt`;
  }
}
