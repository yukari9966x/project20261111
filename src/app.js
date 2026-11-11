// marohwp 앱: 메뉴/도구 모음/대화 상자와 파일 열기·저장을 편집기에 잇는다.

import { Editor } from './editor/editor.js';
import { openDocument, newDocument, saveDocument } from './lib/index.js';
import { runSmokeTest } from './smoke.js';

const host = window.marohwp || null; // 데스크톱(Electron) 연결. 없으면 웹 브라우저 방식으로 동작한다.
const $ = (sel) => document.querySelector(sel);

const els = {
  doc: $('#doc'), zoomer: $('#zoomer'), workspace: $('#workspace'), overlay: $('#overlay'),
  font: $('#tb-font'), size: $('#tb-size'), color: $('#tb-color'), shade: $('#tb-shade'),
  colorBar: $('#tb-color-bar'), shadeBar: $('#tb-shade-bar'), spacing: $('#tb-spacing'), zoom: $('#tb-zoom'),
  findbar: $('#findbar'), findText: $('#find-text'), replaceText: $('#replace-text'), findStatus: $('#find-status'),
  stFormat: $('#st-format'), stInfo: $('#st-info'), stMsg: $('#st-msg'), stState: $('#st-state'),
  fileInput: $('#file-input'), imageInput: $('#image-input'), fontList: $('#font-list'),
};

const state = { path: null, name: '빈 문서 1.hwp', format: 'hwp', untitled: true, zoom: 1, zoomMode: '100', lastColor: '#ff0000', lastShade: '#ffff00', busy: false };
let untitledCount = 1;

const editor = new Editor({
  root: els.doc,
  styleEl: $('#shape-css'),
  scroller: els.workspace,
  onChange: () => refreshState(),
  onSelection: () => scheduleToolbarSync(),
  notify: (msg, isError) => setStatus(msg, isError),
});

// ---------------------------------------------------------------------- 상태 표시

let statusTimer = null;
function setStatus(msg, isError = false) {
  els.stMsg.textContent = msg || '';
  els.stMsg.classList.toggle('err', !!isError);
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { els.stMsg.textContent = ''; }, isError ? 9000 : 5000);
}

function refreshState() {
  const dirty = editor.dirty;
  const title = `${state.name}${dirty ? ' *' : ''} - marohwp`;
  document.title = title;
  els.stState.textContent = dirty ? '수정됨' : state.untitled ? '새 문서' : '저장됨';
  els.stFormat.textContent = state.format === 'hwpx' ? 'HWPX 문서' : 'HWP 문서';
  if (host) host.setDocumentState({ title: `${state.name}${dirty ? ' *' : ''}`, dirty });
}

function baseName(p) { return String(p).replace(/^.*[\\/]/, ''); }
function stripExt(n) { return n.replace(/\.(hwpx?|HWPX?)$/, ''); }

// ---------------------------------------------------------------------- 대화 상자

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined) el.append(c);
  return el;
}

/**
 * 모달 대화 상자. buttons: [{ label, value, primary }]. 반환: 누른 버튼의 value (Esc 는 null).
 * collect 가 있으면 primary 버튼을 누를 때 collect() 의 결과를 돌려준다.
 */
function showDialog({ title, body, buttons, collect, wide }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    if (wide) dlg.style.minWidth = '460px';
    dlg.append(h('h2', { text: title }));
    const bodyEl = h('div', { class: 'dlg-body' });
    if (typeof body === 'string') for (const line of body.split('\n\n')) bodyEl.append(h('p', { text: line }));
    else bodyEl.append(body);
    dlg.append(bodyEl);
    const foot = h('div', { class: 'dlg-foot' });
    const close = (value) => {
      els.overlay.hidden = true;
      els.overlay.textContent = '';
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && prevFocus !== els.doc) prevFocus.focus();
      else editor.focus();
      resolve(value);
    };
    let primaryBtn = null;
    for (const b of buttons) {
      const btn = h('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}`, text: b.label });
      btn.addEventListener('click', () => {
        if (b.primary && collect) {
          const v = collect();
          if (v === undefined) return; // 입력 오류: 닫지 않는다
          close(v);
        } else close(b.value);
      });
      if (b.primary) primaryBtn = btn;
      foot.append(btn);
    }
    dlg.append(foot);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && primaryBtn && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); e.stopPropagation(); primaryBtn.click(); }
      else if (e.key === 'Tab') {
        const f = Array.from(dlg.querySelectorAll('button, input, select, [tabindex]')).filter((x) => !x.disabled);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    els.overlay.textContent = '';
    els.overlay.append(dlg);
    els.overlay.hidden = false;
    const focusEl = dlg.querySelector('[data-autofocus]') || dlg.querySelector('input, select') || primaryBtn || dlg.querySelector('button');
    if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
  });
}

const alertBox = (title, message) => showDialog({ title, body: message, buttons: [{ label: '확인', value: true, primary: true }] });

function field(label, input) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return [h('label', { for: id, text: label }), input];
}
const numInput = (value, min, max, step = 1) => h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
function readNum(input, min, max, name) {
  const v = Number(input.value);
  if (!Number.isFinite(v) || v < min || v > max) {
    setStatus(`${name}: ${min}~${max} 사이의 값을 넣어 주세요.`, true);
    input.focus();
    return null;
  }
  return v;
}

// ---------------------------------------------------------------------- 파일

async function confirmDiscard() {
  if (!editor.dirty) return true;
  const v = await showDialog({
    title: '바뀐 내용 저장',
    body: `'${state.name}' 문서의 바뀐 내용을 저장할까요?`,
    buttons: [{ label: '저장', value: 'save', primary: true }, { label: '저장 안 함', value: 'discard' }, { label: '취소', value: null }],
  });
  if (v === true || v === 'save') return cmdSave(false);
  return v === 'discard';
}

