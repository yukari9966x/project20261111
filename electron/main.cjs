'use strict';
/*
 * marohwp — Electron 메인 프로세스
 *
 *  - 렌더러(src/)는 app://marohwp/ 로 제공한다 (file:// 사용 안 함, asar 안에서도 동일).
 *  - 창 하나 = 문서 하나. 두 번째 실행은 첫 번째 인스턴스로 전달된다.
 *  - 파일 입출력/대화상자는 preload(window.marohwp)를 통해서만 한다.
 *  - --smoke-test=<폴더> 로 실행하면 대화상자 없이 자동 점검 후 종료 코드로 결과를 알린다.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'marohwp';
const APP_ID = 'com.marohwp.app';
const SCHEME = 'app';
const HOST = 'marohwp';
const ORIGIN = `${SCHEME}://${HOST}`;
const INDEX_URL = `${ORIGIN}/index.html`;

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 860;
const CLOSE_ANSWER_TIMEOUT_MS = 3000;
const SMOKE_TIMEOUT_MS = 120 * 1000;
const MAX_RECENT_FILES = 10;

const DOC_EXTENSIONS = ['hwp', 'hwpx'];
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

// ───────────────────────────── 명령줄 ─────────────────────────────

/** --smoke-test=<폴더> (폴더를 생략하면 임시 폴더) */
function parseSmokeDir(argv) {
  for (const arg of argv) {
    if (arg === '--smoke-test') return path.join(os.tmpdir(), 'marohwp-smoke');
    if (typeof arg === 'string' && arg.startsWith('--smoke-test=')) {
      const value = arg.slice('--smoke-test='.length).replace(/^"(.*)"$/, '$1');
      return value ? path.resolve(value) : path.join(os.tmpdir(), 'marohwp-smoke');
    }
  }
  return null;
}

/**
 * 인자 중에서 실제로 존재하는 첫 번째 .hwp/.hwpx 파일의 절대 경로.
 * 패키지 실행(marohwp.exe 파일)과 개발 실행(electron . 파일) 모두 같은 규칙으로 처리된다:
 * 실행 파일, 앱 경로('.'), 스위치(--...)는 "존재하는 .hwp/.hwpx 파일"이 아니므로 자연히 걸러진다.
 */
function findDocumentArg(args, cwd) {
  for (const raw of args || []) {
    if (typeof raw !== 'string' || raw === '' || raw.startsWith('--')) continue;
    if (!/\.hwpx?$/i.test(raw)) continue;
    const full = path.resolve(cwd || process.cwd(), raw);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* 없는 경로는 무시 */
    }
  }
  return null;
}

const smokeDir = parseSmokeDir(process.argv.slice(1));
const isSmoke = smokeDir !== null;
const startupFile = findDocumentArg(process.argv.slice(1), process.cwd());

// ───────────────────────────── 스모크 테스트 ─────────────────────────────

const smokeStartedAt = Date.now();
const smokeConsole = [];
let smokeFinished = false;
let smokeTimer = null;

function smokeNote(line) {
  if (!isSmoke) return;
  smokeConsole.push(String(line).slice(0, 2000));
  if (smokeConsole.length > 400) smokeConsole.shift();
}

function finishSmoke(result) {
  if (!isSmoke || smokeFinished) return;
  smokeFinished = true;
  if (smokeTimer) clearTimeout(smokeTimer);
  const payload = {
    ok: !!(result && result.ok === true),
    log: result && result.log != null ? String(result.log) : '',
    console: smokeConsole,
    elapsedMs: Date.now() - smokeStartedAt,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  };
  let written = false;
  try {
    fs.mkdirSync(smokeDir, { recursive: true });
    fs.writeFileSync(path.join(smokeDir, 'smoke-result.json'), JSON.stringify(payload, null, 2), 'utf8');
    written = true;
  } catch (err) {
    console.error('[marohwp] 스모크 테스트 결과를 기록하지 못했습니다:', err);
  }
  app.exit(payload.ok && written ? 0 : 1);
}

