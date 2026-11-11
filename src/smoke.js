// 설치본 자체 점검(스모크 테스트): `marohwp.exe --smoke-test=<폴더>` 로 실행하면
// 새 문서 → 입력/서식/표/그림 → HWP·HWPX 저장 → 다시 열기까지를 실제 창에서 해 본다.

import { openDocument, saveDocument, docPlainText } from './lib/index.js';

// 2x2 픽셀 PNG
const TINY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOULLvEwMDAxMDAwMDAAAAP/QFlCfylSwAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

export async function runSmokeTest({ host, editor, outDir, cmdNew }) {
  const log = [];
  const step = (m) => log.push(m);
  const sep = outDir.includes('\\') ? '\\' : '/';
  const expect = (cond, msg) => { if (!cond) throw new Error(`검사 실패: ${msg}`); step(`  ok - ${msg}`); };
  try {
    step(`marohwp ${host.appVersion} (${host.platform})`);
    await cmdNew();
    editor.focus();
    document.execCommand('insertText', false, '마로 HWP 시험 문서');
    document.execCommand('insertParagraph');
    document.execCommand('insertText', false, 'Hello, 한글! 1234');
    editor.afterEdit('cmd');
    // 둘째 문단 전체를 진하게
    const paras = editor.root.querySelectorAll('.body > .para');
    expect(paras.length === 2, '문단 2개 입력');
    const r = document.createRange();
    r.selectNodeContents(paras[1]);
    editor.setRange(r);
    editor.toggle('bold');
    editor.applyParaFormat({ align: 'center' });
    // 표
    r.selectNodeContents(paras[1]);
    r.collapse(false);
    editor.setRange(r);
    editor.insertTable(2, 2);
    document.execCommand('insertText', false, '표 안의 글');
    editor.afterEdit('cmd');
    expect(editor.root.querySelectorAll('table.tbl td').length === 4, '2x2 표 만들기');
    // 그림
    const lastPara = editor.root.querySelector('.body > .para:last-child');
    r.selectNodeContents(lastPara);
    r.collapse(false);
    editor.setRange(r);
    expect(editor.insertImage(TINY_PNG, 'tiny.png') === true, '그림 넣기');
    // 실행 취소/다시 실행
    editor.undo();
    expect(editor.root.querySelectorAll('img.pic').length === 0, '되돌리기');
    editor.redo();
    expect(editor.root.querySelectorAll('img.pic').length === 1, '다시 실행');

    for (const format of ['hwp', 'hwpx']) {
      step(`[${format}] 저장`);
      const { bytes } = await saveDocument(editor.doc, editor.getSaveModel(), format);
      const path = `${outDir}${sep}점검 문서.${format}`;
      await host.writeFile(path, bytes);
      const back = await host.readFile(path);
      expect(back.data.length === bytes.length, `${format} 파일 쓰기/읽기 (${bytes.length}바이트)`);
      const doc = await openDocument(back.data, back.name);
      const text = docPlainText(doc);
      expect(doc.format === format, `${format} 형식으로 열림`);
      expect(text.includes('마로 HWP 시험 문서') && text.includes('Hello, 한글! 1234') && text.includes('표 안의 글'), `${format} 글 내용 보존`);
      let tables = 0, pics = 0, bold = false, center = false;
      for (const s of doc.sections) {
        for (const p of s.paras) {
          if (doc.paraShape(p.paraShapeId).align === 'center') center = true;
          for (const it of p.items) {
            if (it.t === 'text' && it.text.includes('Hello') && doc.charShape(it.cs).bold) bold = true;
            if (it.t === 'ctrl' && it.ctrl.kind === 'table') tables++;
            if (it.t === 'ctrl' && it.ctrl.kind === 'picture') pics++;
          }
        }
      }
      expect(tables === 1 && pics === 1, `${format} 표·그림 보존`);
      expect(bold && center, `${format} 진하게·가운데 정렬 보존`);
      const last = doc.sections[0].paras[doc.sections[0].paras.length - 1];
      expect(last.items.length === 1 && last.items[0].t === 'ctrl', `${format} 빈 문단에 넣은 그림 앞에 줄 바꿈이 끼지 않음`);
      expect(doc.bin.size === 1, `${format} 그림 데이터 보존`);
    }
    host.setDocumentState({ title: '자체 점검 완료', dirty: false });
    step('모든 검사 통과');
    return { ok: true, log: log.join('\n') };
  } catch (e) {
    step(String(e && e.stack ? e.stack : e));
    return { ok: false, log: log.join('\n') };
  }
}
