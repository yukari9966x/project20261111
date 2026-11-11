'use strict';
/*
 * marohwp — preload (sandbox + contextIsolation)
 *
 * 페이지에는 window.marohwp 만 노출한다. 바이너리 데이터는 Uint8Array 로 주고받는다.
 * 실패하는 호출은 사용자에게 그대로 보여 줄 수 있는 한국어 메시지의 Error 로 reject 된다.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function argValue(name) {
  const prefix = `--${name}=`;
  const found = (process.argv || []).find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

/** 메인의 {ok, value} / {ok:false, error} 응답을 값 또는 Error 로 바꾼다. */
async function invoke(channel, ...args) {
  let reply;
  try {
    reply = await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(`작업 중 오류가 발생했습니다: ${(err && err.message) || err}`);
  }
  if (!reply || reply.ok !== true) {
    throw new Error((reply && reply.error) || '알 수 없는 오류가 발생했습니다.');
  }
  return reply.value;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value.constructor === Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** 메인에서 온 {…, data} 의 data 를 순수 Uint8Array 로 맞춘다. */
function withBytes(result) {
  if (result && result.data != null) {
    const bytes = asUint8Array(result.data);
    if (bytes) result.data = bytes;
  }
  return result;
}

function safeCall(callback, ...args) {
  try {
    callback(...args);
    return true;
  } catch (err) {
    console.error('[marohwp] 콜백 오류:', err);
    return false;
  }
}

// ── 메인 → 렌더러 이벤트 ──

const openPathCallbacks = [];
const pendingOpenPaths = []; // 콜백 등록 전에 도착한 경로

ipcRenderer.on('marohwp:open-path', (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath === '') return;
  if (openPathCallbacks.length === 0) {
    pendingOpenPaths.push(filePath);
    return;
  }
  for (const callback of openPathCallbacks) safeCall(callback, filePath);
});

const closeCallbacks = [];

ipcRenderer.on('marohwp:close-requested', () => {
  if (closeCallbacks.length === 0) {
    // 닫기를 확인할 주체가 없으면 그냥 닫는다 (사용자를 가두지 않는다).
    ipcRenderer.send('marohwp:close-window');
    return;
  }
  let handled = false;
  for (const callback of closeCallbacks) {
    if (safeCall(callback)) handled = true;
  }
  // 요청을 받아 처리 중임을 메인에 알린다. (응답이 없으면 메인은 렌더러가 멈춘 것으로 본다.)
  if (handled) ipcRenderer.send('marohwp:close-answer');
});

// ── 페이지에 노출하는 API ──

const api = {
  isDesktop: true,
  appVersion: argValue('marohwp-app-version'),
  platform: process.platform,

  rendererReady() {
    ipcRenderer.send('marohwp:renderer-ready');
  },

  onOpenPath(callback) {
    if (typeof callback !== 'function') return;
    openPathCallbacks.push(callback);
    if (pendingOpenPaths.length > 0) {
      const queued = pendingOpenPaths.splice(0);
      Promise.resolve().then(() => {
        for (const filePath of queued) safeCall(callback, filePath);
      });
    }
  },

  async openFileDialog() {
    return withBytes(await invoke('marohwp:open-file-dialog'));
  },

  async readFile(filePath) {
    return withBytes(await invoke('marohwp:read-file', filePath));
  },

  async saveFileDialog(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return invoke('marohwp:save-file-dialog', {
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      format: opts.format === 'hwpx' ? 'hwpx' : 'hwp',
    });
  },

  async writeFile(filePath, data) {
    let bytes = asUint8Array(data);
    if (!bytes && typeof Blob !== 'undefined' && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    }
    if (!bytes) throw new Error('저장할 데이터 형식이 올바르지 않습니다.');
    await invoke('marohwp:write-file', filePath, bytes);
  },

  async pickImageDialog() {
    return withBytes(await invoke('marohwp:pick-image-dialog'));
  },

  async openInNewWindow(filePath) {
    await invoke('marohwp:open-in-new-window', typeof filePath === 'string' && filePath !== '' ? filePath : undefined);
  },

  setDocumentState(state) {
    const s = state && typeof state === 'object' ? state : {};
    ipcRenderer.send('marohwp:set-document-state', {
      title: typeof s.title === 'string' ? s.title : '',
      dirty: !!s.dirty,
    });
  },

  onCloseRequested(callback) {
    if (typeof callback === 'function') closeCallbacks.push(callback);
  },

  closeWindow() {
    ipcRenderer.send('marohwp:close-window');
  },

  async print() {
    return invoke('marohwp:print');
  },

  async exportPdf(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return invoke('marohwp:export-pdf', {
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
    });
  },

  async getRecentFiles() {
    return invoke('marohwp:get-recent-files');
  },

  async addRecentFile(filePath) {
    await invoke('marohwp:add-recent-file', filePath);
  },

  showItemInFolder(filePath) {
    if (typeof filePath === 'string' && filePath !== '') ipcRenderer.send('marohwp:show-item-in-folder', filePath);
  },

  openExternal(url) {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) ipcRenderer.send('marohwp:open-external', url);
  },

  async getSmokeTest() {
    return invoke('marohwp:get-smoke-test');
  },

  finishSmokeTest(result) {
    const r = result && typeof result === 'object' ? result : {};
    ipcRenderer.send('marohwp:finish-smoke-test', { ok: r.ok === true, log: r.log == null ? '' : String(r.log) });
  },

  /** (추가) 클립보드 내용을 편집 영역에 붙여 넣는다 (메뉴의 "붙이기"). */
  paste() {
    ipcRenderer.send('marohwp:paste');
  },

  /** (추가) 창에 끌어다 놓은 File 의 실제 경로. 경로가 없으면 빈 문자열. */
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('marohwp', api);