if (isSmoke) {
  // 실제 사용자 설정/최근 문서를 건드리지 않고, 실행 중인 다른 marohwp 와도 섞이지 않게 한다.
  try {
    fs.mkdirSync(smokeDir, { recursive: true });
    app.setPath('userData', path.join(smokeDir, 'userData'));
  } catch (err) {
    console.error('[marohwp] 스모크 테스트 폴더를 준비하지 못했습니다:', err);
  }
  smokeTimer = setTimeout(() => {
    finishSmoke({
      ok: false,
      log: `스모크 테스트 시간 초과 (${SMOKE_TIMEOUT_MS / 1000}초): 렌더러가 finishSmokeTest 를 호출하지 않았습니다.`,
    });
  }, SMOKE_TIMEOUT_MS);
  process.on('uncaughtException', (err) => {
    finishSmoke({ ok: false, log: `메인 프로세스 오류: ${(err && err.stack) || err}` });
  });
  process.on('unhandledRejection', (err) => {
    finishSmoke({ ok: false, log: `메인 프로세스 오류(처리되지 않은 거부): ${(err && err.stack) || err}` });
  });
}

// ───────────────────────────── app:// 프로토콜 ─────────────────────────────

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** 렌더러 파일 루트. 개발 실행에서만 MAROHWP_DEV_ROOT 로 바꿀 수 있다. */
function rendererRoot() {
  const override = process.env.MAROHWP_DEV_ROOT;
  if (override && !app.isPackaged) return path.resolve(override);
  return path.join(__dirname, '..', 'src');
}

function plainResponse(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** app://marohwp/<경로> → 루트 안의 파일 경로. 루트를 벗어나면 null. */
function resolveRendererFile(root, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  const fromRoot = path.relative(root, file);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    return null;
  }
  return file;
}

async function handleAppRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return plainResponse(400, 'Bad Request');
  }
  if (url.host !== HOST) return plainResponse(404, 'Not Found');
  if (request.method !== 'GET' && request.method !== 'HEAD') return plainResponse(405, 'Method Not Allowed');

  const file = resolveRendererFile(rendererRoot(), url.pathname);
  if (!file) return plainResponse(403, 'Forbidden');

  let data;
  try {
    data = await fsp.readFile(file); // Electron 이 fs 를 패치하므로 app.asar 안의 파일도 읽힌다.
  } catch (err) {
    const missing = err && ['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EINVAL'].includes(err.code);
    return plainResponse(missing ? 404 : 500, missing ? 'Not Found' : 'Internal Error');
  }
  const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return new Response(request.method === 'HEAD' ? null : data, {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(data.length),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ───────────────────────────── 오류 메시지 ─────────────────────────────

/** 사용자에게 그대로 보여 줄 수 있는 (한국어) 오류 */
class UserError extends Error {}

const FS_REASONS = {
  ENOENT: '파일이나 폴더를 찾을 수 없습니다.',
  ENOTDIR: '경로가 올바르지 않습니다.',
  EISDIR: '파일이 아니라 폴더입니다.',
  EACCES: '접근 권한이 없습니다.',
  EPERM: '접근 권한이 없거나 다른 프로그램에서 파일을 사용하고 있습니다.',
  EBUSY: '다른 프로그램에서 파일을 사용하고 있습니다.',
  ENOSPC: '디스크 공간이 부족합니다.',
  EROFS: '읽기 전용 위치라서 쓸 수 없습니다.',
  ENAMETOOLONG: '경로가 너무 깁니다.',
  EMFILE: '열려 있는 파일이 너무 많습니다.',
  EEXIST: '같은 이름의 항목이 이미 있습니다.',
  ERR_FS_FILE_TOO_LARGE: '파일이 너무 큽니다.',
};

function fsUserError(err, filePath, action) {
  if (err instanceof UserError) return err;
  const code = err && err.code;
  const reason = FS_REASONS[code] || (err && err.message) || '알 수 없는 오류입니다.';
  const name = filePath ? `"${path.basename(filePath)}" ` : '';
  return new UserError(`${name}${action} ${reason}${code ? ` (${code})` : ''}`);
}

function requirePathArg(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new UserError('파일 경로가 올바르지 않습니다.');
  }
  return path.resolve(value);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new UserError('저장할 데이터 형식이 올바르지 않습니다.');
}

// ───────────────────────────── 파일 읽기/쓰기 ─────────────────────────────

async function readDocumentFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
    const data = await fsp.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), data };
  } catch (err) {
    throw fsUserError(err, filePath, '파일을 열 수 없습니다.');
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function pathKey(p) {
  const full = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
}

/** 이번 실행에서 이미 .bak 을 만든 경로 (경로당 한 번만 백업) */
const backedUpPaths = new Set();

async function backupOnce(target) {
  const key = pathKey(target);
  if (backedUpPaths.has(key)) return;
  if (!(await pathExists(target))) return; // 새 파일이면 백업할 것이 없다 (다음 저장 때 다시 확인)
  try {
    await fsp.copyFile(target, `${target}.bak`);
    backedUpPaths.add(key);
  } catch (err) {
    // 백업 실패가 저장 자체를 막아서는 안 된다.
    console.warn(`[marohwp] 백업 파일을 만들지 못했습니다: ${target}.bak`, err && err.message);
  }
}

async function renameWithRetry(from, to) {
  const delays = [0, 60, 150, 300, 600];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      // Windows 에서 백신/색인기 등이 잠깐 잡고 있을 때만 다시 시도한다.
      if (!err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
    }
  }
  throw lastError;
}