async function loadDocument(doc, info) {
  editor.load(doc);
  state.path = info.path || null;
  state.name = info.name;
  state.format = doc.format;
  state.untitled = !!info.untitled;
  els.workspace.scrollTop = 0;
  fillFontList();
  applyZoom(state.zoomMode);
  refreshState();
  syncToolbar();
  const secs = doc.sections.length;
  els.stInfo.textContent = secs > 1 ? `구역 ${secs}개` : '';
  if (doc.warnings.length) setStatus(`일부 내용을 읽지 못했습니다 (${doc.warnings.length}건). 해당 부분은 원본 그대로 보존됩니다.`, true);
  editor.focus();
}

async function openBytes(bytes, name, path) {
  let doc;
  try {
    doc = await openDocument(bytes, name);
  } catch (e) {
    await alertBox('문서를 열 수 없습니다', `${name}\n\n${e && e.message ? e.message : e}`);
    return false;
  }
  await loadDocument(doc, { path, name, untitled: false });
  if (host && path) host.addRecentFile(path);
  setStatus(`${name} 문서를 열었습니다.`);
  return true;
}

async function openPath(path) {
  if (!host) return false;
  try {
    const f = await host.readFile(path);
    return openBytes(f.data, f.name, f.path);
  } catch (e) {
    await alertBox('문서를 열 수 없습니다', `${baseName(path)}\n\n${e && e.message ? e.message : e}`);
    return false;
  }
}

/** 지금 문서가 손대지 않은 새 문서인가 */
const isPristine = () => state.untitled && !editor.dirty;

async function cmdNew() {
  if (!(await confirmDiscard())) return;
  untitledCount++;
  await loadDocument(await newDocument('hwp'), { name: `빈 문서 ${untitledCount}.hwp`, untitled: true });
}

async function cmdOpen() {
  if (!(await confirmDiscard())) return;
  if (host) {
    const f = await host.openFileDialog();
    if (f) await openBytes(f.data, f.name, f.path);
  } else {
    els.fileInput.value = '';
    els.fileInput.click();
  }
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 저장. 성공하면 true */
async function cmdSave(saveAs, forceFormat = null) {
  if (state.busy) return false;
  let path = state.path;
  let format = forceFormat || state.format;
  let name = state.name;
  if (saveAs || !path || forceFormat) {
    const suggested = `${stripExt(state.name)}.${format}`;
    if (host) {
      const dir = state.path ? state.path.replace(/[\\/][^\\/]*$/, '') : '';
      path = await host.saveFileDialog({ defaultPath: dir ? `${dir}${state.path.includes('\\') ? '\\' : '/'}${suggested}` : suggested, format });
      if (!path) return false;
      format = /\.hwpx$/i.test(path) ? 'hwpx' : 'hwp';
      name = baseName(path);
    } else {
      name = suggested;
      path = null;
    }
  }
  state.busy = true;
  try {
    let result;
    try {
      result = await saveDocument(editor.doc, editor.getSaveModel(), format);
      // 디스크에 쓰기 전에, 만든 파일을 다시 읽어 보아 깨지지 않았는지 확인한다.
      await openDocument(result.bytes, `check.${format}`);
    } catch (e) {
      await alertBox('저장하지 못했습니다', `파일을 만드는 중 문제가 생겨 저장을 중단했습니다. 원래 파일은 그대로입니다.\n\n${e && e.message ? e.message : e}`);
      return false;
    }
    try {
      if (host) await host.writeFile(path, result.bytes);
      else download(result.bytes, name);
    } catch (e) {
      await alertBox('저장하지 못했습니다', `${name}\n\n${e && e.message ? e.message : e}`);
      return false;
    }
    const converted = format !== editor.doc.format;
    if (converted) {
      const scroll = els.workspace.scrollTop;
      const doc = await openDocument(result.bytes, name);
      await loadDocument(doc, { path, name, untitled: false });
      els.workspace.scrollTop = scroll;
      const dropped = Object.entries(result.dropped || {});
      if (dropped.length) {
        await alertBox('형식을 바꿔 저장했습니다', `${format.toUpperCase()} 형식으로 저장했습니다. 형식을 바꾸면서 다음 내용은 옮기지 못했습니다.\n\n${dropped.map(([k, n]) => `· ${k}: ${n}개`).join('\n')}\n\n원래 문서 파일은 그대로 남아 있습니다.`);
      }
    } else {
      editor.markSaved();
      state.path = path;
      state.name = name;
      state.untitled = false;
    }
    if (host && path) host.addRecentFile(path);
    refreshState();
    setStatus(`${name} 저장했습니다.`);
    return true;
  } finally {
    state.busy = false;
  }
}

function setPrintPage() {
  const pg = editor.currentPage();
  let style = document.getElementById('print-css');
  if (!style) { style = h('style', { id: 'print-css' }); document.head.append(style); }
  const n = (v) => Math.round(v * 100) / 100;
  style.textContent = `@page { size: ${n(pg.width)}pt ${n(pg.height)}pt; margin: ${n(pg.marginTop + pg.marginHeader)}pt ${n(pg.marginRight)}pt ${n(pg.marginBottom + pg.marginFooter)}pt ${n(pg.marginLeft + (pg.gutter || 0))}pt; }`;
}

async function cmdPrint() {
  setPrintPage();
  if (host) {
    const r = await host.print();
    if (r && !r.ok && r.error && !/cancel/i.test(r.error)) setStatus(`인쇄하지 못했습니다: ${r.error}`, true);
  } else window.print();
}

async function cmdExportPdf() {
  setPrintPage();
  if (!host) { window.print(); return; }
  try {
    const dir = state.path ? state.path.replace(/[\\/][^\\/]*$/, '') : '';
    const suggested = `${stripExt(state.name)}.pdf`;
    const out = await host.exportPdf({ defaultPath: dir ? `${dir}${state.path.includes('\\') ? '\\' : '/'}${suggested}` : suggested });
    if (out) setStatus(`${baseName(out)} PDF로 내보냈습니다.`);
  } catch (e) {
    await alertBox('PDF로 내보내지 못했습니다', String(e && e.message ? e.message : e));
  }
}

async function cmdExit() {
  if (!(await confirmDiscard())) return;
  if (host) host.closeWindow();
  else window.close();
}

// ---------------------------------------------------------------------- 보기

function applyZoom(mode) {
  state.zoomMode = String(mode);
  let z;
  if (mode === 'fit') {
    const sec = els.doc.querySelector('.sec');
    const pageW = sec ? sec.offsetWidth : 794;
    z = Math.max(0.3, Math.min(3, (els.workspace.clientWidth - 64) / pageW));
  } else z = Number(mode) / 100;
  state.zoom = z;
  editor.zoom = z;
  els.zoomer.style.zoom = String(z);
  if (els.zoom.value !== state.zoomMode) {
    if (!Array.from(els.zoom.options).some((o) => o.value === state.zoomMode)) {
      const custom = els.zoom.querySelector('option[data-custom]') || els.zoom.appendChild(h('option', { 'data-custom': '1' }));
      custom.value = state.zoomMode;
      custom.textContent = `${state.zoomMode}%`;
    }
    els.zoom.value = state.zoomMode;
  }
}
function zoomStep(dir) {
  const cur = Math.round(state.zoom * 100);
  const steps = [30, 50, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300];
  let next;
  if (dir > 0) next = steps.find((s) => s > cur) || 300;
  else next = [...steps].reverse().find((s) => s < cur) || 30;
  applyZoom(String(next));
}

// ---------------------------------------------------------------------- 도구 모음 동기화

const COMMON_FONTS = ['함초롬바탕', '함초롬돋움', '맑은 고딕', '바탕', '바탕체', '돋움', '돋움체', '굴림', '굴림체', '궁서', '궁서체', '나눔고딕', '나눔명조', '휴먼명조', 'HY헤드라인M', 'HY견고딕', 'HY신명조', 'Arial', 'Times New Roman', 'Courier New', 'Calibri', 'Verdana', 'Tahoma'];
function fillFontList() {
  const names = new Set();
  if (editor.doc) for (const cs of editor.doc.charShapes) for (const f of cs.fonts || []) if (f) names.add(f);
  for (const f of COMMON_FONTS) names.add(f);
  els.fontList.textContent = '';
  for (const n of names) els.fontList.append(h('option', { value: n }));
}

let syncPending = false;
function scheduleToolbarSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => { syncPending = false; syncToolbar(); });
}

