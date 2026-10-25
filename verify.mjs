#!/usr/bin/env node
/**
 * 本地部署自检
 * ------------------------------------------------------------------
 *   node verify.mjs              快速检查（不调用大模型，2 秒内完成）
 *   node verify.mjs --full       含真实 LLM 调用（约 10 秒，会消耗少量 token）
 *   node verify.mjs --base http://127.0.0.1:8848
 *
 * 退出码：0 全部通过，1 有失败项。
 */

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const bi = argv.indexOf('--base');
const BASE = (bi >= 0 && argv[bi + 1]) ? argv[bi + 1] : 'http://127.0.0.1:8848';

// 自签证书不会被 Node 的 fetch 信任，需要显式放行。
// 仅影响本进程，且只用于本地自检。
if (argv.includes('--insecure') || (BASE.startsWith('https://') && !argv.includes('--strict'))) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (BASE.startsWith('https://')) {
    console.log('\x1b[33m注意：已关闭证书校验（自签证书）。生产环境不要这么做。\x1b[0m');
  }
}

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : ''));
  }
}

async function get(path, opts) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(60000) });
    return { r, ms: Date.now() - t0, err: null };
  } catch (e) {
    return { r: null, ms: Date.now() - t0, err: e.message };
  }
}

function section(t) { console.log('\n' + t); }