let tempCounter = 0;

/** 안전 저장: 같은 폴더의 임시 파일에 쓰고 → (기존 파일이 있으면 한 번 .bak 복사) → 이름 바꾸기로 교체 */
async function safeWriteFile(target, buffer, { backup = true } = {}) {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.~${path.basename(target)}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`);
  let handle = null;
  try {
    handle = await fsp.open(temp, 'wx');
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    if (backup) await backupOnce(target);
    await renameWithRetry(temp, target);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temp).catch(() => {});
    throw err;
  }
}

// ───────────────────────────── 최근 문서 ─────────────────────────────

let recentFilesCache = null;

function recentFilesPath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

async function loadRecentFiles() {
  if (recentFilesCache) return recentFilesCache;
  let list = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(recentFilesPath(), 'utf8'));
    const files = Array.isArray(parsed) ? parsed : parsed && parsed.files;
    if (Array.isArray(files)) list = files.filter((f) => typeof f === 'string' && f !== '');
  } catch {
    /* 파일이 없거나 깨졌으면 빈 목록 */
  }
  recentFilesCache = list.slice(0, MAX_RECENT_FILES);
  return recentFilesCache;
}

async function saveRecentFiles(list) {
  recentFilesCache = list;
  try {
    await fsp.mkdir(path.dirname(recentFilesPath()), { recursive: true });
    await safeWriteFile(recentFilesPath(), Buffer.from(JSON.stringify({ files: list }, null, 2), 'utf8'), {
      backup: false,
    });
  } catch (err) {
    console.warn('[marohwp] 최근 문서 목록을 저장하지 못했습니다:', err && err.message);
  }
}

/** 지금 존재하는 파일만 돌려준다. (응답 없는 네트워크 경로 때문에 멈추지 않도록 1.5초까지만 확인) */
async function getRecentFiles() {
  const list = await loadRecentFiles();
  const checks = list.map((file) =>
    Promise.race([pathExists(file), new Promise((resolve) => setTimeout(() => resolve(true), 1500))])
  );
  const exists = await Promise.all(checks);
  return list.filter((_, i) => exists[i]);
}

async function addRecentFile(filePath) {
  const full = requirePathArg(filePath);
  const key = pathKey(full);
  const list = (await loadRecentFiles()).filter((f) => pathKey(f) !== key);
  list.unshift(full);
  await saveRecentFiles(list.slice(0, MAX_RECENT_FILES));
  try {
    app.addRecentDocument(full);
  } catch {
    /* 지원하지 않는 플랫폼 */
  }
}

// ───────────────────────────── 창 ─────────────────────────────

/** webContents.id → 창 상태 */
const windowStates = new Map();
let lastFocusedWindow = null;

function windowIconPath() {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png';
  const full = path.join(__dirname, '..', 'build', file);
  return fs.existsSync(full) ? full : undefined;
}

function composeTitle(state) {
  if (!state.title) return APP_NAME;
  return `${state.title}${state.dirty ? '*' : ''} - ${APP_NAME}`;
}

function liveWindow(win) {
  return win && !win.isDestroyed() ? win : null;
}

function targetWindow() {
  return (
    liveWindow(BrowserWindow.getFocusedWindow()) ||
    liveWindow(lastFocusedWindow) ||
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ||
    null
  );
}

/**
 * 새 창의 크기와 위치.
 *  - 기본 1280x860 이지만 작업 영역(작은 화면, 150% 배율 등)보다 크면 그만큼 줄인다.
 *  - 이미 창이 있으면 그 창에서 조금 비켜서(계단식), 없으면 화면 가운데에 띄운다.
 */
function initialBounds() {
  const base = targetWindow();
  const display = base
    ? screen.getDisplayMatching(base.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = Math.min(WINDOW_WIDTH, area.width);
  const height = Math.min(WINDOW_HEIGHT, area.height);
  let x = area.x + Math.round((area.width - width) / 2);
  let y = area.y + Math.round((area.height - height) / 2);
  if (base && !base.isMaximized() && !base.isMinimized() && !base.isFullScreen()) {
    const from = base.getBounds();
    const fits = (px, py) => px >= area.x && py >= area.y && px + width <= area.x + area.width && py + height <= area.y + area.height;
    if (fits(from.x + 30, from.y + 30)) {
      x = from.x + 30;
      y = from.y + 30;
    } else if (from.x !== area.x || from.y !== area.y) {
      x = area.x; // 더 내려갈 자리가 없으면 왼쪽 위에서 다시 시작
      y = area.y;
    }
  }
  return { x, y, width, height };
}

function forceClose(win, state) {
  state.allowClose = true;
  if (state.closeTimer) clearTimeout(state.closeTimer);
  state.closeTimer = null;
  // destroy(): 페이지의 beforeunload 가 막더라도 반드시 닫힌다.
  if (!win.isDestroyed()) win.destroy();
}

function deliverOpenPath(win, filePath) {
  const state = windowStates.get(win.webContents.id);
  if (!state) return;
  if (state.ready) win.webContents.send('marohwp:open-path', filePath);
  else state.pendingOpenPaths.push(filePath);
}

function createWindow({ openPath } = {}) {
  const win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: windowIconPath(),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--marohwp-app-version=${app.getVersion()}`],
    },
  });
  const contents = win.webContents;
  const state = {
    ready: false, // 렌더러가 rendererReady() 를 호출했는가
    allowClose: false, // 렌더러가 closeWindow() 로 닫기를 확정했는가
    awaitingCloseAnswer: false, // close-requested 를 보냈는데 아직 응답이 없는가
    closeTimer: null,
    pendingOpenPaths: openPath ? [openPath] : [],
    title: '',
    dirty: false,
  };
  windowStates.set(contents.id, state);
  lastFocusedWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('focus', () => {
    lastFocusedWindow = win;
  });

  // ── 닫기 보호: 렌더러가 "저장할까요?"를 직접 묻는다 ──
  win.on('close', (event) => {
    if (state.allowClose || isSmoke || !state.ready || contents.isDestroyed() || contents.isCrashed()) return;
    event.preventDefault();
    const unanswered = state.awaitingCloseAnswer; // 이전 요청에 응답이 없었다 = 두 번째(이상) 시도
    state.awaitingCloseAnswer = true;
    contents.send('marohwp:close-requested');
    if (unanswered && !state.closeTimer) {
      // 렌더러가 멈춘 것으로 보인다. 사용자를 가두지 않도록 3초 뒤 강제로 닫는다.
      state.closeTimer = setTimeout(() => {
        state.closeTimer = null;
        if (state.awaitingCloseAnswer) forceClose(win, state);
      }, CLOSE_ANSWER_TIMEOUT_MS);
    }
  });
  // 닫기를 막지 않는 경우(준비 전/스모크/확정 후)에는 페이지의 beforeunload 도 닫기를 막지 못하게 한다.
  contents.on('will-prevent-unload', (event) => {
    if (state.allowClose || isSmoke || !state.ready) event.preventDefault();
  });
  win.on('closed', () => {
    if (state.closeTimer) clearTimeout(state.closeTimer);
    windowStates.delete(contents.id);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });

  // ── 키: F12 / Ctrl+Shift+I = 개발자 도구. (새로 고침 단축키는 메뉴가 없으므로 존재하지 않는다.
  //    Ctrl+R, F5 는 가로채지 않고 페이지로 그대로 전달한다.) ──
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const plainF12 = key === 'F12' && !input.control && !input.alt && !input.meta && !input.shift;
    const ctrlShiftI = key.toLowerCase() === 'i' && input.control && input.shift && !input.alt && !input.meta;
    if (plainF12 || ctrlShiftI) {
      event.preventDefault();
      contents.toggleDevTools();
    }
  });

  // ── 탐색 제한: 앱 페이지 밖으로 나가지 않는다 (파일을 창에 떨어뜨려도 이동하지 않음) ──
  contents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('did-navigate', () => {
    // 새 문서가 실제로 로드되었을 때만(막힌 탐색은 해당 없음) 렌더러가 rendererReady() 를
    // 다시 호출할 때까지 "준비 전" 상태로 되돌린다.
    state.ready = false;
    state.awaitingCloseAnswer = false;
  });
  contents.on('render-process-gone', (_event, details) => {
    state.ready = false; // 렌더러가 죽었으면 닫기를 막지 않는다.
    if (details && details.reason !== 'clean-exit') {
      finishSmoke({ ok: false, log: `렌더러 프로세스가 비정상 종료되었습니다: ${details.reason}` });
    }
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3(ERR_ABORTED): 우리가 막은 탐색 등
    if (!win.isDestroyed() && !win.isVisible()) win.show();
    finishSmoke({ ok: false, log: `페이지를 불러오지 못했습니다: ${errorDescription} (${errorCode}) ${validatedURL}` });
  });

  if (isSmoke) {
    contents.on('console-message', (event) => {
      smokeNote(`[console:${event.level}] ${event.message} (${event.sourceId || ''}:${event.lineNumber || 0})`);
    });
    contents.on('preload-error', (_event, preloadPath, error) => {
      finishSmoke({ ok: false, log: `preload 오류 (${preloadPath}): ${(error && error.stack) || error}` });
    });
  }

  win.loadURL(INDEX_URL).catch((err) => {
    console.error('[marohwp] 페이지를 불러오지 못했습니다:', err && err.message);
  });
  return win;
}

