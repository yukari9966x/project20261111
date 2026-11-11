// 문서 모델 → 편집용 DOM (HTML 문자열)과 스타일시트

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
const n2 = (v) => (Math.round(v * 100) / 100).toString();

const SERIF_RE = /바탕|명조|궁서|신명|serif|batang|myeongjo|myungjo|gungsuh|times|song|ming/i;
const MONO_RE = /체$|mono|courier|consolas|coding/i;
const FONT_ALIAS = { '한컴바탕': '함초롬바탕', '한컴돋움': '함초롬돋움', 'HCR Batang': '함초롬바탕', 'HCR Dotum': '함초롬돋움' };
const SERIF_STACK = '"함초롬바탕","HCR Batang","바탕","Batang","Noto Serif KR","Nanum Myeongjo","AppleMyungjo",serif';
const SANS_STACK = '"함초롬돋움","HCR Dotum","맑은 고딕","Malgun Gothic","돋움","Dotum","Noto Sans KR","Nanum Gothic","Apple SD Gothic Neo",sans-serif';

export function fontFamilyCss(fonts) {
  const names = [];
  const add = (n) => {
    if (!n) return;
    if (!names.includes(n)) names.push(n);
    const a = FONT_ALIAS[n];
    if (a && !names.includes(a)) names.push(a);
  };
  add(fonts[1]);
  add(fonts[0]);
  const main = fonts[0] || fonts[1] || '';
  const stack = SERIF_RE.test(main) ? SERIF_STACK : SANS_STACK;
  void MONO_RE;
  return names.map((n) => `"${n.replace(/["\\]/g, '')}"`).concat([stack]).join(',');
}

export function charShapeCss(cs) {
  const parts = [];
  parts.push(`font-family:${fontFamilyCss(cs.fonts || [])}`);
  let size = cs.size * (cs.relSize || 100) / 100;
  if (cs.sup || cs.sub) size *= 0.6;
  parts.push(`font-size:${n2(size)}pt`);
  if (cs.bold) parts.push('font-weight:bold');
  if (cs.italic) parts.push('font-style:italic');
  if (cs.color && cs.color !== '#000000') parts.push(`color:${cs.color}`);
  if (cs.shade && cs.shade !== '#ffffff') parts.push(`background-color:${cs.shade}`);
  const deco = [];
  if (cs.underline === 'bottom') deco.push('underline');
  if (cs.underline === 'top') deco.push('overline');
  if (cs.strike) deco.push('line-through');
  if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);
  if (cs.spacing) parts.push(`letter-spacing:${n2(cs.spacing / 100)}em`);
  if (cs.sup) parts.push('vertical-align:super');
  else if (cs.sub) parts.push('vertical-align:sub');
  return parts.join(';');
}

export function paraShapeCss(ps) {
  const parts = [];
  const align = ps.align === 'distribute' ? 'justify' : ps.align;
  parts.push(`text-align:${align}`);
  if (ps.align === 'distribute') parts.push('text-align-last:justify');
  let left = ps.marginLeft || 0;
  if (ps.indent < 0) {
    left += -ps.indent;
    parts.push(`text-indent:${n2(ps.indent)}pt`);
  } else if (ps.indent > 0) {
    parts.push(`text-indent:${n2(ps.indent)}pt`);
  }
  parts.push(`margin:${n2(ps.spaceBefore || 0)}pt ${n2(ps.marginRight || 0)}pt ${n2(ps.spaceAfter || 0)}pt ${n2(left)}pt`);
  switch (ps.lineSpacingType) {
    case 'fixed': parts.push(`line-height:${n2(Math.max(1, ps.lineSpacing))}pt`); break;
    case 'spaceOnly': parts.push(`line-height:calc(1.3em + ${n2(ps.lineSpacing)}pt)`); break;
    case 'minimum': parts.push(`line-height:max(1.3em, ${n2(ps.lineSpacing)}pt)`); break;
    default: parts.push(`line-height:${n2(Math.max(50, ps.lineSpacing || 160) / 100)}`); break;
  }
  return parts.join(';');
}

const BORDER_CSS = { none: 'none', solid: 'solid', dash: 'dashed', dot: 'dotted', dashdot: 'dashed', dashdotdot: 'dashed', longdash: 'dashed', circle: 'dotted', double: 'double', thinthick: 'double', thickthin: 'double', triple: 'double', wave: 'solid', doublewave: 'double' };

