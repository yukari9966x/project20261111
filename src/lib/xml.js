// 작은 XML 파서/직렬화기. 원본 구조(요소·속성 순서·주석·공백)를 그대로 보존해
// 바뀌지 않은 부분은 다시 써도 같은 내용이 되도록 한다.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, g) ? ENT[g] : m;
  });
}

export function escapeText(s) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function escapeAttr(s) {
  return s.replace(/[&<>"\n\r\t]/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\n': return '&#10;';
      case '\r': return '&#13;';
      default: return '&#9;';
    }
  });
}

export class XElement {
  constructor(name, attrs = [], children = []) {
    this.type = 'el';
    this.name = name;
    this.attrs = attrs; // [[이름, 값], ...] 순서 보존
    this.children = children;
    this.parent = null;
    for (const c of children) c.parent = this;
  }
  get localName() {
    const i = this.name.indexOf(':');
    return i < 0 ? this.name : this.name.slice(i + 1);
  }
  get(name, dflt = undefined) {
    for (const a of this.attrs) if (a[0] === name) return a[1];
    return dflt;
  }
  has(name) { return this.attrs.some((a) => a[0] === name); }
  set(name, value) {
    const v = String(value);
    for (const a of this.attrs) if (a[0] === name) { a[1] = v; return this; }
    this.attrs.push([name, v]);
    return this;
  }
  remove(name) { this.attrs = this.attrs.filter((a) => a[0] !== name); return this; }
  num(name, dflt = 0) {
    const v = this.get(name);
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }
  get elements() { return this.children.filter((c) => c.type === 'el'); }
  /** 로컬 이름(접두사 제외)이 같은 첫 자식 요소 */
  child(local) {
    for (const c of this.children) if (c.type === 'el' && c.localName === local) return c;
    return null;
  }
  childrenNamed(local) { return this.children.filter((c) => c.type === 'el' && c.localName === local); }
  /** 자손 중 로컬 이름이 같은 첫 요소 (깊이 우선) */
  find(local) {
    for (const c of this.children) {
      if (c.type !== 'el') continue;
      if (c.localName === local) return c;
      const r = c.find(local);
      if (r) return r;
    }
    return null;
  }
  findAll(local, out = []) {
    for (const c of this.children) {
      if (c.type !== 'el') continue;
      if (c.localName === local) out.push(c);
      c.findAll(local, out);
    }
    return out;
  }
  get text() {
    let s = '';
    for (const c of this.children) {
      if (c.type === 'text' || c.type === 'cdata') s += c.value;
      else if (c.type === 'el') s += c.text;
    }
    return s;
  }
  append(node) { node.parent = this; this.children.push(node); return node; }
  insertAt(index, node) { node.parent = this; this.children.splice(index, 0, node); return node; }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) { this.children.splice(i, 1); node.parent = null; }
  }
  setChildren(list) {
    this.children = list;
    for (const c of list) c.parent = this;
  }
  clone() {
    const el = new XElement(this.name, this.attrs.map((a) => [a[0], a[1]]), this.children.map((c) => (c.type === 'el' ? c.clone() : { ...c })));
    el.selfClose = this.selfClose;
    return el;
  }
}

export const xText = (value) => ({ type: 'text', value });

export function xEl(name, attrs = {}, children = []) {
  const list = Array.isArray(attrs) ? attrs : Object.entries(attrs).map(([k, v]) => [k, String(v)]);
  return new XElement(name, list, children.map((c) => (typeof c === 'string' ? xText(c) : c)));
}