// ───────────────────────────── IPC ─────────────────────────────

function isTrustedSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    const url = new URL(frame.url);
    return url.protocol === `${SCHEME}:` && url.host === HOST;
  } catch {
    return false;
  }
}

function senderWindow(event) {
  return liveWindow(BrowserWindow.fromWebContents(event.sender));
}

function senderState(event) {
  return windowStates.get(event.sender.id) || null;
}

/** invoke 채널: 결과를 {ok, value} / {ok:false, error} 로 감싸 preload 가 깔끔한 메시지로 reject 하게 한다. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: '허용되지 않은 요청입니다.' };
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (err) {
      if (err instanceof UserError) return { ok: false, error: err.message };
      console.error(`[marohwp] ${channel} 실패:`, err);
      return { ok: false, error: `작업 중 오류가 발생했습니다: ${(err && err.message) || err}` };
    }
  });
}

/** send 채널 (응답 없음) */
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return;
    try {
      fn(event, ...args);
    } catch (err) {
      console.error(`[marohwp] ${channel} 실패:`, err);
    }
  });
}

function filterName(label, extensions) {
  // Windows 대화상자가 확장자 목록을 한 번 더 덧붙이지 않도록 Windows 가 쓰는 표기(세미콜론)와 같게 적는다.
  return `${label} (${extensions.map((ext) => `*.${ext}`).join(';')})`;
}