function borderSideCss(s) {
  if (!s || s.type === 'none') return '0 none';
  let w = Math.max(0.5, (s.width || 0.12) * 72 / 25.4);
  const style = BORDER_CSS[s.type] || 'solid';
  if (style === 'double') w = Math.max(w, 2.25);
  return `${n2(w)}pt ${style} ${s.color || '#000'}`;
}

export function borderFillCss(bf) {
  const parts = [
    `border-left:${borderSideCss(bf.left)}`, `border-right:${borderSideCss(bf.right)}`,
    `border-top:${borderSideCss(bf.top)}`, `border-bottom:${borderSideCss(bf.bottom)}`,
  ];
  if (bf.fill) parts.push(`background-color:${bf.fill}`);
  return parts.join(';');
}

/** 문서의 글자/문단/테두리 모양을 CSS 규칙으로 만든다. */
export function buildShapeCss(doc) {
  const out = [];
  for (const cs of doc.charShapes) out.push(`.c${cs.id}{${charShapeCss(cs)}}`);
  for (const ps of doc.paraShapes) out.push(`.p${ps.id}{${paraShapeCss(ps)}}`);
  for (const bf of doc.borderFills) out.push(`.b${bf.id}{${borderFillCss(bf)}}`);
  return out.join('\n');
}

export class Renderer {
  constructor(doc, reg) {
    this.doc = doc;
    this.reg = reg; // { paras: Map, ctrls: Map, tabs: [] }
    this.autoCounters = { picture: 0, table: 0, equation: 0 };
  }

  renderDoc() {
    return this.doc.sections.map((s, i) => this.renderSection(s, i)).join('');
  }

  renderSection(sec, index) {
    const pg = sec.page;
    this.notes = [];
    this.headers = [];
    this.footers = [];
    const body = this.renderParas(sec.paras, null);
    const contentW = pg.width - pg.marginLeft - pg.marginRight - (pg.gutter || 0);
    const cols = sec.columns && sec.columns.count > 1 ? sec.columns.count : 1;
    const colW = cols > 1 ? (contentW - (sec.columns.gap || 0) * (cols - 1)) / cols : contentW;
    const style = `width:${n2(pg.width)}pt;min-height:${n2(pg.height)}pt;padding:${n2(pg.marginTop)}pt ${n2(pg.marginRight)}pt ${n2(pg.marginBottom)}pt ${n2(pg.marginLeft + (pg.gutter || 0))}pt`;
    let html = `<div class="sec" data-sec="${index}" style="${style}">`;
    // 머리말/꼬리말/주석 영역은 본문과 분리된 편집 영역으로 둔다 (본문 캐럿이 흘러들지 않게).
    html += `<div class="hfa hfa-top" contenteditable="false" style="min-height:${n2(pg.marginHeader)}pt">${this.headers.map((h) => this.renderHf(h)).join('')}</div>`;
    html += `<div class="body plist"${cols > 1 ? ` style="max-width:${n2(colW)}pt"` : ''}>${body}</div>`;
    html += `<div class="notes" contenteditable="false"${this.notes.length ? '' : ' hidden'}>${this.notes.map((n) => this.renderNote(n)).join('')}</div>`;
    html += `<div class="hfa hfa-bottom" contenteditable="false" style="min-height:${n2(pg.marginFooter)}pt">${this.footers.map((h) => this.renderHf(h)).join('')}</div>`;
    html += '</div>';
    return html;
  }

  renderHf(ctrl) {
    const label = (ctrl.hfKind === 'header' ? '머리말' : '꼬리말') + (ctrl.applyTo === 'even' ? ' (짝수 쪽)' : ctrl.applyTo === 'odd' ? ' (홀수 쪽)' : '');
    return `<div class="hf plist" contenteditable="true" data-cid="${ctrl.cid}" data-label="${escAttr(label)}">${this.renderParas(ctrl.paras || [], ctrl)}</div>`;
  }

  renderNote(ctrl) {
    return `<div class="note plist" contenteditable="true" data-cid="${ctrl.cid}">${this.renderParas(ctrl.paras || [], ctrl)}</div>`;
  }

  renderParas(paras, owner) {
    const prevOwner = this.owner;
    this.owner = owner;
    let html = '';
    for (const p of paras) html += this.renderPara(p);
    this.owner = prevOwner;
    return html;
  }

