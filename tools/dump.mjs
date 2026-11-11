// 개발용: 문서 구조를 요약해서 출력한다.  node tools/dump.mjs <파일> [--full]
import { readFileSync } from 'node:fs';
import { openDocument } from '../src/lib/index.js';

const file = process.argv[2];
const full = process.argv.includes('--full');
const doc = await openDocument(new Uint8Array(readFileSync(file)), file);
console.log(`format=${doc.format} sections=${doc.sections.length} charShapes=${doc.charShapes.length} paraShapes=${doc.paraShapes.length} borderFills=${doc.borderFills.length} styles=${doc.styles.length} bin=${doc.bin.size}`);
if (doc.warnings.length) console.log('warnings:', doc.warnings.slice(0, 10));
const stat = {};
const show = (paras, depth) => {
  for (const p of paras) {
    let line = '';
    for (const it of p.items) {
      if (it.t === 'text') line += it.text;
      else if (it.t === 'tab') line += '→';
      else if (it.t === 'br') line += '↵';
      else {
        const c = it.ctrl;
        stat[c.kind] = (stat[c.kind] || 0) + 1;
        line += `⟦${c.kind}${c.label ? ':' + c.label : ''}${c.ctrlId ? ':' + c.ctrlId : ''}${c.kind === 'table' ? ` ${c.rows}x${c.cols} cells=${c.cells.length}` : ''}${c.kind === 'picture' ? ` bin=${c.binId} ${c.width}x${c.height}` : ''}⟧`;
      }
    }
    if (full || depth === 0) console.log(`${'  '.repeat(depth)}[ps${p.paraShapeId} st${p.styleId}${p.pageBreak ? ' PB' : ''}] ${line.slice(0, full ? 400 : 110)}`);
    if (full) {
      for (const it of p.items) {
        if (it.t !== 'ctrl') continue;
        const c = it.ctrl;
        if (c.cells) for (const cell of c.cells) { console.log(`${'  '.repeat(depth + 1)}cell r${cell.row} c${cell.col} span ${cell.rowSpan}x${cell.colSpan} ${cell.width}x${cell.height} bf${cell.borderFillId}`); show(cell.paras, depth + 2); }
        if (c.paras) show(c.paras, depth + 1);
      }
    } else {
      for (const it of p.items) if (it.t === 'ctrl') { const c = it.ctrl; if (c.cells) for (const cell of c.cells) count(cell.paras); if (c.paras) count(c.paras); }
    }
  }
};
const count = (paras) => { for (const p of paras) for (const it of p.items) if (it.t === 'ctrl') { stat[it.ctrl.kind] = (stat[it.ctrl.kind] || 0) + 1; if (it.ctrl.cells) for (const cell of it.ctrl.cells) count(cell.paras); if (it.ctrl.paras) count(it.ctrl.paras); } };
doc.sections.forEach((s, i) => {
  console.log(`--- section ${i}: page ${JSON.stringify(s.page)} cols=${JSON.stringify(s.columns)} paras=${s.paras.length}`);
  show(full ? s.paras : s.paras.slice(0, 14), 0);
});
console.log('ctrl kinds:', stat);
if (process.argv.includes('--shapes')) {
  console.log(doc.charShapes.slice(0, 8));
  console.log(doc.paraShapes.slice(0, 6));
  console.log(doc.borderFills.slice(0, 4));
  console.log(doc.styles.slice(0, 5).map((s) => ({ ...s, origin: undefined })));
}
