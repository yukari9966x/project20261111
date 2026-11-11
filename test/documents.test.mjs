// 문서 엔진 시험: 새 문서 만들기 → 내용 넣기 → HWP/HWPX 저장 → 다시 읽기 → 형식 변환
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, newDocument, saveDocument, saveModelFromDoc, docPlainText } from '../src/lib/index.js';
import { solidBorderSpec } from '../src/lib/model.js';
import { readCfb } from '../src/lib/cfb.js';
import { readZip } from '../src/lib/zip.js';
import { bytesEqual, utf8Decode, base64ToBytes } from '../src/lib/bytes.js';

const PNG = base64ToBytes('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOULLvEwMDAxMDAwMDAAAAP/QFlCfylSwAAAABJRU5ErkJggg==');

const para = (cs, ps, items) => ({ src: null, own: true, deep: true, paraShapeId: ps, styleId: 0, pageBreak: false, cs0: cs, items });
const text = (cs, t) => ({ t: 'text', cs, text: t });

/** 빈 문서에 여러 가지 내용을 넣은 저장 모델을 만든다. */
function buildContent(doc) {
  const base = doc.sections[0].paras[0];
  const cs0 = base.cs0 ?? 0;
  const ps0 = base.paraShapeId;
  const bold = doc.deriveCharShape(cs0, { bold: true, size: 16, color: '#c00000', fonts: new Array(7).fill('맑은 고딕') });
  const deco = doc.deriveCharShape(cs0, { italic: true, underline: 'bottom', strike: true, shade: '#ffff00' });
  const center = doc.deriveParaShape(ps0, { align: 'center', spaceAfter: 6, lineSpacing: 200 });
  const indent = doc.deriveParaShape(ps0, { marginLeft: 20, indent: -10, lineSpacingType: 'fixed', lineSpacing: 18 });
  const bf = doc.ensureBorderFill(solidBorderSpec(0.12));
  const fill = doc.ensureBorderFill(solidBorderSpec(0.4, '#0000ff', '#dbeafc'));
  const cell = (row, col, t, b) => ({ cell: null, row, col, rowSpan: 1, colSpan: 1, width: 100, height: 20, borderFillId: b, paras: [para(cs0, ps0, t ? [text(cs0, t)] : [])], listChanged: true });
  const table = {
    t: 'ctrl', cs: cs0, isNew: true, deep: true, structChanged: true, ctrl: { kind: 'table', isNew: true, inline: false },
    rows: 2, cols: 2, colWidths: [100, 100], tableWidth: 200,
    cells: [cell(0, 0, '가', fill), cell(0, 1, '나', bf), cell(1, 0, '', bf), cell(1, 1, '라 & <마>', bf)],
  };
  const picture = { t: 'ctrl', cs: cs0, isNew: true, deep: true, ctrl: { kind: 'picture', isNew: true, bytes: PNG, ext: 'png', mime: 'image/png', width: 30, height: 30, inline: true } };
  const paras = [
    para(bold, center, [text(bold, '제목: marohwp 시험')]),
    para(cs0, ps0, [text(cs0, '보통 글 '), text(deco, '꾸민 글'), { t: 'tab', cs: cs0 }, text(cs0, '탭 뒤'), { t: 'br', cs: cs0 }, text(cs0, '줄 바꿈 뒤   묶음 빈칸')]),
    para(cs0, ps0, []),
    para(cs0, ps0, [table]),
    para(cs0, indent, [text(cs0, '그림: '), picture]),
    { ...para(cs0, ps0, [text(cs0, '새 쪽의 문단 😀 한자 漢字')]), pageBreak: true },
  ];
  const page = { ...doc.sections[0].page, width: 419.53, height: 595.28, marginLeft: 50, marginRight: 50, landscape: false };
  return { model: { sections: [{ section: doc.sections[0], paras, page, pageDirty: true, clean: false }] }, ids: { bold, deco, center, indent, fill } };
}

function inspect(doc) {
  const paras = doc.sections[0].paras;
  const out = { texts: paras.map((p) => p.items.filter((i) => i.t === 'text').map((i) => i.text).join('|')), tables: [], pictures: 0 };
  for (const p of paras) for (const it of p.items) {
    if (it.t !== 'ctrl') continue;
    if (it.ctrl.kind === 'table') out.tables.push(it.ctrl);
    if (it.ctrl.kind === 'picture') out.pictures++;
  }
  return out;
}

