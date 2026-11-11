// 문서 모델에서 바로 저장 모델을 만드는 도우미 (편집 화면 없이 저장/변환/시험할 때 쓴다).

function itemsOf(para, opts) {
  const out = [];
  for (const it of para.items) {
    if (it.t === 'text') out.push({ t: 'text', cs: it.cs, text: it.text });
    else if (it.t === 'tab') out.push({ t: 'tab', cs: it.cs, src: it });
    else if (it.t === 'br') out.push({ t: 'br', cs: it.cs });
    else if (it.t === 'ctrl') out.push(ctrlItem(it, opts));
  }
  return out;
}

function ctrlItem(it, opts) {
  const c = it.ctrl;
  const si = { t: 'ctrl', cs: it.cs, ctrl: c, copy: false, deep: false };
  if (c.kind === 'table' && c.cells) {
    si.rows = c.rows; si.cols = c.cols; si.structChanged = false;
    si.cells = c.cells.map((cell) => {
      const paras = parasOf(cell.paras, opts);
      const listChanged = paras.some((p) => p.deep);
      if (listChanged) si.deep = true;
      return { cell, tmpl: cell, row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan, width: cell.width, height: cell.height, borderFillId: cell.borderFillId, paras, listChanged };
    });
  } else if (c.paras) {
    si.paras = parasOf(c.paras, opts);
    if (si.paras.some((p) => p.deep)) si.deep = true;
  }
  if (c.caption && c.caption.paras) {
    si.capParas = parasOf(c.caption.paras, opts);
    if (si.capParas.some((p) => p.deep)) si.deep = true;
  }
  return si;
}

function parasOf(paras, opts) {
  return paras.map((p) => {
    const own = !!opts.dirtyAll && !p.broken;
    const sp = { src: p, own, deep: own, paraShapeId: p.paraShapeId, styleId: p.styleId, pageBreak: !!p.pageBreak, cs0: p.cs0 ?? (p.items.length ? p.items[p.items.length - 1].cs : 0), items: itemsOf(p, opts) };
    if (sp.items.some((it) => it.t === 'ctrl' && it.deep)) sp.deep = true;
    return sp;
  });
}

/**
 * 문서 모델 그대로의 저장 모델. dirtyAll 을 주면 모든 문단을 "바뀐 것"으로 표시해
 * 저장기가 문단을 전부 다시 만들게 한다 (시험용).
 */
export function saveModelFromDoc(doc, opts = {}) {
  return {
    sections: doc.sections.map((section) => {
      const paras = parasOf(section.paras, opts);
      return { section, paras, page: section.page, pageDirty: false, clean: !paras.some((p) => p.deep) };
    }),
  };
}