  renderPara(p) {
    this.reg.paras.set(p.uid, p);
    let html = '';
    let openCs = null;
    let visible = false;
    let lastBr = false;
    const close = () => { if (openCs !== null) { html += '</span>'; openCs = null; } };
    const open = (cs) => { if (openCs !== cs) { close(); html += `<span class="c${cs}">`; openCs = cs; } };
    if (p.broken) {
      html += '<span class="obj" contenteditable="false">읽을 수 없는 문단</span>';
      visible = true;
    }
    for (const it of p.items) {
      if (it.t === 'text') {
        if (!it.text) continue;
        open(it.cs);
        html += esc(it.text);
        visible = true; lastBr = false;
      } else if (it.t === 'tab') {
        close();
        let attr = '';
        if (it.raw || it.origin) { this.reg.tabs.push(it); attr = ` data-tab="${this.reg.tabs.length - 1}"`; }
        html += `<span class="c${it.cs} tab"${attr}>\t</span>`;
        visible = true; lastBr = false;
      } else if (it.t === 'br') {
        open(it.cs);
        html += '<br>';
        visible = true; lastBr = true;
      } else if (it.t === 'ctrl') {
        close();
        const r = this.renderCtrl(it.ctrl, it.cs);
        html += r.html;
        if (r.visible) { visible = true; lastBr = false; }
      }
    }
    close();
    const cs0 = p.items.length ? p.items[p.items.length - 1].cs : (p.cs0 ?? 0);
    if (!visible) html += `<span class="c${cs0}"><br></span>`;
    else if (lastBr) html += `<span class="c${cs0}"><br></span>`;
    const attrs = [`class="para p${p.paraShapeId}"`, `data-pid="${p.uid}"`, `data-st="${p.styleId}"`];
    if (p.pageBreak) attrs.push('data-pb="1"');
    return `<div ${attrs.join(' ')}>${html}</div>`;
  }

  renderCtrl(ctrl, cs) {
    this.reg.ctrls.set(ctrl.cid, ctrl);
    switch (ctrl.kind) {
      case 'table': return { html: this.renderTable(ctrl), visible: true };
      case 'picture': {
        const cls = ctrl.inline ? 'pic' : `pic blk al-${ctrl.horzAlign || 'left'}`;
        const w = Math.max(4, ctrl.width || 40), h = Math.max(4, ctrl.height || 40);
        return { html: `<img class="${cls}" data-cid="${ctrl.cid}" data-bin="${escAttr(ctrl.binId ?? '')}" alt="그림" draggable="false" style="width:${n2(w)}pt;height:${n2(h)}pt">` + this.renderCaption(ctrl), visible: true };
      }
      case 'textbox': {
        const w = Math.max(20, ctrl.width || 100), h = Math.max(10, ctrl.height || 20);
        let cls = ctrl.inline ? 'tbox plist' : `tbox plist blk al-${ctrl.horzAlign || 'left'}`;
        let st = `width:${n2(w)}pt;min-height:${n2(h)}pt`;
        const box = ctrl.box;
        if (box) {
          if (box.line) st += `;border:${n2(Math.max(0.5, box.lineWidth))}pt solid ${box.lineColor}`;
          else cls += ' noline';
          if (box.fill && box.fill !== '#ffffff') st += `;background-color:${box.fill}`;
        }
        return { html: `<span class="${cls}" data-cid="${ctrl.cid}" style="${st}">${this.renderParas(ctrl.paras || [], ctrl)}</span>` + this.renderCaption(ctrl), visible: true };
      }
      case 'note':
        this.notes.push(ctrl);
        return { html: `<sup class="fnref c${cs}" contenteditable="false" data-cid="${ctrl.cid}">${ctrl.number}${ctrl.noteKind === 'endnote' ? '*' : ')'}</sup>`, visible: true };
      case 'hf':
        (ctrl.hfKind === 'header' ? this.headers : this.footers).push(ctrl);
        return { html: `<span class="anc" contenteditable="false" data-cid="${ctrl.cid}"></span>`, visible: false };
      case 'autonum': {
        let text = '#';
        const owner = this.owner;
        if ((ctrl.numType === 'footnote' || ctrl.numType === 'endnote') && owner && owner.kind === 'note') text = `${owner.number})`;
        else if (ctrl.numValue) text = String(ctrl.numValue);
        else if (ctrl.numType in this.autoCounters) text = String(++this.autoCounters[ctrl.numType]);
        return { html: `<span class="num c${cs}" contenteditable="false" data-cid="${ctrl.cid}">${esc(text)}</span>`, visible: true };
      }
      case 'object': {
        const label = ctrl.script ? `${ctrl.label}: ${ctrl.script.slice(0, 60)}` : ctrl.label || '개체';
        return { html: `<span class="obj" contenteditable="false" data-cid="${ctrl.cid}">${esc(label)}</span>` + this.renderCaption(ctrl), visible: true };
      }
      default:
        return { html: `<span class="anc" contenteditable="false" data-cid="${ctrl.cid}"></span>`, visible: false };
    }
  }