for (const format of ['hwp', 'hwpx']) {
  test(`${format}: 새 문서는 빈 문단 하나로 열린다`, async () => {
    const doc = await newDocument(format);
    assert.equal(doc.format, format);
    assert.equal(doc.sections.length, 1);
    assert.equal(doc.sections[0].paras.length, 1);
    assert.equal(docPlainText(doc), '');
    assert.equal(doc.warnings.length, 0);
    assert.ok(Math.abs(doc.sections[0].page.width - 595.28) < 0.1, 'A4 폭');
  });

  test(`${format}: 손대지 않고 저장하면 본문과 문서 정보가 원본과 같다`, async () => {
    const doc = await newDocument(format);
    const { bytes } = await saveDocument(doc, saveModelFromDoc(doc));
    const again = await openDocument(bytes);
    assert.equal(again.format, format);
    if (format === 'hwp') {
      const a = new Map(readCfb(bytes).entries.map((e) => [e.path, e]));
      for (const e of doc.backing.cfb.entries) {
        if (e.type !== 'stream' || e.path === 'PrvText' || e.path === 'DocInfo') continue;
        assert.ok(bytesEqual(a.get(e.path).data, e.data), `스트림이 바뀜: ${e.path}`);
      }
    } else {
      const a = readZip(bytes);
      for (const e of doc.backing.entries) {
        if (e.name === 'Preview/PrvText.txt') continue;
        const o = a.find((x) => x.name === e.name);
        assert.ok(o && bytesEqual(await o.getData(), await e.getData()), `항목이 바뀜: ${e.name}`);
      }
      assert.equal(a[0].name, 'mimetype');
      assert.equal(a[0].method, 0, 'mimetype 은 압축하지 않는다');
    }
  });

  test(`${format}: 글·서식·표·그림·쪽 설정을 넣어 저장하고 다시 읽는다`, async () => {
    const doc = await newDocument(format);
    const { model, ids } = buildContent(doc);
    const { bytes } = await saveDocument(doc, model);
    const back = await openDocument(bytes, `x.${format}`);
    assert.equal(back.warnings.length, 0);
    const got = inspect(back);
    assert.deepEqual(got.texts, ['제목: marohwp 시험', '보통 글 |꾸민 글|탭 뒤|줄 바꿈 뒤   묶음 빈칸', '', '', '그림: ', '새 쪽의 문단 😀 한자 漢字']);
    const paras = back.sections[0].paras;
    // 글자 모양
    const title = back.charShape(paras[0].items[0].cs);
    assert.equal(title.bold, true);
    assert.equal(title.size, 16);
    assert.equal(title.color, '#c00000');
    assert.equal(title.fonts[0], '맑은 고딕');
    const deco = back.charShape(paras[1].items[1].cs);
    assert.deepEqual([deco.italic, deco.underline, deco.strike, deco.shade], [true, 'bottom', true, '#ffff00']);
    const plain = back.charShape(paras[1].items[0].cs);
    assert.deepEqual([plain.bold, plain.italic, plain.underline, plain.strike], [false, false, 'none', false]);
    // 문단 모양
    const center = back.paraShape(paras[0].paraShapeId);
    assert.equal(center.align, 'center');
    assert.equal(center.spaceAfter, 6);
    assert.equal(center.lineSpacing, 200);
    const ind = back.paraShape(paras[4].paraShapeId);
    assert.deepEqual([ind.marginLeft, ind.indent, ind.lineSpacingType, ind.lineSpacing], [20, -10, 'fixed', 18]);
    assert.equal(paras[5].pageBreak, true);
    assert.deepEqual(paras[1].items.map((i) => i.t), ['text', 'text', 'tab', 'text', 'br', 'text']);
    // 표
    assert.equal(got.tables.length, 1);
    const t = got.tables[0];
    assert.deepEqual([t.rows, t.cols, t.cells.length], [2, 2, 4]);
    assert.deepEqual(t.cells.map((c) => [c.row, c.col, c.paras.map((p) => p.items.map((i) => i.text || '').join('')).join('/')]), [[0, 0, '가'], [0, 1, '나'], [1, 0, ''], [1, 1, '라 & <마>']]);
    assert.equal(t.cells[0].width, 100);
    const fill = back.borderFill(t.cells[0].borderFillId);
    assert.equal(fill.fill, '#dbeafc');
    assert.equal(fill.left.color, '#0000ff');
    assert.equal(back.borderFill(t.cells[1].borderFillId).left.type, 'solid');
    // 그림
    assert.equal(got.pictures, 1);
    assert.equal(back.bin.size, 1);
    const bin = [...back.bin.values()][0];
    assert.ok(bytesEqual(await bin.getBytes(), PNG), '그림 바이트 보존');
    // 쪽 설정
    const pg = back.sections[0].page;
    assert.ok(Math.abs(pg.width - 419.53) < 0.02 && Math.abs(pg.height - 595.28) < 0.02 && Math.abs(pg.marginLeft - 50) < 0.02);
    void ids;

    // 저장한 문서를 그대로 다시 저장해도, 전부 다시 만들어 저장해도 내용이 같다.
    for (const opts of [{}, { dirtyAll: true }]) {
      const r = await saveDocument(back, saveModelFromDoc(back, opts));
      const third = await openDocument(r.bytes);
      assert.deepEqual(inspect(third).texts, got.texts);
      assert.equal(inspect(third).tables[0].cells.length, 4);
      assert.equal(third.bin.size, 1);
    }
  });

  test(`${format}: 일부 문단만 고치면 나머지 문단은 원본 레코드 그대로 쓴다`, async () => {
    const doc0 = await newDocument(format);
    const first = await saveDocument(doc0, buildContent(doc0).model);
    const doc = await openDocument(first.bytes);
    const model = saveModelFromDoc(doc);
    const sec = model.sections[0];
    // 둘째 문단의 글만 바꾼다.
    const target = sec.paras[1];
    target.own = true; target.deep = true;
    target.items = [{ t: 'text', cs: target.items[0].cs, text: '고친 문단' }];
    sec.clean = false;
    const { bytes } = await saveDocument(doc, model);
    const back = await openDocument(bytes);
    assert.equal(inspect(back).texts[1], '고친 문단');
    assert.equal(inspect(back).texts[0], '제목: marohwp 시험');
    assert.equal(inspect(back).tables.length, 1);
    if (format === 'hwp') {
      // 고치지 않은 문단의 레코드는 바이트까지 같아야 한다 (마지막 문단 표시 비트 제외).
      const a = doc.sections[0].paras[3].origin, b = back.sections[0].paras[3].origin;
      const flat = (n) => [n.data, ...n.children.flatMap(flat)];
      const fa = flat(a), fb = flat(b);
      assert.equal(fa.length, fb.length);
      for (let i = 0; i < fa.length; i++) assert.ok(bytesEqual(fa[i], fb[i]), `레코드 ${i} 가 바뀜`);
    } else {
      const xml = utf8Decode(await readZip(bytes).find((e) => e.name === 'Contents/section0.xml').getData());
      assert.ok(!/<hp:p[^>]*>(?:(?!<\/hp:p>).)*고친 문단(?:(?!<\/hp:p>).)*linesegarray/.test(xml), '고친 문단에는 줄 배치 정보가 없어야 한다');
    }
  });
}