const FILTER_DOCS = { name: filterName('한글 문서', DOC_EXTENSIONS), extensions: DOC_EXTENSIONS };
const FILTER_HWP = { name: filterName('한글 문서', ['hwp']), extensions: ['hwp'] };
const FILTER_HWPX = { name: filterName('한글 표준 문서', ['hwpx']), extensions: ['hwpx'] };
const FILTER_ALL = { name: '모든 파일 (*.*)', extensions: ['*'] };
const FILTER_PDF = { name: filterName('PDF 문서', ['pdf']), extensions: ['pdf'] };
const FILTER_IMAGES = { name: filterName('그림 파일', Object.keys(IMAGE_MIME)), extensions: Object.keys(IMAGE_MIME) };

function showOpenDialog(win, options) {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(win, options) {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

/** 저장 대화상자의 기본 경로: 확장자를 원하는 것으로 맞춘다. */
function withExtension(filePath, extension, replaceable) {
  const pattern = new RegExp(`\\.(${replaceable.join('|')})$`, 'i');
  return `${filePath.replace(pattern, '')}.${extension}`;
}

/**
 * 저장 대화상자 공통 처리. 돌려주는 경로는 반드시 allowed 확장자 중 하나로 끝난다.
 * 스모크 테스트에서는 대화상자 없이 결과 폴더 안의 경로를 돌려준다.
 */
async function chooseSavePath(win, { title, defaultPath, extension, allowed, replaceable, filters, fallbackName }) {
  const hasDefault = typeof defaultPath === 'string' && defaultPath.trim() !== '';
  const suggested = withExtension(hasDefault ? defaultPath : fallbackName, extension, replaceable || allowed);
  if (isSmoke) return path.join(smokeDir, path.basename(suggested));

  const result = await showSaveDialog(win, { title, defaultPath: suggested, filters });
  if (result.canceled || !result.filePath) return null;
  let chosen = result.filePath;
  const endsOk = allowed.some((ext) => chosen.toLowerCase().endsWith(`.${ext}`));
  if (!endsOk) {
    chosen = `${chosen}.${extension}`;
    // 대화상자가 확인한 이름과 달라졌으므로 덮어쓰기를 직접 확인한다.
    if (await pathExists(chosen)) {
      const question = {
        type: 'warning',
        title: APP_NAME,
        message: `"${path.basename(chosen)}" 파일이 이미 있습니다.`,
        detail: '기존 파일을 바꾸시겠습니까?',
        buttons: ['바꾸기', '취소'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const answer = await (win ? dialog.showMessageBox(win, question) : dialog.showMessageBox(question));
      if (answer.response !== 0) return null;
    }
  }
  return chosen;
}

function registerIpc() {
  listen('marohwp:renderer-ready', (event) => {
    const state = senderState(event);
    if (!state) return;
    state.ready = true;
    const pending = state.pendingOpenPaths.splice(0);
    for (const filePath of pending) event.sender.send('marohwp:open-path', filePath);
  });

  handle('marohwp:open-file-dialog', async (event) => {
    if (isSmoke) return null;
    const result = await showOpenDialog(senderWindow(event), {
      title: '문서 열기',
      properties: ['openFile'],
      filters: [FILTER_DOCS, FILTER_ALL],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
    return readDocumentFile(result.filePaths[0]);
  });

  handle('marohwp:read-file', async (_event, filePath) => readDocumentFile(requirePathArg(filePath)));

  handle('marohwp:save-file-dialog', async (event, options) => {
    const format = options && options.format === 'hwpx' ? 'hwpx' : 'hwp';
    return chooseSavePath(senderWindow(event), {
      title: '다른 이름으로 저장',
      defaultPath: options && options.defaultPath,
      extension: format,
      allowed: DOC_EXTENSIONS,
      filters: format === 'hwpx' ? [FILTER_HWPX, FILTER_HWP] : [FILTER_HWP, FILTER_HWPX],
      fallbackName: '문서1',
    });
  });

  handle('marohwp:write-file', async (_event, filePath, data) => {
    const target = requirePathArg(filePath);
    const buffer = toBuffer(data);
    try {
      await safeWriteFile(target, buffer);
    } catch (err) {
      throw fsUserError(err, target, '파일을 저장할 수 없습니다.');
    }
  });

  handle('marohwp:pick-image-dialog', async (event) => {
    if (isSmoke) return null;
    const result = await showOpenDialog(senderWindow(event), {
      title: '그림 넣기',
      properties: ['openFile'],
      filters: [FILTER_IMAGES],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const mime = IMAGE_MIME[path.extname(filePath).slice(1).toLowerCase()];
    if (!mime) throw new UserError('지원하지 않는 그림 형식입니다. (png, jpg, jpeg, gif, bmp)');
    try {
      return { name: path.basename(filePath), data: await fsp.readFile(filePath), mime };
    } catch (err) {
      throw fsUserError(err, filePath, '그림 파일을 열 수 없습니다.');
    }
  });

  handle('marohwp:open-in-new-window', async (_event, filePath) => {
    const openPath = filePath == null || filePath === '' ? undefined : requirePathArg(filePath);
    createWindow({ openPath });
  });

  listen('marohwp:set-document-state', (event, docState) => {
    const win = senderWindow(event);
    const state = senderState(event);
    if (!win || !state || !docState || typeof docState !== 'object') return;
    state.title = typeof docState.title === 'string' ? docState.title.slice(0, 300) : '';
    state.dirty = !!docState.dirty;
    win.setTitle(composeTitle(state));
    if (process.platform === 'darwin') win.setDocumentEdited(state.dirty);
  });

  // 렌더러가 닫기 요청을 받았다는 응답 (멈추지 않았다는 뜻 → 강제 종료 타이머 해제)
  listen('marohwp:close-answer', (event) => {
    const state = senderState(event);
    if (!state) return;
    state.awaitingCloseAnswer = false;
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = null;
  });

  listen('marohwp:close-window', (event) => {
    const win = senderWindow(event);
    const state = senderState(event);
    if (win && state) forceClose(win, state);
  });

  // 시스템 인쇄 대화상자. 결과는 항상 {ok, error?} 로 돌려준다 (reject 하지 않음).
  handle('marohwp:print', async (event) => {
    if (isSmoke) return { ok: false, error: '스모크 테스트에서는 인쇄하지 않습니다.' };
    return new Promise((resolve) => {
      try {
        event.sender.print({ printBackground: true }, (success, failureReason) => {
          if (success) resolve({ ok: true });
          else if (/cancel/i.test(String(failureReason))) resolve({ ok: false, canceled: true, error: '인쇄를 취소했습니다.' });
          else resolve({ ok: false, error: `인쇄하지 못했습니다: ${failureReason || '알 수 없는 오류'}` });
        });
      } catch (err) {
        resolve({ ok: false, error: `인쇄하지 못했습니다: ${(err && err.message) || err}` });
      }
    });
  });

  handle('marohwp:export-pdf', async (event, options) => {
    const target = await chooseSavePath(senderWindow(event), {
      title: 'PDF로 내보내기',
      defaultPath: options && options.defaultPath,
      extension: 'pdf',
      allowed: ['pdf'],
      replaceable: ['pdf', ...DOC_EXTENSIONS], // 문서 경로를 그대로 넘겨도 "문서.pdf" 가 된다
      filters: [FILTER_PDF],
      fallbackName: '문서1',
    });
    if (!target) return null;
    let pdf;
    try {
      // CSS @page 크기가 있으면 그것을 따르고, 없으면 A4.
      pdf = await event.sender.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' });
    } catch (err) {
      throw new UserError(`PDF를 만들지 못했습니다: ${(err && err.message) || err}`);
    }
    try {
      await safeWriteFile(target, pdf, { backup: false });
    } catch (err) {
      throw fsUserError(err, target, 'PDF 파일을 저장할 수 없습니다.');
    }
    return target;
  });

  handle('marohwp:get-recent-files', async () => getRecentFiles());
  handle('marohwp:add-recent-file', async (_event, filePath) => addRecentFile(filePath));

  listen('marohwp:show-item-in-folder', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath !== '') shell.showItemInFolder(path.resolve(filePath));
  });

  listen('marohwp:open-external', (_event, url) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return;
    }
    if (parsed.protocol === 'https:') shell.openExternal(parsed.href).catch(() => {});
  });

  // 메뉴의 "붙이기": 실제 붙여넣기 동작을 일으켜 편집기의 붙여넣기 처리를 그대로 탄다.
  listen('marohwp:paste', (event) => {
    if (!event.sender.isDestroyed()) event.sender.paste();
  });

  handle('marohwp:get-smoke-test', async () => (isSmoke ? { outDir: smokeDir } : null));
  listen('marohwp:finish-smoke-test', (_event, result) => {
    finishSmoke({ ok: !!(result && result.ok === true), log: result && result.log != null ? String(result.log) : '' });
  });
}

// ───────────────────────────── 시작 ─────────────────────────────

function onSecondInstance(_event, argv, workingDirectory, additionalData) {
  // 두 번째 인스턴스가 직접 찾아 보낸 경로를 우선 사용한다 (Chromium 이 argv 순서를 바꾸는 경우가 있다).
  let filePath = additionalData && typeof additionalData.filePath === 'string' ? additionalData.filePath : null;
  if (!filePath) filePath = findDocumentArg((argv || []).slice(1), workingDirectory);

  const win = targetWindow();
  if (!win) {
    createWindow({ openPath: filePath || undefined });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // 이 창에서 열지, openInNewWindow(path) 로 새 창에서 열지는 렌더러가 정한다.
  if (filePath) deliverOpenPath(win, filePath);
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null); // 메뉴/도구 모음은 페이지가 직접 그린다.

  app.on('window-all-closed', () => {
    if (isSmoke && !smokeFinished) {
      finishSmoke({ ok: false, log: '스모크 테스트가 끝나기 전에 모든 창이 닫혔습니다 (finishSmokeTest 가 호출되지 않음).' });
      return;
    }
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  registerIpc();

  app.whenReady().then(() => {
    protocol.handle(SCHEME, handleAppRequest);
    createWindow({ openPath: startupFile || undefined });
  });
}

// 스모크 테스트는 이미 실행 중인 marohwp 와 무관하게 독립된 프로세스로 돈다.
if (isSmoke) {
  start();
} else if (app.requestSingleInstanceLock({ filePath: startupFile })) {
  app.on('second-instance', onSecondInstance);
  start();
} else {
  app.quit(); // 첫 번째 인스턴스가 second-instance 로 이어받는다.
}
