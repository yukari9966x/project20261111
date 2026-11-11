// 개발용 편집 시나리오 점검 (선택 사항). Playwright 가 설치된 환경에서만 돌릴 수 있다.
//   node tools/e2e-edit.cjs [결과 폴더]
// 새 문서에서 입력·서식·한글 조합 입력·표·붙여넣기·찾기/바꾸기·그림·저장까지 실제 브라우저로 해 본다.
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'marohwp-e2e-'));
  const port = 8700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.mjs'), String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  let failed = 0;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.stack));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const log = (...a) => console.log(...a);
  const ed = (fn, arg) => page.evaluate(fn, arg);
  const check = (name, cond, extra = '') => { if (!cond) failed++; log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${cond ? '' : extra}`); };
  const bodyText = () => ed(() => [...document.querySelectorAll('.body > .para')].map((p) => p.textContent.replace(/​/g, '')));

  await page.click('#doc .para');
  await page.keyboard.type('첫 문단');
  await page.keyboard.press('Enter');
  await page.keyboard.type('둘째 문단 abc');
  await page.keyboard.press('Enter');
  await page.keyboard.type('셋째');
  check('typing 3 paras', JSON.stringify(await bodyText()) === JSON.stringify(['첫 문단', '둘째 문단 abc', '셋째']), JSON.stringify(await bodyText()));

  // pending format: Ctrl+B then type
  await page.keyboard.press('Control+b');
  await page.keyboard.type('굵게');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('보통');
  const p3 = await ed(() => { const p = document.querySelectorAll('.body > .para')[2]; const m = window.__marohwp.editor; return [...p.querySelectorAll('span')].map((s) => [s.textContent.replace(/​/g, ''), m.doc.charShape(Number(/c(\d+)/.exec(s.className)[1])).bold]); });
  check('pending bold', JSON.stringify(p3.filter((x) => x[0])) === JSON.stringify([['셋째', false], ['굵게', true], ['보통', false]]), JSON.stringify(p3));

  // IME composition (CDP)
  const cdp = await ctx.newCDPSession(page);
  await page.keyboard.press('Enter');
  for (const t of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
  await cdp.send('Input.insertText', { text: '한' });
  for (const t of ['ㄱ', '그', '글']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
  await cdp.send('Input.insertText', { text: '글' });
  await page.keyboard.type(' 입력');
  check('IME composition', (await bodyText())[3] === '한글 입력', JSON.stringify(await bodyText()));

  // Backspace merge / Delete
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  check('backspace merges paras', (await bodyText()).length === 3 && (await bodyText())[2] === '셋째굵게보통한글 입력', JSON.stringify(await bodyText()));
  // Backspace at very start of doc: nothing
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Backspace');
  check('backspace at doc start is a no-op', (await bodyText())[0] === '첫 문단');

  // Table insert, type in cells with Tab
  await page.keyboard.press('Control+End');
  await ed(() => window.__marohwp.editor.insertTable(2, 3));
  await page.keyboard.type('A1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('B1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('C1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('A2');
  const cells = () => ed(() => [...document.querySelectorAll('table.tbl > tbody > tr')].map((tr) => [...tr.cells].map((td) => td.textContent.replace(/​/g, ''))));
  check('table typing', JSON.stringify(await cells()) === JSON.stringify([['A1', 'B1', 'C1'], ['A2', '', '']]), JSON.stringify(await cells()));
  // row/col ops
  await ed(() => window.__marohwp.run('table.rowBelow'));
  await page.keyboard.type('A3');
  await ed(() => window.__marohwp.run('table.colRight'));
  await page.keyboard.type('X3');
  check('row below + col right', JSON.stringify(await cells()) === JSON.stringify([['A1', '', 'B1', 'C1'], ['A2', '', '', ''], ['A3', 'X3', '', '']]), JSON.stringify(await cells()));
  await ed(() => window.__marohwp.run('table.deleteCol'));
  await ed(() => window.__marohwp.run('table.deleteRow'));
  check('delete col + row', JSON.stringify(await cells()) === JSON.stringify([['A1', 'B1', 'C1'], ['A2', '', '']]), JSON.stringify(await cells()));
  // backspace at cell start must not merge cells
  await page.click('table.tbl td:nth-child(2)');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  check('backspace at cell start keeps table', JSON.stringify(await cells()) === JSON.stringify([['A1', 'B1', 'C1'], ['A2', '', '']]), JSON.stringify(await cells()));
  // select across cells + Delete → clears, structure intact
  await ed(() => { const tds = document.querySelectorAll('table.tbl td'); const r = document.createRange(); r.setStart(tds[0].querySelector('span').firstChild, 1); r.setEnd(tds[2].querySelector('span').firstChild, 1); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Delete');
  const after = await cells();
  check('cross-cell delete clears cells', after.length === 2 && after[0].length === 3 && after[1][0] === 'A2', JSON.stringify(after));
  await page.keyboard.press('Control+z');
  check('undo restores cells', JSON.stringify(await cells()) === JSON.stringify([['A1', 'B1', 'C1'], ['A2', '', '']]), JSON.stringify(await cells()));

  // copy/paste internal (rich) : select para 2 fully → copy → paste at end of doc
  await ed(() => { const p = document.querySelectorAll('.body > .para')[2]; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+v');
  const lastP = await ed(() => { const ps = document.querySelectorAll('.body > .para'); const p = ps[ps.length - 1]; const m = window.__marohwp.editor; return [...p.querySelectorAll('span')].filter((s) => s.textContent).map((s) => [s.textContent.replace(/​/g, ''), m.doc.charShape(Number(/c(\d+)/.exec(s.className)[1])).bold]); });
  check('rich paste keeps formatting', JSON.stringify(lastP).includes('["굵게",true]'), JSON.stringify(lastP));
  // plain text paste with newlines
  await ed(() => navigator.clipboard.writeText('줄1\n줄2\t탭\n줄3'));
  await page.keyboard.press('Control+v');
  const bt = await bodyText();
  check('plain paste splits paragraphs', bt.slice(-2).join('|') === '줄2\t탭|줄3' && bt[bt.length - 3].endsWith('줄1'), JSON.stringify(bt.slice(-4)));

  // find / replace
  await ed(() => { window.__marohwp.editor.caretToStart(); });
  const f1 = await ed(() => window.__marohwp.editor.find('문단'));
  check('find', f1 && f1.total === 2 && f1.index === 1, JSON.stringify(f1));
  const n = await ed(() => window.__marohwp.editor.replaceAll('문단', 'PARA'));
  check('replaceAll', n === 2 && (await bodyText())[0] === '첫 PARA', JSON.stringify(await bodyText()).slice(0, 80));

  // paragraph format + page setup via editor API
  await ed(() => { const m = window.__marohwp.editor; m.caretToStart(); m.applyParaFormat({ align: 'right', marginLeft: 12, lineSpacing: 200 }); m.setPage({ ...m.currentPage(), width: 419.53, height: 595.28 }, true); });
  // image
  await ed(async () => { const m = window.__marohwp.editor; const b = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOULLvEwMDAxMDAwMDAAAAP/QFlCfylSwAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const ps = document.querySelectorAll('.body > .para'); const r = document.createRange(); r.selectNodeContents(ps[1]); r.collapse(false); m.setRange(r); m.insertImage(b, 't.png'); });
  check('image inserted', (await ed(() => document.querySelectorAll('img.pic').length)) === 1);

  // save both formats, reopen in page, compare text
  for (const fmt of ['hwp', 'hwpx']) {
    const r = await ed(async (fmt) => {
      const m = window.__marohwp;
      const res = await m.saveDocument(m.editor.doc, m.editor.getSaveModel(), fmt);
      const doc = await m.openDocument(res.bytes, 'x.' + fmt);
      const texts = doc.sections[0].paras.map((p) => p.items.map((i) => i.t === 'text' ? i.text : i.t === 'tab' ? '\t' : i.t === 'ctrl' ? `<${i.ctrl.kind}>` : '').join(''));
      let s = ''; for (let i = 0; i < res.bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, res.bytes.subarray(i, i + 0x8000));
      const p0 = doc.paraShape(doc.sections[0].paras[0].paraShapeId);
      return { texts, page: doc.sections[0].page.width, align: p0.align, ml: p0.marginLeft, ls: p0.lineSpacing, bin: doc.bin.size, warn: doc.warnings.length, b64: btoa(s) };
    }, fmt);
    fs.writeFileSync(`${out}/e2e-new.${fmt}`, Buffer.from(r.b64, 'base64'));
    delete r.b64;
    check(`save ${fmt}`, r.warn === 0 && r.bin === 1 && Math.abs(r.page - 419.53) < 0.02 && r.align === 'right' && r.ml === 12 && r.ls === 200 && r.texts[0] === '첫 PARA' && r.texts.some((t) => t.includes('<table>')) && r.texts.some((t) => t.includes('<picture>')), JSON.stringify(r).slice(0, 400));
  }
  await page.screenshot({ path: `${out}/e2e-new.png` });
  if (errors.length) log('ERRORS:\n' + [...new Set(errors)].slice(0, 8).join('\n'));
  await browser.close();
  server.kill();
  if (errors.length) failed++;
  log(failed ? `실패 ${failed}건` : '모두 통과');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