test('형식 변환: HWP → HWPX → HWP 로 옮겨도 글·표·그림이 남는다', async () => {
  const doc = await newDocument('hwp');
  const first = await saveDocument(doc, buildContent(doc).model);
  const hwp = await openDocument(first.bytes);
  const toX = await saveDocument(hwp, saveModelFromDoc(hwp), 'hwpx');
  const x = await openDocument(toX.bytes);
  assert.equal(x.format, 'hwpx');
  assert.deepEqual(inspect(x).texts, inspect(hwp).texts);
  assert.equal(inspect(x).tables[0].cells.length, 4);
  assert.equal(x.bin.size, 1);
  assert.equal(x.charShape(x.sections[0].paras[0].items[0].cs).bold, true);
  assert.equal(x.paraShape(x.sections[0].paras[0].paraShapeId).align, 'center');
  assert.ok(Math.abs(x.sections[0].page.width - 419.53) < 0.02, '쪽 크기 유지');
  const toH = await saveDocument(x, saveModelFromDoc(x), 'hwp');
  const h = await openDocument(toH.bytes);
  assert.equal(h.format, 'hwp');
  assert.deepEqual(inspect(h).texts, inspect(hwp).texts);
  assert.equal(h.bin.size, 1);
  assert.equal(h.borderFill(inspect(h).tables[0].cells[0].borderFillId).fill, '#dbeafc');
});

test('잘못된 파일은 알기 쉬운 오류로 거부한다', async () => {
  await assert.rejects(() => openDocument(new Uint8Array([1, 2, 3, 4, 5]), 'a.txt'), /HWP 또는 HWPX 문서가 아닙니다/);
  await assert.rejects(() => openDocument(new Uint8Array(2000), 'a.hwp'), /HWP 5\.0 형식이 아닙니다/);
  const doc = await newDocument('hwp');
  const { bytes } = await saveDocument(doc, saveModelFromDoc(doc));
  await assert.rejects(() => openDocument(bytes.subarray(0, 700), 'cut.hwp'));
});
