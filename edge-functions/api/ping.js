/**
 * 探针：验证边缘函数是否真的接管了路由。
 *
 * 判定方法（很重要）：访问它必须返回 **JSON**。
 * 若返回 HTML，说明请求静默落到了静态资源上——该平台「静态资源优先于函数路由」，
 * 失败时不报错，所以只能靠响应类型判断。
 *
 * 顺带回传 key_configured，一次请求同时确认两件事：
 * 函数在跑 + 环境变量配好了（不回传密钥本身）。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      CORS
    )
  });
}

export default function onRequest(context) {
  const request = context.request;
  const env = context.env || {};

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const key = (env.DEEPSEEK_API_KEY || '').trim();

  return json({
    ok: true,
    fn: 'ping',
    key_configured: key.length > 0,
    // 只暴露长度区间，不暴露内容
    key_length: key.length,
    model: (env.LLM_MODEL || 'deepseek-flash').trim(),
    method: request.method,
    ts: Date.now()
  });
}
