#!/usr/bin/env node
// npm test — test/ 아래의 테스트를 Node 내장 러너(node --test)로 실행한다.
//
// `node --test test/` 는 Node 22 에서 더 이상 폴더를 받지 않으므로(실패함) 파일을 직접 모아서 넘긴다.
// 규칙은 Node 의 기본 규칙과 같다: test/ 아래의 모든 .js / .mjs / .cjs (node_modules, 숨김 폴더 제외).
// test/ 가 없거나 비어 있으면 실패하지 않고 건너뛴다.
//
//   npm test                          전체 실행
//   npm test -- test/foo.test.js      특정 파일만
//   npm test -- --test-name-pattern=저장   node --test 옵션 전달

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

function collect(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const extra = process.argv.slice(2);
const options = extra.filter((arg) => arg.startsWith('-'));
let files = extra.filter((arg) => !arg.startsWith('-'));

if (files.length === 0) {
  files = existsSync(testDir) ? collect(testDir).map((file) => relative(root, file)) : [];
  if (files.length === 0) {
    console.log('test/ 에 테스트 파일이 없습니다. 건너뜁니다.');
    process.exit(0);
  }
}

const result = spawnSync(process.execPath, ['--test', ...options, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
