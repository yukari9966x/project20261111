// 다른 형식으로 저장하기 위한 변환 (HWP ↔ HWPX).
// 글자/문단 모양, 표, 그림, 쪽 설정을 옮긴다. 옮길 수 없는 개체(도형, 수식, 각주 등)는
// 빼고, 무엇이 빠졌는지 알려 준다.

import { sniffImage, solidBorderSpec } from './model.js';

const CS_KEYS = ['fonts', 'size', 'bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'color', 'shade', 'spacing', 'ratio', 'relSize', 'offset'];
const PS_KEYS = ['align', 'marginLeft', 'marginRight', 'indent', 'spaceBefore', 'spaceAfter', 'lineSpacingType', 'lineSpacing', 'pageBreakBefore', 'keepWithNext'];
const DROP_LABEL = { note: '각주/미주', hf: '머리말/꼬리말', object: '도형·수식 등 개체', autonum: '자동 번호', fieldBegin: '필드(누름틀·하이퍼링크)', anchor: '책갈피·쪽 번호 등 조판 부호', coldef: '단 설정' };

function colWidthsOf(cells, cols) {
  const w = new Array(cols).fill(0);
  for (const c of cells) if (c.colSpan === 1 && c.width > 0 && c.col < cols) w[c.col] = Math.max(w[c.col], c.width);
  for (const c of cells) {
    if (c.colSpan <= 1 || !(c.width > 0)) continue;
    let known = 0;
    const unknown = [];
    for (let i = c.col; i < c.col + c.colSpan && i < cols; i++) { if (w[i] > 0) known += w[i]; else unknown.push(i); }
    for (const i of unknown) w[i] = Math.max(2, (c.width - known) / unknown.length);
  }
  for (let i = 0; i < cols; i++) if (!(w[i] > 0)) w[i] = 30;
  return w;
}

/**
 * src 문서의 저장 모델을 target(빈 문서) 기준의 저장 모델로 바꾼다.
 * 반환: { model, dropped: { 이름: 개수 } }
 */
export async function convertModel(src, model, target) {
  const tPara = target.sections[0].paras[0];
  const baseCs = tPara ? tPara.cs0 ?? 0 : 0;
  const basePs = tPara ? tPara.paraShapeId : 0;
  const csMap = new Map();
  const psMap = new Map();
  const bfMap = new Map();
  const dropped = {};
  const drop = (kind) => { const k = DROP_LABEL[kind] || '기타 개체'; dropped[k] = (dropped[k] || 0) + 1; };

  const mapCs = (id) => {
    if (csMap.has(id)) return csMap.get(id);
    const s = src.charShape(id);
    const props = {};
    for (const k of CS_KEYS) props[k] = k === 'fonts' ? [...s.fonts] : s[k];
    const nid = target.deriveCharShape(baseCs, props);
    csMap.set(id, nid);
    return nid;
  };
  const mapPs = (id) => {
    if (psMap.has(id)) return psMap.get(id);
    const s = src.paraShape(id);
    const props = {};
    for (const k of PS_KEYS) props[k] = s[k];
    const nid = target.deriveParaShape(basePs, props);
    psMap.set(id, nid);
    return nid;
  };
  const mapBf = (id) => {
    if (bfMap.has(id)) return bfMap.get(id);
    const b = src.borderFill(id);
    const side = (s) => (s ? { type: s.type, width: s.width, color: s.color } : { type: 'none', width: 0.1, color: '#000000' });
    const spec = b ? { left: side(b.left), right: side(b.right), top: side(b.top), bottom: side(b.bottom), fill: b.fill || null } : solidBorderSpec(0.12);
    const nid = target.ensureBorderFill(spec);
    bfMap.set(id, nid);
    return nid;
  };

  async function convParas(sparas) {
    const out = [];
    for (const sp of sparas) out.push(await convPara(sp));
    return out;
  }

  async function tableItem(it, cs) {
    const cells = [];
    for (const c of it.cells) {
      cells.push({ cell: null, row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, width: c.width, height: c.height, borderFillId: mapBf(c.borderFillId), paras: await convParas(c.paras), listChanged: true });
    }
    let cols = it.cols || 0;
    for (const c of cells) cols = Math.max(cols, c.col + c.colSpan);
    let rows = it.rows || 0;
    for (const c of cells) rows = Math.max(rows, c.row + c.rowSpan);
    const colWidths = it.colWidths && it.colWidths.length === cols ? it.colWidths : colWidthsOf(cells, cols);
    return { t: 'ctrl', cs, isNew: true, deep: true, structChanged: true, ctrl: { kind: 'table', isNew: true, inline: !!it.ctrl.inline }, rows, cols, colWidths, tableWidth: colWidths.reduce((a, b) => a + b, 0), cells };
  }

  async function convPara(sp) {
    const np = { src: null, own: true, deep: true, paraShapeId: mapPs(sp.paraShapeId), styleId: 0, pageBreak: !!sp.pageBreak, cs0: mapCs(sp.cs0 ?? 0), items: [] };
    for (const it of sp.items) {
      const cs = mapCs(it.cs ?? 0);
      if (it.t === 'text') np.items.push({ t: 'text', cs, text: it.text });
      else if (it.t === 'tab') np.items.push({ t: 'tab', cs });
      else if (it.t === 'br') np.items.push({ t: 'br', cs });
      else if (it.t === 'ctrl') {
        const c = it.ctrl;
        if (c.kind === 'table' && it.cells) np.items.push(await tableItem(it, cs));
        else if (c.kind === 'picture') {
          let bytes = c.bytes || null;
          if (!bytes) {
            const bin = src.bin.get(c.binId) || src.bin.get(Number(c.binId)) || src.bin.get(String(c.binId));
            if (bin) { try { bytes = await bin.getBytes(); } catch { bytes = null; } }
          }
          const info = bytes ? sniffImage(bytes) : null;
          if (!bytes || !info) { drop('object'); continue; }
          np.items.push({ t: 'ctrl', cs, isNew: true, deep: true, ctrl: { kind: 'picture', isNew: true, bytes, ext: info.ext, mime: info.mime, width: c.width || 100, height: c.height || 100, inline: true } });
        } else if (c.kind === 'textbox' && it.paras) {
          // 글상자는 한 칸짜리 표로 옮긴다.
          const paras = await convParas(it.paras);
          const bf = target.ensureBorderFill(solidBorderSpec(0.12));
          const w = c.width || 200, h = c.height || 20;
          np.items.push({ t: 'ctrl', cs, isNew: true, deep: true, structChanged: true, ctrl: { kind: 'table', isNew: true, inline: !!c.inline }, rows: 1, cols: 1, colWidths: [w], tableWidth: w, cells: [{ cell: null, row: 0, col: 0, rowSpan: 1, colSpan: 1, width: w, height: h, borderFillId: bf, paras, listChanged: true }] });
          dropped['글상자(표로 바뀜)'] = (dropped['글상자(표로 바뀜)'] || 0) + 1;
        } else if (c.kind === 'fieldEnd' || c.kind === 'secdef') {
          // 조용히 뺀다
        } else drop(c.kind);
      }
    }
    return np;
  }

  const sections = [];
  for (const ms of model.sections) {
    const page = ms.page || (ms.section ? ms.section.page : null) || target.sections[0].page;
    sections.push({ section: null, paras: await convParas(ms.paras), page, pageDirty: true, clean: false });
  }
  return { model: { sections }, dropped };
}
