#!/usr/bin/env node
/**
 * 本地一体化开发服务器
 * ------------------------------------------------------------------
 * 一个进程同时提供：
 *   1. 静态资源（index.html / assets / tools），MIME 正确，否则 MediaPipe 会拒绝加载
 *   2. /api/* 路由，直接调用 edge-functions/ 下的真实边缘函数（不复制逻辑）
 *   3. 可选 https：手机摄像头要求安全上下文，局域网 http 不算
 *
 * 用法：
 *   node server.mjs                  # http://localhost:8848
 *   node server.mjs --https          # https://localhost:8443（需先 --gen-cert）
 *   node server.mjs --gen-cert       # 生成自签证书到 .certs/
 *   node server.mjs --port 9000
 *
 * 环境变量从 .env.local 读取（不提交仓库），优先级高于进程环境。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, 'edge-functions', 'api');
const CERT_DIR = path.join(ROOT, '.certs');

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const USE_HTTPS = has('--https');
const GEN_CERT = has('--gen-cert');
const PORT = Number(valOf('--port', USE_HTTPS ? 8443 : 8848));

// ---------------- .env.local ----------------
function loadEnv() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;  // 进程环境优先
  }
}
loadEnv();

// ---------------- MIME ----------------
// .wasm / .mjs 这两条是必须的：类型不对浏览器会直接拒绝
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

const SEC_HEADERS = {
  // MediaPipe 的 wasm 线程需要，缺了在某些浏览器上会退化
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff'
};

// ---------------- 静态资源 ----------------
function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, SEC_HEADERS); return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const abs = path.normalize(path.join(ROOT, rel));
  // 目录穿越防护
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
    res.writeHead(403, SEC_HEADERS); return res.end('Forbidden');
  }

  let st;
  try { st = fs.statSync(abs); } catch {
    res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found: ' + rel);
  }
  if (st.isDirectory()) {
    const idx = path.join(abs, 'index.html');
    if (fs.existsSync(idx)) return serveStatic(req, res, rel.replace(/\/?$/, '/') + 'index.html');
    res.writeHead(403, SEC_HEADERS); return res.end('Directory listing disabled');
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html' || ext === '.htm';

  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': type,
    'Content-Length': st.size,
    // HTML 必须不缓存，否则改完刷新看不到；静态资源可缓存，配合预载提速
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=3600',
    'Last-Modified': st.mtime.toUTCString()
  });

  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

// ---------------- 边缘函数 ----------------
const fnCache = new Map();

async function loadFunction(name) {
  const file = path.join(API_DIR, name + '.js');
  if (!fs.existsSync(file)) return null;
  // 开发期按 mtime 热更新，避免每次改了都要重启
  const mtime = fs.statSync(file).mtimeMs;
  const hit = fnCache.get(name);
  if (hit && hit.mtime === mtime) return hit.fn;
  const mod = await import(pathToFileURL(file).href + '?v=' + mtime);
  const fn = mod.default;
  if (typeof fn !== 'function') throw new Error(`${name}.js 没有 export default function`);
  fnCache.set(name, { mtime, fn });
  return fn;
}

function toRequest(req, port, protocol) {
  const host = req.headers.host || `localhost:${port}`;
  const url = `${protocol}://${host}${req.url}`;
  const method = req.method || 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, String(v));
  }
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function serveApi(req, res, pathname, port, protocol) {
  const name = pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  };

  if (!/^[a-z0-9_-]+$/i.test(name)) return send(400, { ok: false, error: '非法的函数名' });

  let fn;
  try {
    fn = await loadFunction(name);
  } catch (e) {
    return send(500, { ok: false, error: '函数加载失败: ' + e.message });
  }
  if (!fn) {
    return send(404, {
      ok: false,
      error: `没有这个函数: /api/${name}`,
      hint: '可用函数列表见 /api（根路径会返回清单）'
    });
  }

  try {
    const request = toRequest(req, port, protocol);
    const response = await fn({
      request,
      env: process.env,                       // 与 EdgeOne 的 context.env 对齐
      params: {},
      uuid: crypto.randomUUID(),
      waitUntil: () => {}
    });

    const buf = Buffer.from(await response.arrayBuffer());
    const hdrs = {};
    response.headers.forEach((v, k) => { hdrs[k] = v; });
    hdrs['Content-Length'] = buf.length;
    res.writeHead(response.status, hdrs);
    res.end(buf);
  } catch (e) {
    send(500, { ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4) });
  }
}

// /api 根路径列出可用函数，方便自查
function listApis() {
  if (!fs.existsSync(API_DIR)) return [];
  return fs.readdirSync(API_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => f.replace(/\.js$/, ''));
}

// ---------------- 请求分发 ----------------
function handler(port, protocol) {
  return (req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/api' || pathname === '/api/') {
      const body = JSON.stringify({ ok: true, apis: listApis() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (pathname.startsWith('/api/')) {
      return serveApi(req, res, pathname, port, protocol);
    }
    return serveStatic(req, res, pathname);
  };
}

// ---------------- 自签证书 ----------------
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function genCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('证书已存在，跳过生成（如需重建请先删除 .certs/）');
    return { keyPath, certPath };
  }
  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...localIPs().map((ip) => 'IP:' + ip)];
  console.log('生成自签证书，SAN =', sans.join(','));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '825',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=' + sans.join(',')
  ], { stdio: 'inherit' });
  return { keyPath, certPath };
}

// ---------------- 启动 ----------------
function main() {
  if (GEN_CERT) { genCert(); if (!USE_HTTPS) return; }

  let server;
  let protocol = 'http';
  if (USE_HTTPS) {
    const keyPath = path.join(CERT_DIR, 'key.pem');
    const certPath = path.join(CERT_DIR, 'cert.pem');
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      console.error('缺少证书。先运行：node server.mjs --gen-cert --https');
      process.exit(1);
    }
    server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      handler(PORT, 'https')
    );
    protocol = 'https';
  } else {
    server = http.createServer(handler(PORT, 'http'));
  }

  server.listen(PORT, '0.0.0.0', () => {
    const keyOn = (process.env.DEEPSEEK_API_KEY || '').trim().length > 0;
    console.log('');
    console.log('  康复动作教练 · 本地服务器已启动');
    console.log('  ────────────────────────────────────────');
    console.log(`  本机    ${protocol}://localhost:${PORT}/`);
    for (const ip of localIPs()) {
      console.log(`  局域网  ${protocol}://${ip}:${PORT}/`);
    }
    console.log(`  调试    ${protocol}://localhost:${PORT}/index.html?debug=1`);
    console.log(`  函数    ${protocol}://localhost:${PORT}/api   （清单）`);
    console.log('  ────────────────────────────────────────');
    console.log(`  模型密钥 ${keyOn ? '已配置' : '未配置（/api/plan 与 /api/coach 会拒绝服务）'}`);
    console.log(`  可用函数 ${listApis().join(', ') || '(无)'}`);
    if (!USE_HTTPS) {
      console.log('');
      console.log('  提示：手机浏览器需要 https 才能授权摄像头。');
      console.log('        若要用手机，执行 node server.mjs --gen-cert --https');
    }
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\n已停止');
    server.close(() => process.exit(0));
  });
}

main();
