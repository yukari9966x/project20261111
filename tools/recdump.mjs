// 개발용: HWP 레코드 트리를 16진수로 출력한다.  node tools/recdump.mjs <파일.hwp> [DocInfo|Section0] [최대바이트]
import { readFileSync } from 'node:fs';
import { readCfb } from '../src/lib/cfb.js';
import { inflateRaw } from '../src/lib/zlibx.js';
import { parseRecords, TAG } from '../src/lib/hwp/records.js';
import { parseFileHeader } from '../src/lib/hwp/reader.js';

const file = process.argv[2];
const which = process.argv[3] || 'Section0';
const maxBytes = Number(process.argv[4] || 64);
const cfb = readCfb(new Uint8Array(readFileSync(file)));
const fh = parseFileHeader(cfb.entries.find((e) => e.path === 'FileHeader').data);
console.log('version', fh.versionText, 'flags', fh.flags.toString(16));
for (const e of cfb.entries) if (e.type === 'stream') console.log('  stream', JSON.stringify(e.path), e.data.length);
const entry = cfb.entries.find((e) => e.path === which || e.path === `BodyText/${which}`);
const data = fh.compressed ? await inflateRaw(entry.data) : entry.data;
const names = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));
const filter = process.argv[5] ? new Set(process.argv[5].split(',')) : null;
let n = 0;
for (const r of parseRecords(data)) {
  const name = names[r.tag] || `TAG${r.tag}`;
  if (filter && !filter.has(name)) continue;
  const hex = Array.from(r.data.subarray(0, maxBytes)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`${'  '.repeat(r.level)}${name} L${r.level} (${r.data.length}) ${hex}${r.data.length > maxBytes ? ' …' : ''}`);
  if (++n > 400) break;
}