  renderCaption(ctrl) {
    if (!ctrl.caption || !ctrl.caption.paras || !ctrl.caption.paras.length) return '';
    return `<span class="cap plist" data-cap="${ctrl.cid}">${this.renderParas(ctrl.caption.paras, ctrl)}</span>`;
  }

  renderTable(ctrl) {
    const rows = [];
    for (let r = 0; r < ctrl.rows; r++) rows.push([]);
    ctrl.cells.forEach((cell, idx) => {
      if (cell.row >= rows.length) { while (rows.length <= cell.row) rows.push([]); }
      rows[cell.row].push({ cell, idx });
    });
    for (const r of rows) r.sort((a, b) => a.cell.col - b.cell.col);
    const colW = tableColWidths(ctrl);
    const total = colW.reduce((a, b) => a + b, 0);
    const rowH = new Array(rows.length).fill(0);
    for (const cell of ctrl.cells) if (cell.rowSpan === 1 && cell.row < rowH.length) rowH[cell.row] = Math.max(rowH[cell.row], cell.height || 0);
    const cls = ctrl.inline ? 'tbl' : `tbl blk al-${ctrl.horzAlign || 'left'}`;
    let html = `<table class="${cls}" data-cid="${ctrl.cid}" data-rows="${rows.length}" data-cols="${colW.length}" style="width:${n2(total)}pt"><colgroup>`;
    for (const w of colW) html += `<col style="width:${n2(w)}pt">`;
    html += '</colgroup><tbody>';
    rows.forEach((row, r) => {
      html += `<tr style="height:${n2(rowH[r])}pt">`;
      for (const { cell, idx } of row) {
        const pad = cell.padding && (cell.padding[0] || cell.padding[1] || cell.padding[2] || cell.padding[3]) ? cell.padding : ctrl.padding || [1.4, 1.4, 1.4, 1.4];
        const st = `vertical-align:${cell.vAlign || 'top'};padding:${n2(pad[2])}pt ${n2(pad[1])}pt ${n2(pad[3])}pt ${n2(pad[0])}pt`;
        html += `<td class="plist b${cell.borderFillId}" data-cell="${idx}" data-r="${cell.row}" data-c="${cell.col}" data-w="${n2(cell.width)}" data-h="${n2(cell.height)}"${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''} style="${st}">`;
        html += this.renderParas(cell.paras, ctrl);
        html += '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html + this.renderCaption(ctrl);
  }
}

/** 표의 열 너비(pt)를 셀 정보에서 추정한다. */
export function tableColWidths(ctrl) {
  let cols = ctrl.cols || 0;
  for (const c of ctrl.cells) cols = Math.max(cols, c.col + c.colSpan);
  const w = new Array(cols).fill(0);
  for (const c of ctrl.cells) if (c.colSpan === 1 && c.width > 0) w[c.col] = Math.max(w[c.col], c.width);
  // 병합 셀로만 덮인 열: 남는 너비를 고르게 나눈다.
  for (let pass = 0; pass < 3; pass++) {
    for (const c of ctrl.cells) {
      if (c.colSpan <= 1 || !(c.width > 0)) continue;
      let known = 0;
      const unknown = [];
      for (let i = c.col; i < c.col + c.colSpan && i < cols; i++) { if (w[i] > 0) known += w[i]; else unknown.push(i); }
      if (unknown.length) {
        const each = Math.max(2, (c.width - known) / unknown.length);
        if (pass > 0 || unknown.length === 1) for (const i of unknown) w[i] = each;
      }
    }
  }
  for (let i = 0; i < cols; i++) if (!(w[i] > 0)) w[i] = 30;
  return w;
}
