// HWP 5.0 레코드 스트림 (태그·레벨·크기 + 데이터)

import { Writer } from '../bytes.js';

export const TAG = {
  DOCUMENT_PROPERTIES: 16, ID_MAPPINGS: 17, BIN_DATA: 18, FACE_NAME: 19, BORDER_FILL: 20, CHAR_SHAPE: 21,
  TAB_DEF: 22, NUMBERING: 23, BULLET: 24, PARA_SHAPE: 25, STYLE: 26, DOC_DATA: 27,
  DISTRIBUTE_DOC_DATA: 28, COMPATIBLE_DOCUMENT: 30, LAYOUT_COMPATIBILITY: 31,
  PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69, PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71, LIST_HEADER: 72, PAGE_DEF: 73, FOOTNOTE_SHAPE: 74, PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76, TABLE: 77, SHAPE_COMPONENT_LINE: 78, SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80, SHAPE_COMPONENT_ARC: 81, SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83, SHAPE_COMPONENT_OLE: 84, SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86, CTRL_DATA: 87, EQEDIT: 88, SHAPE_COMPONENT_TEXTART: 90,
  FORM_OBJECT: 91, MEMO_SHAPE: 92, MEMO_LIST: 93, CHART_DATA: 95, VIDEO_DATA: 98,
};

/** 레코드 스트림을 평평한 목록으로 읽는다: [{ tag, level, data }] */
export function parseRecords(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = 0;
  while (p + 4 <= u8.length) {
    const h = dv.getUint32(p, true);
    p += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (p + 4 > u8.length) break;
      size = dv.getUint32(p, true);
      p += 4;
    }
    if (p + size > u8.length) {
      // 잘린 레코드: 남은 만큼만 취한다
      size = u8.length - p;
    }
    out.push({ tag, level, data: u8.subarray(p, p + size) });
    p += size;
  }
  return out;
}

/** 평평한 목록 → 레벨 기반 트리. 각 노드: { tag, level, data, children } */
export function buildTree(flat) {
  const roots = [];
  const stack = [];
  for (const r of flat) {
    const node = { tag: r.tag, level: r.level, data: r.data, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function makeRecord(tag, level, data, children = []) {
  return { tag, level, data, children };
}

/** 트리를 다시 바이트로. level 은 트리 깊이가 아니라 노드에 적힌 값을 쓴다. */
export function serializeRecords(nodes, w = new Writer(4096)) {
  const emit = (n) => {
    const size = n.data.length;
    const sz = size >= 0xfff ? 0xfff : size;
    w.u32(((n.tag & 0x3ff) | ((n.level & 0x3ff) << 10) | (sz << 20)) >>> 0);
    if (sz === 0xfff) w.u32(size);
    w.bytes(n.data);
    for (const c of n.children) emit(c);
  };
  for (const n of nodes) emit(n);
  return w;
}

/** 노드와 그 자손 전체의 레벨을 delta 만큼 옮긴 사본을 만든다. */
export function shiftLevel(node, delta) {
  if (!delta) return node;
  return { tag: node.tag, level: node.level + delta, data: node.data, children: node.children.map((c) => shiftLevel(c, delta)) };
}

/** 컨트롤 ID (예: 'tbl ') ↔ u32 */
export function ctrlIdToString(v) {
  return String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
export function ctrlIdFromString(s) {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

// 문단 텍스트 안의 제어 문자 분류
// 'char': 1 코드 유닛, 'inline'/'extended': 8 코드 유닛
export function ctrlCharKind(code) {
  switch (code) {
    case 1: case 2: case 3: case 11: case 12: case 14: case 15: case 16: case 17: case 18: case 21: case 22: case 23:
      return 'extended';
    case 4: case 5: case 6: case 7: case 8: case 9: case 19: case 20:
      return 'inline';
    default:
      return 'char';
  }
}
