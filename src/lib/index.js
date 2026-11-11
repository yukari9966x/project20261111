// marohwp 파일 엔진 진입점

import { isCfb } from './cfb.js';
import { isZip } from './zip.js';
import { readHwp } from './hwp/reader.js';
import { readHwpx } from './hwpx/reader.js';
import { writeHwp } from './hwp/writer.js';
import { writeHwpx } from './hwpx/writer.js';
import { convertModel } from './convert.js';
import { blankHwpBytes, blankHwpxBytes } from './templates.js';

export { saveModelFromDoc } from './savemodel.js';
export { docPlainText } from './model.js';

/** 바이트를 읽어 문서 모델을 만든다. */
export async function openDocument(u8, name = '') {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (isCfb(u8)) return readHwp(u8);
  if (isZip(u8)) return readHwpx(u8);
  if (name.toLowerCase().endsWith('.hwp') || (u8.length > 30 && String.fromCharCode(...u8.subarray(0, 17)).startsWith('HWP Document File'))) {
    throw new Error('HWP 5.0 형식이 아닙니다. (아주 오래된 HWP 3.0 문서는 지원하지 않습니다.)');
  }
  throw new Error('HWP 또는 HWPX 문서가 아닙니다.');
}

/** 빈 새 문서 */
export async function newDocument(format = 'hwp') {
  return format === 'hwpx' ? readHwpx(blankHwpxBytes()) : readHwp(blankHwpBytes());
}

/**
 * 저장할 바이트를 만든다.
 * format 이 문서의 원래 형식과 다르면 변환해서 저장한다 (일부 개체는 빠질 수 있다).
 * 반환: { bytes, dropped } — dropped 는 변환 때 빠진 개체 종류별 개수
 */
export async function saveDocument(doc, model, format = doc.format) {
  if (format === doc.format) {
    const bytes = format === 'hwp' ? await writeHwp(doc, model) : await writeHwpx(doc, model);
    return { bytes, dropped: {} };
  }
  const target = await newDocument(format);
  const conv = await convertModel(doc, model, target);
  const bytes = format === 'hwp' ? await writeHwp(target, conv.model) : await writeHwpx(target, conv.model);
  return { bytes, dropped: conv.dropped };
}