function syncToolbar() {
  if (!editor.doc) return;
  const cs = editor.currentCharShape();
  const ps = editor.currentParaShape();
  const active = (cmd, on) => { const b = document.querySelector(`.tb[data-cmd="${cmd}"]`); if (b) { b.classList.toggle('active', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  if (cs) {
    if (document.activeElement !== els.font) els.font.value = cs.fonts[0] || '';
    if (document.activeElement !== els.size) els.size.value = String(Math.round(cs.size * 10) / 10);
    active('format.bold', cs.bold);
    active('format.italic', cs.italic);
    active('format.underline', cs.underline !== 'none');
    active('format.strike', cs.strike);
  }
  if (ps) {
    for (const a of ['justify', 'left', 'center', 'right']) active(`para.align.${a}`, ps.align === a || (a === 'justify' && ps.align === 'distribute'));
    const v = ps.lineSpacingType === 'percent' ? String(Math.round(ps.lineSpacing)) : '';
    els.spacing.value = Array.from(els.spacing.options).some((o) => o.value === v) ? v : '';
  }
  const undo = document.querySelector('.tb[data-cmd="edit.undo"]');
  const redo = document.querySelector('.tb[data-cmd="edit.redo"]');
  if (undo) undo.disabled = !editor.history.canUndo;
  if (redo) redo.disabled = !editor.history.canRedo;
}

// ---------------------------------------------------------------------- 서식 대화 상자

async function dlgChar() {
  editor.focus();
  const cs = editor.currentCharShape();
  if (!cs) return;
  const font = h('input', { type: 'text', value: cs.fonts[0] || '', list: 'font-list', 'data-autofocus': '1' });
  const size = numInput(Math.round(cs.size * 10) / 10, 1, 400, 0.1);
  const spacing = numInput(cs.spacing || 0, -50, 50, 1);
  const color = h('input', { type: 'color', value: cs.color || '#000000' });
  const shadeOn = h('input', { type: 'checkbox' });
  shadeOn.checked = !!cs.shade && cs.shade !== '#ffffff';
  const shade = h('input', { type: 'color', value: cs.shade && cs.shade !== '#ffffff' ? cs.shade : '#ffff00' });
  const chk = (label, on) => { const c = h('input', { type: 'checkbox' }); c.checked = !!on; return { c, el: h('label', {}, [c, label]) }; };
  const bold = chk('진하게', cs.bold), italic = chk('기울임', cs.italic), under = chk('밑줄', cs.underline !== 'none'), strike = chk('취소선', cs.strike), sup = chk('위 첨자', cs.sup), sub = chk('아래 첨자', cs.sub);
  const body = h('div', {}, [
    h('div', { class: 'form-grid' }, [
      ...field('글꼴', font), ...field('크기 (pt)', size), ...field('자간 (%)', spacing), ...field('글자 색', color),
      h('label', {}, [shadeOn, ' 음영 색']), shade,
    ]),
    h('div', { class: 'form-row', style: 'margin-top:12px' }, [bold.el, italic.el, under.el, strike.el, sup.el, sub.el]),
  ]);
  const v = await showDialog({
    title: '글자 모양', body, wide: true,
    buttons: [{ label: '설정', primary: true }, { label: '취소', value: null }],
    collect: () => {
      const sz = readNum(size, 1, 400, '크기');
      const sp = readNum(spacing, -50, 50, '자간');
      if (sz === null || sp === null) return undefined;
      const name = font.value.trim();
      const out = {
        size: sz, spacing: sp, color: color.value, shade: shadeOn.checked ? shade.value : null,
        bold: bold.c.checked, italic: italic.c.checked, underline: under.c.checked ? (cs.underline === 'top' ? 'top' : 'bottom') : 'none',
        strike: strike.c.checked, sup: sup.c.checked && !sub.c.checked, sub: sub.c.checked,
      };
      if (name && name !== cs.fonts[0]) out.fonts = new Array(7).fill(name);
      return out;
    },
  });
  if (v) { editor.focus(); editor.applyCharFormat(v); }
}

async function dlgPara() {
  editor.focus();
  const ps = editor.currentParaShape();
  if (!ps) return;
  const align = h('select', { 'data-autofocus': '1' }, [['justify', '양쪽 정렬'], ['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬'], ['distribute', '배분 정렬']].map(([v, t]) => h('option', { value: v, text: t })));
  align.value = ps.align;
  const left = numInput(ps.marginLeft, 0, 500, 0.5), right = numInput(ps.marginRight, 0, 500, 0.5);
  const indentType = h('select', {}, [['none', '보통'], ['first', '들여쓰기'], ['hang', '내어쓰기']].map(([v, t]) => h('option', { value: v, text: t })));
  indentType.value = ps.indent > 0 ? 'first' : ps.indent < 0 ? 'hang' : 'none';
  const indent = numInput(Math.abs(ps.indent), 0, 500, 0.5);
  const before = numInput(ps.spaceBefore, 0, 500, 0.5), after = numInput(ps.spaceAfter, 0, 500, 0.5);
  const lsType = h('select', {}, [['percent', '글자에 따라 (%)'], ['fixed', '고정 값 (pt)'], ['spaceOnly', '여백만 지정 (pt)'], ['minimum', '최소 (pt)']].map(([v, t]) => h('option', { value: v, text: t })));
  lsType.value = ps.lineSpacingType || 'percent';
  const ls = numInput(ps.lineSpacing, 0, 1000, 1);
  const pb = h('input', { type: 'checkbox' });
  pb.checked = !!ps.pageBreakBefore;
  const body = h('div', { class: 'form-grid' }, [
    ...field('정렬', align), ...field('왼쪽 여백 (pt)', left), ...field('오른쪽 여백 (pt)', right),
    ...field('첫 줄', indentType), ...field('첫 줄 값 (pt)', indent),
    ...field('문단 위 간격 (pt)', before), ...field('문단 아래 간격 (pt)', after),
    ...field('줄 간격 종류', lsType), ...field('줄 간격 값', ls),
    h('label', {}, [pb, ' 문단 앞에서 쪽 나눔']), h('span'),
  ]);
  const v = await showDialog({
    title: '문단 모양', body, wide: true,
    buttons: [{ label: '설정', primary: true }, { label: '취소', value: null }],
    collect: () => {
      const l = readNum(left, 0, 500, '왼쪽 여백'), r = readNum(right, 0, 500, '오른쪽 여백'), ind = readNum(indent, 0, 500, '첫 줄 값');
      const b = readNum(before, 0, 500, '문단 위 간격'), a = readNum(after, 0, 500, '문단 아래 간격');
      const lv = readNum(ls, lsType.value === 'percent' ? 50 : 0, lsType.value === 'percent' ? 500 : 1000, '줄 간격 값');
      if ([l, r, ind, b, a, lv].includes(null)) return undefined;
      return {
        align: align.value, marginLeft: l, marginRight: r,
        indent: indentType.value === 'first' ? ind : indentType.value === 'hang' ? -ind : 0,
        spaceBefore: b, spaceAfter: a, lineSpacingType: lsType.value, lineSpacing: lv, pageBreakBefore: pb.checked,
      };
    },
  });
  if (v) { editor.focus(); editor.applyParaFormat(v); }
}

const PAPERS = { A4: [210, 297], A3: [297, 420], B5: [182, 257], B4: [257, 364], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
const mm2pt = (mm) => (mm * 72) / 25.4;
const pt2mm = (pt) => Math.round(((pt * 25.4) / 72) * 10) / 10;

async function dlgPage() {
  editor.focus();
  const pg = editor.currentPage();
  const shortMm = pt2mm(Math.min(pg.width, pg.height)), longMm = pt2mm(Math.max(pg.width, pg.height));
  const paper = h('select', { 'data-autofocus': '1' }, [...Object.keys(PAPERS), '사용자 정의'].map((k) => h('option', { value: k, text: k })));
  const match = Object.entries(PAPERS).find(([, [w, hh]]) => Math.abs(w - shortMm) < 1 && Math.abs(hh - longMm) < 1);
  paper.value = match ? match[0] : '사용자 정의';
  const w = numInput(shortMm, 30, 1200, 0.1), hgt = numInput(longMm, 30, 1200, 0.1);
  paper.addEventListener('change', () => { const p = PAPERS[paper.value]; if (p) { w.value = String(p[0]); hgt.value = String(p[1]); } });
  const orient = h('select', {}, [h('option', { value: 'portrait', text: '세로' }), h('option', { value: 'landscape', text: '가로' })]);
  orient.value = pg.landscape || pg.width > pg.height ? 'landscape' : 'portrait';
  const mt = numInput(pt2mm(pg.marginTop), 0, 300, 0.1), mb = numInput(pt2mm(pg.marginBottom), 0, 300, 0.1);
  const ml = numInput(pt2mm(pg.marginLeft), 0, 300, 0.1), mr = numInput(pt2mm(pg.marginRight), 0, 300, 0.1);
  const mh = numInput(pt2mm(pg.marginHeader), 0, 300, 0.1), mf = numInput(pt2mm(pg.marginFooter), 0, 300, 0.1);
  const body = h('div', { class: 'form-grid' }, [
    ...field('용지 종류', paper), ...field('폭 (mm)', w), ...field('길이 (mm)', hgt), ...field('용지 방향', orient),
    ...field('위쪽 여백 (mm)', mt), ...field('아래쪽 여백 (mm)', mb), ...field('왼쪽 여백 (mm)', ml), ...field('오른쪽 여백 (mm)', mr),
    ...field('머리말 여백 (mm)', mh), ...field('꼬리말 여백 (mm)', mf),
  ]);
  const v = await showDialog({
    title: '쪽 설정 (편집 용지)', body, wide: true,
    buttons: [{ label: '설정', primary: true }, { label: '취소', value: null }],
    collect: () => {
      const vals = [readNum(w, 30, 1200, '폭'), readNum(hgt, 30, 1200, '길이'), readNum(mt, 0, 300, '위쪽 여백'), readNum(mb, 0, 300, '아래쪽 여백'), readNum(ml, 0, 300, '왼쪽 여백'), readNum(mr, 0, 300, '오른쪽 여백'), readNum(mh, 0, 300, '머리말 여백'), readNum(mf, 0, 300, '꼬리말 여백')];
      if (vals.includes(null)) return undefined;
      const land = orient.value === 'landscape';
      const short = Math.min(vals[0], vals[1]), long = Math.max(vals[0], vals[1]);
      const page = {
        width: mm2pt(land ? long : short), height: mm2pt(land ? short : long),
        marginLeft: mm2pt(vals[4]), marginRight: mm2pt(vals[5]), marginTop: mm2pt(vals[2]), marginBottom: mm2pt(vals[3]),
        marginHeader: mm2pt(vals[6]), marginFooter: mm2pt(vals[7]), gutter: pg.gutter || 0, landscape: land,
      };
      for (const k of Object.keys(page)) if (typeof page[k] === 'number') page[k] = Math.round(page[k] * 100) / 100;
      if (page.width - page.marginLeft - page.marginRight < 30) { setStatus('여백이 너무 커서 글을 쓸 자리가 없습니다.', true); return undefined; }
      return page;
    },
  });
  if (v) { editor.focus(); editor.setPage(v, true); if (state.zoomMode === 'fit') applyZoom('fit'); }
}

async function dlgTable() {
  editor.focus();
  const rows = numInput(2, 1, 100), cols = numInput(3, 1, 30);
  rows.setAttribute('data-autofocus', '1');
  const v = await showDialog({
    title: '표 만들기',
    body: h('div', { class: 'form-grid' }, [...field('줄 수', rows), ...field('칸 수', cols)]),
    buttons: [{ label: '만들기', primary: true }, { label: '취소', value: null }],
    collect: () => {
      const r = readNum(rows, 1, 100, '줄 수'), c = readNum(cols, 1, 30, '칸 수');
      if (r === null || c === null) return undefined;
      return { rows: Math.round(r), cols: Math.round(c) };
    },
  });
  if (v) { editor.focus(); editor.insertTable(v.rows, v.cols); }
}

async function cmdInsertImage() {
  editor.focus();
  if (host) {
    const f = await host.pickImageDialog();
    if (f) { editor.focus(); editor.insertImage(f.data, f.name); }
  } else {
    els.imageInput.value = '';
    els.imageInput.click();
  }
}

async function dlgCellFill() {
  editor.focus();
  const color = h('input', { type: 'color', value: '#dbeafc', 'data-autofocus': '1' });
  const v = await showDialog({
    title: '셀 배경색',
    body: h('div', { class: 'form-grid' }, [...field('배경색', color)]),
    buttons: [{ label: '설정', primary: true }, { label: '취소', value: null }],
    collect: () => color.value,
  });
  if (v) { editor.focus(); editor.setCellFill(v); }
}

async function dlgInfo() {
  const s = editor.stats();
  const doc = editor.doc;
  await alertBox('문서 정보', [
    `파일 이름: ${state.name}`,
    `위치: ${state.path || '(아직 저장하지 않음)'}`,
    `형식: ${state.format === 'hwpx' ? 'HWPX (개방형 한글 문서)' : 'HWP 5.0'}`,
    `구역 ${doc.sections.length}개 · 문단 ${s.paras}개 · 글자 ${s.chars}자 (공백 제외) · 표 ${s.tables}개 · 그림 ${s.images}개`,
  ].join('\n\n'));
}

async function dlgShortcuts() {
  const rows = [
    ['새 문서', 'Ctrl+N / Alt+N'], ['불러오기', 'Ctrl+O / Alt+O'], ['저장하기', 'Ctrl+S / Alt+S'], ['다른 이름으로 저장', 'Ctrl+Shift+S / Alt+V'],
    ['인쇄', 'Ctrl+P / Alt+P'], ['되돌리기 / 다시 실행', 'Ctrl+Z / Ctrl+Y'], ['찾기 / 찾아 바꾸기', 'Ctrl+F / Ctrl+H'],
    ['진하게 / 기울임 / 밑줄', 'Ctrl+B / Ctrl+I / Ctrl+U'], ['글자 모양 / 문단 모양', 'Alt+L / Alt+T'], ['쪽 설정', 'F7'],
    ['쪽 나누기', 'Ctrl+Enter'], ['줄 바꿈(문단 유지)', 'Shift+Enter'], ['표에서 다음 / 이전 칸', 'Tab / Shift+Tab'], ['확대 / 축소 / 100%', 'Ctrl++ / Ctrl+- / Ctrl+0'],
  ];
  const grid = h('div', { class: 'form-grid' });
  for (const [a, b] of rows) grid.append(h('span', { text: a }), h('span', {}, b.split(' / ').flatMap((k, i) => (i ? [' / ', h('kbd', { text: k })] : [h('kbd', { text: k })]))));
  await showDialog({ title: '단축키 안내', body: grid, wide: true, buttons: [{ label: '닫기', value: true, primary: true }] });
}

async function dlgAbout() {
  const ver = host ? host.appVersion : '웹';
  const body = h('div', {}, [
    h('img', { class: 'about-logo', src: './assets/icon.svg', alt: '' }),
    h('p', { text: `marohwp ${ver}` }),
    h('p', { text: 'HWP · HWPX 문서를 읽고, 고치고, 저장하는 가벼운 워드프로세서입니다. 한글 프로그램을 쓸 수 없을 때 급한 문서 작업을 이어갈 수 있도록 만들었습니다.' }),
    h('p', { class: 'dlg-note', text: '손대지 않은 문단·표·개체는 원본 그대로 보존해서 저장합니다. 고친 문단의 줄 배치는 한글에서 열 때 다시 계산됩니다. 화면은 쪽으로 나뉘지 않은 연속 보기이며, 도형·수식 등 일부 개체는 자리 표시로만 보입니다.' }),
    h('p', { class: 'dlg-note', text: '빈 문서 틀은 rhwp 프로젝트(MIT 라이선스)의 빈 문서 파일을 사용합니다. 한글과 HWP는 (주)한글과컴퓨터의 상표이며, 이 프로그램은 한글과컴퓨터와 관계가 없습니다.' }),
  ]);
  await showDialog({ title: 'marohwp 정보', body, wide: true, buttons: [{ label: '닫기', value: true, primary: true }] });
}

// ---------------------------------------------------------------------- 찾기

function findOpts() { return { matchCase: false }; }
function openFind(withReplace) {
  els.findbar.hidden = false;
  els.replaceText.hidden = !withReplace;
  for (const b of els.findbar.querySelectorAll('[data-cmd="find.replace"], [data-cmd="find.replaceAll"]')) b.hidden = !withReplace;
  const sel = editor.selectionPlainText();
  if (sel && !sel.includes('\n') && sel.length < 80) els.findText.value = sel;
  els.findText.focus();
  els.findText.select();
}
function closeFind() { els.findbar.hidden = true; els.findStatus.textContent = ''; editor.focus(); }
function doFind(backward) {
  const q = els.findText.value;
  if (!q) return;
  editor.focus();
  const r = editor.find(q, { ...findOpts(), backward });
  els.findStatus.textContent = r ? `${r.index} / ${r.total}` : '찾는 내용이 없습니다.';
}
function doReplace() {
  const q = els.findText.value;
  if (!q) return;
  editor.focus();
  const r = editor.replaceCurrent(q, els.replaceText.value, findOpts());
  els.findStatus.textContent = r ? `${r.index} / ${r.total}` : '더 바꿀 내용이 없습니다.';
}
function doReplaceAll() {
  const q = els.findText.value;
  if (!q) return;
  editor.focus();
  const n = editor.replaceAll(q, els.replaceText.value, findOpts());
  els.findStatus.textContent = n ? `${n}곳을 바꿨습니다.` : '찾는 내용이 없습니다.';
}

// ---------------------------------------------------------------------- 명령

async function pasteFromMenu() {
  editor.focus();
  if (host && host.paste) { host.paste(); return; }
  try {
    const text = await navigator.clipboard.readText();
    if (text) { editor.focus(); editor.pasteText(text); editor.afterEdit('cmd'); }
  } catch {
    setStatus('붙이기는 Ctrl+V 를 눌러 주세요.');
  }
}

const COMMANDS = {
  'file.new': cmdNew,
  'file.open': cmdOpen,
  'file.save': () => cmdSave(false),
  'file.saveAs': () => cmdSave(true),
  'file.saveAsOther': () => cmdSave(true, state.format === 'hwp' ? 'hwpx' : 'hwp'),
  'file.exportPdf': cmdExportPdf,
  'file.print': cmdPrint,
  'file.info': dlgInfo,
  'file.exit': cmdExit,
  'edit.undo': () => { editor.focus(); editor.undo(); },
  'edit.redo': () => { editor.focus(); editor.redo(); },
  'edit.cut': () => { editor.focus(); document.execCommand('cut'); },
  'edit.copy': () => { editor.focus(); document.execCommand('copy'); },
  'edit.paste': pasteFromMenu,
  'edit.selectAll': () => { editor.focus(); document.execCommand('selectAll'); },
  'edit.find': () => openFind(false),
  'edit.replace': () => openFind(true),
  'find.next': () => doFind(false),
  'find.prev': () => doFind(true),
  'find.replace': doReplace,
  'find.replaceAll': doReplaceAll,
  'find.close': closeFind,
  'view.zoomIn': () => zoomStep(1),
  'view.zoomOut': () => zoomStep(-1),
  'view.zoom100': () => applyZoom('100'),
  'view.zoomFit': () => applyZoom('fit'),
  'insert.table': dlgTable,
  'insert.image': cmdInsertImage,
  'insert.pageBreak': () => { editor.focus(); editor.insertPageBreak(); },
  'format.char': dlgChar,
  'format.para': dlgPara,
  'format.page': dlgPage,
  'format.bold': () => { editor.focus(); editor.toggle('bold'); },
  'format.italic': () => { editor.focus(); editor.toggle('italic'); },
  'format.underline': () => { editor.focus(); editor.toggle('underline'); },
  'format.strike': () => { editor.focus(); editor.toggle('strike'); },
  'format.sup': () => { editor.focus(); editor.toggle('sup'); },
  'format.sub': () => { editor.focus(); editor.toggle('sub'); },
  'format.noShade': () => { editor.focus(); editor.applyCharFormat({ shade: null }); },
  'para.align.justify': () => { editor.focus(); editor.applyParaFormat({ align: 'justify' }); },
  'para.align.left': () => { editor.focus(); editor.applyParaFormat({ align: 'left' }); },
  'para.align.center': () => { editor.focus(); editor.applyParaFormat({ align: 'center' }); },
  'para.align.right': () => { editor.focus(); editor.applyParaFormat({ align: 'right' }); },
  'table.rowAbove': () => { editor.focus(); editor.tableOp('rowAbove'); },
  'table.rowBelow': () => { editor.focus(); editor.tableOp('rowBelow'); },
  'table.colLeft': () => { editor.focus(); editor.tableOp('colLeft'); },
  'table.colRight': () => { editor.focus(); editor.tableOp('colRight'); },
  'table.deleteRow': () => { editor.focus(); editor.tableOp('deleteRow'); },
  'table.deleteCol': () => { editor.focus(); editor.tableOp('deleteCol'); },
  'table.deleteTable': () => { editor.focus(); editor.tableOp('deleteTable'); },
  'table.cellFill': dlgCellFill,
  'table.cellNoFill': () => { editor.focus(); editor.setCellFill(null); },
  'image.bigger': () => editor.scaleSelectedImage(1.1),
  'image.smaller': () => editor.scaleSelectedImage(1 / 1.1),
  'help.shortcuts': dlgShortcuts,
  'help.about': dlgAbout,
};

async function run(cmd, arg) {
  const fn = COMMANDS[cmd];
  if (!fn) return;
  try {
    await fn(arg);
  } catch (e) {
    console.error(e);
    setStatus(`명령을 실행하지 못했습니다: ${e && e.message ? e.message : e}`, true);
  }
  scheduleToolbarSync();
}

// ---------------------------------------------------------------------- 메뉴

const MENUS = {
  file: () => [
    ['새 문서', 'file.new', 'Ctrl+N'], ['불러오기…', 'file.open', 'Ctrl+O'], '-',
    ['저장하기', 'file.save', 'Ctrl+S'], ['다른 이름으로 저장하기…', 'file.saveAs', 'Ctrl+Shift+S'],
    [state.format === 'hwp' ? 'HWPX 형식으로 저장하기…' : 'HWP 형식으로 저장하기…', 'file.saveAsOther'], '-',
    ['PDF로 내보내기…', 'file.exportPdf'], ['인쇄…', 'file.print', 'Ctrl+P'], '-',
    ['쪽 설정…', 'format.page', 'F7'], ['문서 정보…', 'file.info'],
    'recent', '-', ['끝내기', 'file.exit', 'Alt+F4'],
  ],
  edit: () => [
    ['되돌리기', 'edit.undo', 'Ctrl+Z'], ['다시 실행', 'edit.redo', 'Ctrl+Y'], '-',
    ['오려 두기', 'edit.cut', 'Ctrl+X'], ['복사하기', 'edit.copy', 'Ctrl+C'], ['붙이기', 'edit.paste', 'Ctrl+V'], '-',
    ['모두 선택', 'edit.selectAll', 'Ctrl+A'], '-', ['찾기…', 'edit.find', 'Ctrl+F'], ['찾아 바꾸기…', 'edit.replace', 'Ctrl+H'],
  ],
  view: () => [['확대', 'view.zoomIn', 'Ctrl++'], ['축소', 'view.zoomOut', 'Ctrl+-'], ['100%', 'view.zoom100', 'Ctrl+0'], ['폭 맞춤', 'view.zoomFit']],
  insert: () => [['표…', 'insert.table'], ['그림…', 'insert.image'], '-', ['쪽 나누기', 'insert.pageBreak', 'Ctrl+Enter']],
  format: () => [
    ['글자 모양…', 'format.char', 'Alt+L'], ['문단 모양…', 'format.para', 'Alt+T'], '-',
    ['진하게', 'format.bold', 'Ctrl+B'], ['기울임', 'format.italic', 'Ctrl+I'], ['밑줄', 'format.underline', 'Ctrl+U'], ['취소선', 'format.strike'],
    ['위 첨자', 'format.sup'], ['아래 첨자', 'format.sub'], '-',
    ['양쪽 정렬', 'para.align.justify'], ['왼쪽 정렬', 'para.align.left'], ['가운데 정렬', 'para.align.center'], ['오른쪽 정렬', 'para.align.right'], '-',
    ['선택한 그림 크게', 'image.bigger'], ['선택한 그림 작게', 'image.smaller'],
  ],
  table: () => [
    ['표 만들기…', 'insert.table'], '-',
    ['위에 줄 추가', 'table.rowAbove'], ['아래에 줄 추가', 'table.rowBelow'], ['왼쪽에 칸 추가', 'table.colLeft'], ['오른쪽에 칸 추가', 'table.colRight'], '-',
    ['줄 지우기', 'table.deleteRow'], ['칸 지우기', 'table.deleteCol'], ['표 지우기', 'table.deleteTable'], '-',
    ['셀 배경색…', 'table.cellFill'], ['셀 배경 없애기', 'table.cellNoFill'],
  ],
  help: () => [['단축키 안내', 'help.shortcuts'], ['marohwp 정보', 'help.about']],
};

let openMenu = null;
function closeMenus() {
  if (!openMenu) return;
  openMenu.classList.remove('open');
  const list = openMenu.querySelector('.menu-list');
  if (list) list.remove();
  openMenu.querySelector('.menu-title').setAttribute('aria-expanded', 'false');
  openMenu = null;
}

async function showMenu(menuEl) {
  closeMenus();
  const items = MENUS[menuEl.dataset.menu]();
  const list = h('div', { class: 'menu-list', role: 'menu' });
  const add = (label, cmd, key, arg) => {
    const b = h('button', { type: 'button', class: 'menu-item', role: 'menuitem' }, [h('span', { class: 'label', text: label }), h('span', { class: 'key', text: key || '' })]);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { closeMenus(); run(cmd, arg); });
    list.append(b);
  };
  for (const it of items) {
    if (it === '-') list.append(h('div', { class: 'menu-sep' }));
    else if (it === 'recent') {
      if (!host) continue;
      let recent = [];
      try { recent = await host.getRecentFiles(); } catch { recent = []; }
      if (recent.length) {
        list.append(h('div', { class: 'menu-sep' }));
        recent.slice(0, 8).forEach((p, i) => {
          const b = h('button', { type: 'button', class: 'menu-item', role: 'menuitem', title: p }, [h('span', { class: 'label', text: `${i + 1}. ${baseName(p)}` })]);
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', async () => { closeMenus(); if (await confirmDiscard()) openPath(p); });
          list.append(b);
        });
      }
    } else add(it[0], it[1], it[2]);
  }
  menuEl.append(list);
  menuEl.classList.add('open');
  menuEl.querySelector('.menu-title').setAttribute('aria-expanded', 'true');
  openMenu = menuEl;
}

function bindMenus() {
  for (const menuEl of document.querySelectorAll('#menubar .menu')) {
    const title = menuEl.querySelector('.menu-title');
    title.setAttribute('aria-haspopup', 'true');
    title.setAttribute('aria-expanded', 'false');
    title.addEventListener('mousedown', (e) => e.preventDefault());
    title.addEventListener('click', () => { if (openMenu === menuEl) closeMenus(); else showMenu(menuEl); });
    title.addEventListener('mouseenter', () => { if (openMenu && openMenu !== menuEl) showMenu(menuEl); });
  }
  document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenus(); });
  window.addEventListener('blur', closeMenus);
}

// ---------------------------------------------------------------------- 도구 모음 / 단축키

function bindToolbar() {
  for (const b of document.querySelectorAll('#toolbar .tb[data-cmd], #findbar [data-cmd]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => run(b.dataset.cmd));
  }
  const applyFont = () => {
    const name = els.font.value.trim();
    if (!name) return;
    editor.focus();
    editor.applyCharFormat({ fonts: new Array(7).fill(name) });
  };
  els.font.addEventListener('change', applyFont);
  els.font.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyFont(); } else if (e.key === 'Escape') editor.focus(); });
  const applySize = () => {
    const v = Number(els.size.value);
    if (!Number.isFinite(v) || v < 1 || v > 400) { setStatus('글자 크기는 1~400pt 사이로 넣어 주세요.', true); return; }
    editor.focus();
    editor.applyCharFormat({ size: Math.round(v * 10) / 10 });
  };
  els.size.addEventListener('change', applySize);
  els.size.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySize(); } else if (e.key === 'Escape') editor.focus(); });
  els.color.addEventListener('change', () => { state.lastColor = els.color.value; els.colorBar.style.background = els.color.value; editor.focus(); editor.applyCharFormat({ color: els.color.value }); });
  els.shade.addEventListener('change', () => { state.lastShade = els.shade.value; els.shadeBar.style.background = els.shade.value; editor.focus(); editor.applyCharFormat({ shade: els.shade.value }); });
  els.shadeBar.style.background = els.shade.value;
  els.spacing.addEventListener('change', () => {
    const v = Number(els.spacing.value);
    if (!v) return;
    editor.focus();
    editor.applyParaFormat({ lineSpacingType: 'percent', lineSpacing: v });
  });
  els.zoom.addEventListener('change', () => { applyZoom(els.zoom.value); editor.focus(); });
  els.findText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  els.replaceText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doReplace(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  els.fileInput.addEventListener('change', async () => {
    const f = els.fileInput.files[0];
    if (f) await openBytes(new Uint8Array(await f.arrayBuffer()), f.name, null);
  });
  els.imageInput.addEventListener('change', async () => {
    const f = els.imageInput.files[0];
    if (f) { editor.focus(); editor.insertImage(new Uint8Array(await f.arrayBuffer()), f.name); }
  });
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (!els.overlay.hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let cmd = null;
    if (e.key === 'Escape') {
      if (openMenu) { closeMenus(); e.preventDefault(); return; }
      if (!els.findbar.hidden && els.findbar.contains(document.activeElement)) return;
    }
    if (mod && !e.altKey) {
      if (k === 's') cmd = e.shiftKey ? 'file.saveAs' : 'file.save';
      else if (k === 'o') cmd = 'file.open';
      else if (k === 'n') cmd = 'file.new';
      else if (k === 'p') cmd = 'file.print';
      else if (k === 'f') cmd = 'edit.find';
      else if (k === 'h') cmd = 'edit.replace';
      else if (k === '=' || k === '+') cmd = 'view.zoomIn';
      else if (k === '-') cmd = 'view.zoomOut';
      else if (k === '0') cmd = 'view.zoom100';
    } else if (e.altKey && !mod && !e.shiftKey) {
      if (k === 's') cmd = 'file.save';
      else if (k === 'o') cmd = 'file.open';
      else if (k === 'n') cmd = 'file.new';
      else if (k === 'v') cmd = 'file.saveAs';
      else if (k === 'p') cmd = 'file.print';
      else if (k === 'l') cmd = 'format.char';
      else if (k === 't') cmd = 'format.para';
    } else if (!mod && !e.altKey) {
      if (e.key === 'F7') cmd = 'format.page';
      else if (e.key === 'F3') cmd = e.shiftKey ? 'find.prev' : 'find.next';
    }
    if (cmd) { e.preventDefault(); e.stopPropagation(); closeMenus(); run(cmd); }
  }, true);
  els.workspace.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  els.workspace.addEventListener('mousedown', (e) => {
    // 문서 바깥 빈 곳을 눌러도 편집 포커스를 잃지 않게
    if (e.target === els.workspace || e.target === els.zoomer) { e.preventDefault(); editor.focus(); }
  });
  window.addEventListener('resize', () => { if (state.zoomMode === 'fit') applyZoom('fit'); });
}

