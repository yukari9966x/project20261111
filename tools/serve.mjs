// 개발/시험용 정적 서버: src/ 를 그대로 제공한다.
//   node tools/serve.mjs [포트] [--samples=<폴더>]
// --samples 로 준 폴더는 /__samples/<파일> 로 읽을 수 있다 (시험 전용).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../src', import.meta.url)));
const port = Number(process.argv[2]) || 8765;
const samplesArg = process.argv.find((a) => a.startsWith('--samples='));
const samples = samplesArg ? resolve(samplesArg.slice(10)) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    let file;
    if (samples && path.startsWith('/__samples/')) file = safeJoin(samples, path.slice(11));
    else {
      if (path.endsWith('/')) path += 'index.html';
      file = safeJoin(root, path);
    }
    if (!file) { res.writeHead(403); res.end(); return; }
    const st = await stat(file);
    if (!st.isFile()) { res.writeHead(404); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
