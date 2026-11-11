// 실행 취소/다시 실행: 문서 DOM 스냅숏 방식.
// 구역 본문의 최상위 문단 단위로 HTML 문자열을 보관하고, 바뀌지 않은 문단은 문자열을 공유한다.

function nodePath(root, node) {
  const path = [];
  let n = node;
  while (n && n !== root) {
    const p = n.parentNode;
    if (!p) return null;
    path.push(Array.prototype.indexOf.call(p.childNodes, n));
    n = p;
  }
  return n === root ? path.reverse() : null;
}
function nodeFromPath(root, path) {
  let n = root;
  for (const i of path) {
    if (!n.childNodes[i]) return n;
    n = n.childNodes[i];
  }
  return n;
}

export function saveSelection(root) {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const a = nodePath(root, sel.anchorNode);
  const f = nodePath(root, sel.focusNode);
  if (!a || !f) return null;
  return { a, ao: sel.anchorOffset, f, fo: sel.focusOffset };
}

export function restoreSelection(root, s) {
  if (!s) return;
  try {
    const sel = root.ownerDocument.getSelection();
    const an = nodeFromPath(root, s.a);
    const fn = nodeFromPath(root, s.f);
    const clamp = (n, o) => Math.min(o, n.nodeType === 3 ? n.nodeValue.length : n.childNodes.length);
    sel.setBaseAndExtent(an, clamp(an, s.ao), fn, clamp(fn, s.fo));
  } catch { /* 선택 복원 실패는 무시 */ }
}

export class History {
  constructor(root, limit = 300) {
    this.root = root;
    this.limit = limit;
    this.stack = [];
    this.index = -1;
    this.cache = new WeakMap();
    this.lastKind = null;
    this.lastTime = 0;
    this.savedSnap = null;
    this.observer = new MutationObserver((muts) => {
      for (const m of muts) this.invalidate(m.target);
    });
    this.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  invalidate(node) {
    let n = node;
    while (n && n !== this.root) {
      if (n.nodeType === 1) this.cache.delete(n);
      n = n.parentNode;
    }
  }

  htmlOf(el) {
    let h = this.cache.get(el);
    if (h === undefined) { h = el.outerHTML; this.cache.set(el, h); }
    return h;
  }

  capture() {
    this.observer.takeRecords().forEach((m) => this.invalidate(m.target));
    const secs = [];
    for (const sec of Array.from(this.root.children)) {
      const parts = [];
      for (const part of Array.from(sec.children)) {
        if (part.classList.contains('body')) parts.push({ body: true, open: part.cloneNode(false).outerHTML, blocks: Array.from(part.children).map((b) => this.htmlOf(b)) });
        else parts.push({ body: false, html: this.htmlOf(part) });
      }
      secs.push({ open: sec.cloneNode(false).outerHTML, parts });
    }
    return { secs, sel: saveSelection(this.root) };
  }

  /** 현재 상태를 기록한다. kind 가 같은 연속 입력은 하나로 합친다. */
  record(kind = 'cmd') {
    const now = Date.now();
    const snap = this.capture();
    const merge = kind === 'typing' && this.lastKind === 'typing' && now - this.lastTime < 800 && this.index === this.stack.length - 1 && this.index > 0 && this.stack[this.index] !== this.savedSnap;
    if (merge) this.stack[this.index] = snap;
    else {
      this.stack.length = this.index + 1;
      this.stack.push(snap);
      if (this.stack.length > this.limit) this.stack.shift();
      this.index = this.stack.length - 1;
    }
    this.lastKind = kind;
    this.lastTime = now;
  }

  /** 다음 기록이 앞의 입력과 합쳐지지 않게 한다. */
  breakRun() { this.lastKind = null; }

  reset() {
    this.stack = [];
    this.index = -1;
    this.lastKind = null;
    this.record('init');
    this.markSaved();
  }

  markSaved() { this.savedSnap = this.stack[this.index] || null; }
  get dirty() { return (this.stack[this.index] || null) !== this.savedSnap; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }

  undo() { if (!this.canUndo) return false; this.index--; this.apply(this.stack[this.index]); this.lastKind = null; return true; }
  redo() { if (!this.canRedo) return false; this.index++; this.apply(this.stack[this.index]); this.lastKind = null; return true; }

  apply(snap) {
    this.observer.takeRecords().forEach((m) => this.invalidate(m.target));
    const root = this.root;
    const doc = root.ownerDocument;
    const fromHtml = (html) => { const t = doc.createElement('template'); t.innerHTML = html; return t.content; };
    const secEls = Array.from(root.children);
    const sameShape = secEls.length === snap.secs.length && secEls.every((sec, i) => sec.children.length === snap.secs[i].parts.length && sec.cloneNode(false).outerHTML === snap.secs[i].open);
    if (!sameShape) {
      root.innerHTML = snap.secs.map((s) => {
        const inner = s.parts.map((p) => (p.body ? p.open.replace(/<\/div>$/, '') + p.blocks.join('') + '</div>' : p.html)).join('');
        return s.open.replace(/<\/div>$/, '') + inner + '</div>';
      }).join('');
    } else {
      secEls.forEach((sec, i) => {
        const parts = snap.secs[i].parts;
        Array.from(sec.children).forEach((part, k) => {
          const sp = parts[k];
          if (!sp.body) {
            if (this.htmlOf(part) !== sp.html) part.replaceWith(fromHtml(sp.html));
            return;
          }
          const cur = Array.from(part.children);
          const want = sp.blocks;
          let a = 0;
          while (a < cur.length && a < want.length && this.htmlOf(cur[a]) === want[a]) a++;
          let b = 0;
          while (b < cur.length - a && b < want.length - a && this.htmlOf(cur[cur.length - 1 - b]) === want[want.length - 1 - b]) b++;
          for (let j = a; j < cur.length - b; j++) cur[j].remove();
          const mid = want.slice(a, want.length - b).join('');
          if (mid) {
            const frag = fromHtml(mid);
            const ref = b > 0 ? cur[cur.length - b] : null;
            part.insertBefore(frag, ref);
          }
        });
      });
    }
    this.observer.takeRecords().forEach((m) => this.invalidate(m.target));
    restoreSelection(root, snap.sel);
  }
}