function bindDrop() {
  const ws = els.workspace;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); ws.classList.add('drop'); } });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) ws.classList.remove('drop'); });
  document.addEventListener('drop', async (e) => {
    ws.classList.remove('drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (/\.(png|jpe?g|gif|bmp)$/i.test(file.name)) { editor.focus(); editor.insertImage(new Uint8Array(await file.arrayBuffer()), file.name); return; }
    if (!(await confirmDiscard())) return;
    let path = null;
    if (host && host.getPathForFile) { try { path = host.getPathForFile(file) || null; } catch { path = null; } }
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, path);
  });
}

// ---------------------------------------------------------------------- 시작

async function boot() {
  bindMenus();
  bindToolbar();
  bindKeys();
  bindDrop();
  await loadDocument(await newDocument('hwp'), { name: '빈 문서 1.hwp', untitled: true });

  if (host) {
    host.onOpenPath(async (path) => {
      if (isPristine()) await openPath(path);
      else host.openInNewWindow(path);
    });
    host.onCloseRequested(async () => {
      if (await confirmDiscard()) host.closeWindow();
    });
    let smoke = null;
    try { smoke = await host.getSmokeTest(); } catch { smoke = null; }
    host.rendererReady();
    if (smoke) {
      const result = await runSmokeTest({ host, editor, outDir: smoke.outDir, openBytes, cmdNew: async () => loadDocument(await newDocument('hwp'), { name: '시험.hwp', untitled: true }) });
      host.finishSmokeTest(result);
    }
  } else {
    window.addEventListener('beforeunload', (e) => { if (editor.dirty) { e.preventDefault(); e.returnValue = ''; } });
    // 시험/개발용: ?open=<주소> 로 문서를 바로 연다.
    const url = new URLSearchParams(location.search).get('open');
    if (url) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await openBytes(new Uint8Array(await res.arrayBuffer()), decodeURIComponent(baseName(url.split('?')[0])), null);
      } catch (e) {
        setStatus(`문서를 가져오지 못했습니다: ${e.message}`, true);
      }
    }
  }
  window.__marohwp = { editor, state, run, openBytes, saveDocument, openDocument };
  document.documentElement.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  document.documentElement.dataset.ready = 'error';
  setStatus(`시작하지 못했습니다: ${e && e.message ? e.message : e}`, true);
});