async function main() {
  console.log('本地部署自检  ' + BASE + (FULL ? '   [含真实模型调用]' : ''));
  console.log('='.repeat(58));

  // ---------- 1. 服务器 ----------
  section('[1] 服务器可达性');
  const home = await get('/');
  ok('服务器有响应', !home.err, home.err || '');
  if (home.err) {
    console.log('\n服务器没起来。先执行：node server.mjs --port 8848\n');
    process.exit(1);
  }
  ok('首页返回 200', home.r.status === 200, 'HTTP ' + home.r.status);
  const html = await home.r.text();
  ok('首页是 HTML', (home.r.headers.get('content-type') || '').includes('text/html'));
  ok('页面含主程序标记', html.includes('康复动作教练'), '未找到标题');

  // ---------- 2. 静态资源 MIME ----------
  section('[2] 静态资源与 MIME（不对的话浏览器会拒绝加载）');
  for (const [label, p, expect] of [
    ['wasm 运行时', '/assets/mp/wasm/vision_wasm_internal.wasm', 'application/wasm'],
    ['wasm 胶水 js', '/assets/mp/wasm/vision_wasm_internal.js', 'text/javascript'],
    ['ES module', '/assets/mp/vision_bundle.mjs', 'text/javascript'],
    ['full 模型', '/assets/model/pose_landmarker_full.task', 'application/octet-stream'],
    ['动作模板', '/assets/moves/standard-sitstand.json', 'application/json'],
    ['火柴人引擎', '/tools/fk.js', 'text/javascript'],
    ['对比页', '/tools/replay.html', 'text/html']
  ]) {
    const r = await get(p, { method: 'HEAD' });
    const ct = r.r ? (r.r.headers.get('content-type') || '') : '';
    ok(label + ' 可访问且 MIME 正确', !r.err && r.r.status === 200 && ct.includes(expect),
       r.err || ('HTTP ' + (r.r && r.r.status) + ' / ' + ct));
  }

  // ---------- 3. 模型体积 ----------
  section('[3] 模型文件完整性');
  const mf = await get('/assets/model/pose_landmarker_full.task', { method: 'HEAD' });
  const size = mf.r ? Number(mf.r.headers.get('content-length') || 0) : 0;
  ok('full 模型约 9 MB', size > 9_000_000 && size < 10_000_000, (size / 1048576).toFixed(2) + ' MB');
  const ml = await get('/assets/model/pose_landmarker_lite.task', { method: 'HEAD' });
  const size2 = ml.r ? Number(ml.r.headers.get('content-length') || 0) : 0;
  ok('lite 模型存在（回退档）', size2 > 5_000_000, (size2 / 1048576).toFixed(2) + ' MB');

  // ---------- 4. 函数路由 ----------
  section('[4] 边缘函数路由');
  const list = await get('/api');
  const apis = list.r ? (await list.r.json()).apis || [] : [];
  ok('/api 返回函数清单', apis.length > 0, 'HTTP ' + (list.r && list.r.status));
  for (const n of ['ping', 'plan', 'coach']) {
    ok('存在 /api/' + n, apis.includes(n), '实际：' + apis.join(','));
  }

  const ping = await get('/api/ping');
  const pj = ping.r ? await ping.r.json() : {};
  ok('探针返回 JSON 而非 HTML', (ping.r.headers.get('content-type') || '').includes('application/json'));
  ok('密钥已配置', pj.key_configured === true, 'key_configured=' + pj.key_configured +
     (pj.key_configured ? '' : '（检查 .env.local）'));
  ok('探针不泄漏密钥内容', !JSON.stringify(pj).includes('sk-'));
  ok('模型名已设置', typeof pj.model === 'string' && pj.model.length > 0, pj.model);

  // ---------- 5. 参数校验 ----------
  section('[5] 入参校验（不该让坏输入打到大模型）');
  const r400 = await get('/api/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ condition: '' })
  });
  ok('空 condition 被拒 400', r400.r && r400.r.status === 400, 'HTTP ' + (r400.r && r400.r.status));

  const r405 = await get('/api/plan');
  ok('对 /api/plan 用 GET 被拒 405', r405.r && r405.r.status === 405, 'HTTP ' + (r405.r && r405.r.status));

  const r404 = await get('/api/does-not-exist');
  ok('不存在的函数返回 404 JSON', r404.r && r404.r.status === 404 &&
     (r404.r.headers.get('content-type') || '').includes('application/json'));

  const rAct = await get('/api/coach', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'boxing' })
  });
  ok('非法动作名被拒 400', rAct.r && rAct.r.status === 400, 'HTTP ' + (rAct.r && rAct.r.status));

  // ---------- 6. 真实模型调用 ----------
  if (FULL) {
    section('[6] 真实模型调用（约 10 秒）');
    const t0 = Date.now();
    const pl = await get('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: '膝关节术后6周，走路不稳', days: 3, level: 'low' })
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const pj2 = pl.r ? await pl.r.json() : {};
    ok('计划生成成功（' + secs + ' 秒）', pj2.ok === true, JSON.stringify(pj2).slice(0, 160));
    if (pj2.ok) {
      const ids = new Set();
      pj2.plan.days.forEach((d) => d.moves.forEach((m) => ids.add(m.id)));
      const allowed = ['sitstand', 'legraise', 'kneeflex'];
      const bad = [...ids].filter((x) => !allowed.includes(x));
      ok('只出现三个合法动作', bad.length === 0, '越界：' + bad.join(','));
      ok('计划天数正确', pj2.plan.days.length <= 3, '实际 ' + pj2.plan.days.length);
      ok('每天都有动作', pj2.plan.days.every((d) => d.moves.length > 0));
    }

    const co = await get('/api/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sitstand', reps: 7, goal: 10, peak: 152.3, band: [160, 180], durationSec: 118 })
    });
    const cj = co.r ? await co.r.json() : {};
    ok('点评生成成功', cj.ok === true, JSON.stringify(cj).slice(0, 160));
    if (cj.ok) {
      ok('点评引用了真实角度', /152/.test(cj.comment), cj.comment);
      ok('tone 在白名单内', ['encourage', 'steady', 'gentle'].includes(cj.tone), cj.tone);
    }
  } else {
    section('[6] 真实模型调用');
    console.log('  \x1b[90m已跳过（加 --full 启用）\x1b[0m');
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(58));
  if (fail === 0) {
    console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
    console.log('\n打开 http://localhost:8848/ 开始使用；加 ?debug=1 看调试日志。');
  } else {
    console.log(`\x1b[31m${pass} 项通过，${fail} 项失败\x1b[0m`);
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  · ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('自检脚本自身出错：', e);
  process.exit(1);
});