/** XML 문자열을 파싱한다. 반환: { prolog: [노드], root: XElement, epilog: [노드] } */
export function parseXml(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let pos = 0;
  const len = src.length;
  const top = [];
  const stack = [];
  let root = null;
  const push = (node) => {
    if (stack.length) { node.parent = stack[stack.length - 1]; stack[stack.length - 1].children.push(node); }
    else top.push(node);
  };
  while (pos < len) {
    const lt = src.indexOf('<', pos);
    if (lt < 0) {
      const t = src.slice(pos);
      if (t) push({ type: 'text', value: decodeEntities(t) });
      break;
    }
    if (lt > pos) push({ type: 'text', value: decodeEntities(src.slice(pos, lt)) });
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('XML 주석이 닫히지 않았습니다.');
      push({ type: 'comment', value: src.slice(lt + 4, e) });
      pos = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('XML CDATA 가 닫히지 않았습니다.');
      push({ type: 'cdata', value: src.slice(lt + 9, e) });
      pos = e + 3;
    } else if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e < 0) throw new Error('XML 처리 명령이 닫히지 않았습니다.');
      push({ type: 'pi', value: src.slice(lt + 2, e) });
      pos = e + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE 등: 대괄호 내부까지 고려해 닫는 '>' 를 찾는다
      let depth = 0;
      let e = lt + 2;
      for (; e < len; e++) {
        const c = src[e];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      push({ type: 'decl', value: src.slice(lt + 2, e) });
      pos = e + 1;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt + 2);
      if (e < 0) throw new Error('XML 닫는 태그가 손상되었습니다.');
      const name = src.slice(lt + 2, e).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`XML 태그 짝이 맞지 않습니다: </${name}>`);
      pos = e + 1;
    } else {
      // 여는 태그
      let p = lt + 1;
      const nameStart = p;
      while (p < len && !/[\s/>]/.test(src[p])) p++;
      const name = src.slice(nameStart, p);
      if (!name) throw new Error('XML 태그 이름이 비어 있습니다.');
      const attrs = [];
      let selfClose = false;
      for (;;) {
        while (p < len && /\s/.test(src[p])) p++;
        if (p >= len) throw new Error('XML 태그가 닫히지 않았습니다.');
        if (src[p] === '>') { p++; break; }
        if (src[p] === '/') {
          if (src[p + 1] !== '>') throw new Error('XML 태그가 손상되었습니다.');
          selfClose = true; p += 2; break;
        }
        const aStart = p;
        while (p < len && !/[\s=/>]/.test(src[p])) p++;
        const aName = src.slice(aStart, p);
        while (p < len && /\s/.test(src[p])) p++;
        if (src[p] !== '=') throw new Error(`XML 속성 값이 없습니다: ${aName}`);
        p++;
        while (p < len && /\s/.test(src[p])) p++;
        const q = src[p];
        if (q !== '"' && q !== "'") throw new Error(`XML 속성 따옴표가 없습니다: ${aName}`);
        const e = src.indexOf(q, p + 1);
        if (e < 0) throw new Error('XML 속성 값이 닫히지 않았습니다.');
        attrs.push([aName, decodeEntities(src.slice(p + 1, e))]);
        p = e + 1;
      }
      const el = new XElement(name, attrs, []);
      el.selfClose = selfClose;
      push(el);
      if (!stack.length && !root) root = el;
      if (!selfClose) stack.push(el);
      pos = p;
    }
  }
  if (stack.length) throw new Error(`XML 태그가 닫히지 않았습니다: <${stack[stack.length - 1].name}>`);
  if (!root) throw new Error('XML 루트 요소가 없습니다.');
  const ri = top.indexOf(root);
  return { prolog: top.slice(0, ri), root, epilog: top.slice(ri + 1) };
}

function serNode(n, out) {
  switch (n.type) {
    case 'text': out.push(escapeText(n.value)); break;
    case 'cdata': out.push('<![CDATA[', n.value, ']]>'); break;
    case 'comment': out.push('<!--', n.value, '-->'); break;
    case 'pi': out.push('<?', n.value, '?>'); break;
    case 'decl': out.push('<!', n.value, '>'); break;
    case 'el': {
      out.push('<', n.name);
      for (const a of n.attrs) out.push(' ', a[0], '="', escapeAttr(a[1]), '"');
      if (!n.children.length) {
        if (n.selfClose === false) out.push('></', n.name, '>');
        else out.push('/>');
      } else {
        out.push('>');
        for (const c of n.children) serNode(c, out);
        out.push('</', n.name, '>');
      }
      break;
    }
    default: break;
  }
}

export function serializeXml(doc) {
  const out = [];
  for (const n of doc.prolog) serNode(n, out);
  serNode(doc.root, out);
  for (const n of doc.epilog) serNode(n, out);
  return out.join('');
}

export function serializeNode(node) {
  const out = [];
  serNode(node, out);
  return out.join('');
}
