// 컨테이너(복합 파일, ZIP), XML, 압축 모듈 시험
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCfb, writeCfb, isCfb } from '../src/lib/cfb.js';
import { readZip, writeZip, isZip } from '../src/lib/zip.js';
import { parseXml, serializeXml } from '../src/lib/xml.js';
import { inflateRaw, inflateRawSync, deflateRaw, deflateStored, crc32 } from '../src/lib/zlibx.js';
import { utf8Encode, utf8Decode, bytesEqual } from '../src/lib/bytes.js';

function pattern(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = (x >> 16) & 0xff; }
  return out;
}

test('복합 파일: 작은/큰 스트림과 저장소를 쓰고 다시 읽는다', () => {
  const entries = [
    { path: 'FileHeader', type: 'stream', data: pattern(256, 1) },
    { path: 'DocInfo', type: 'stream', data: pattern(5000, 2) },
    { path: 'BodyText', type: 'storage' },
    { path: 'BodyText/Section0', type: 'stream', data: pattern(70000, 3) },
    { path: 'BodyText/Section1', type: 'stream', data: pattern(10, 4) },
    { path: 'BinData/BIN0001.png', type: 'stream', data: pattern(4096, 5) },
    { path: '\u0005HwpSummaryInformation', type: 'stream', data: pattern(461, 6) },
    { path: 'Empty', type: 'stream', data: new Uint8Array(0) },
  ];
  const bytes = writeCfb({ entries });
  assert.ok(isCfb(bytes));
  assert.equal(bytes.length % 512, 0);
  const back = readCfb(bytes);
  const map = new Map(back.entries.map((e) => [e.path, e]));
  for (const e of entries) {
    const o = map.get(e.path);
    assert.ok(o, `항목 없음: ${e.path}`);
    assert.equal(o.type, e.type);
    if (e.type === 'stream') assert.ok(bytesEqual(o.data, e.data), `내용 다름: ${e.path}`);
  }
  assert.ok(map.has('BinData'), '경로에서 저장소가 자동으로 만들어져야 한다');
});

test('복합 파일: FAT 섹터가 109개를 넘는 큰 파일 (DIFAT 섹터)', () => {
  const big = pattern(9 * 1024 * 1024, 7);
  const bytes = writeCfb({ entries: [{ path: 'Big', type: 'stream', data: big }, { path: 'Small', type: 'stream', data: pattern(100, 8) }] });
  const back = readCfb(bytes);
  assert.ok(bytesEqual(back.entries.find((e) => e.path === 'Big').data, big));
  assert.ok(bytesEqual(back.entries.find((e) => e.path === 'Small').data, pattern(100, 8)));
});

test('복합 파일이 아닌 입력은 거부한다', () => {
  assert.equal(isCfb(new Uint8Array(600)), false);
  assert.throws(() => readCfb(new Uint8Array(600)));
});

test('ZIP: 쓰고 다시 읽는다 (저장/압축, 한글 이름, 원본 통과)', async () => {
  const text = utf8Encode('가나다라 '.repeat(500));
  const zip = await writeZip([
    { name: 'mimetype', data: utf8Encode('application/hwp+zip'), store: true },
    { name: 'Contents/section0.xml', data: text },
    { name: 'BinData/그림 1.png', data: pattern(3000, 9), store: true },
    { name: 'empty.txt', data: new Uint8Array(0) },
  ]);
  assert.ok(isZip(zip));
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['mimetype', 'Contents/section0.xml', 'BinData/그림 1.png', 'empty.txt']);
  assert.equal(entries[0].method, 0);
  assert.equal(entries[1].method, 8);
  assert.ok(entries[1].compSize < text.length);
  assert.equal(utf8Decode(await entries[0].getData()), 'application/hwp+zip');
  assert.ok(bytesEqual(await entries[1].getData(), text));
  assert.equal(crc32(text), entries[1].crc);
  // 원본 항목을 그대로 통과시켜 다시 쓰기
  const again = await writeZip(entries.map((e) => ({ name: e.name, passthrough: e })));
  const e2 = readZip(again);
  for (let i = 0; i < entries.length; i++) assert.ok(bytesEqual(await e2[i].getData(), await entries[i].getData()));
});

test('압축: 내장/순수 JS 해제가 같은 결과를 낸다', async () => {
  const data = utf8Encode('marohwp '.repeat(4000) + '끝');
  const packed = await deflateRaw(data);
  assert.ok(packed.length < data.length);
  assert.ok(bytesEqual(await inflateRaw(packed), data));
  assert.ok(bytesEqual(inflateRawSync(packed), data));
  assert.ok(bytesEqual(inflateRawSync(deflateStored(data)), data));
  // 끝에 군더더기가 붙어도 읽을 수 있어야 한다
  const junk = new Uint8Array(packed.length + 6);
  junk.set(packed);
  assert.ok(bytesEqual(await inflateRaw(junk), data));
});

test('XML: 구조를 보존해 그대로 다시 쓴다', () => {
  const src = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="urn:a" xmlns:hp="urn:b"><hp:p id="0" a="x &amp; &quot;y&quot;"><hp:run charPrIDRef="3"><hp:t>글 &lt;꺾쇠&gt; &amp; 줄<hp:lineBreak/>바꿈</hp:t></hp:run><hp:run charPrIDRef="0"/><!-- 주석 --></hp:p></hs:sec>';
  const doc = parseXml(src);
  assert.equal(serializeXml(doc), src);
  const p = doc.root.child('p');
  assert.equal(p.get('a'), 'x & "y"');
  assert.equal(p.find('t').text, '글 <꺾쇠> & 줄바꿈');
  assert.equal(p.childrenNamed('run').length, 2);
  assert.throws(() => parseXml('<a><b></a>'));
});
