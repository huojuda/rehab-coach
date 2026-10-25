/**
 * POST /api/coach  —— 一次训练结束后的一句点评
 *
 * 入参：{ action, reps, goal, peak, band:[lo,hi], durationSec }
 * 出参：{ ok, comment, next, tone }
 *
 * 与 /api/plan 的分工：plan 管"下次练什么"，coach 管"这次做得怎么样"。
 * 点评必须基于真实数值，不允许编造未提供的指标。
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

const NAMES = {
  sitstand: '坐站转移',
  legraise: '直腿抬高',
  kneeflex: '屈膝'
};

const SYSTEM_PROMPT = [
  '你是居家康复训练的陪伴者，服务对象是正在做康复训练的老年人。',
  '你的任务是根据本次训练的真实数据，给出一句点评和一句下次建议。',
  '',
  '硬性要求：',
  '- 只能引用用户消息里给出的数字，绝不编造任何未提供的指标。',
  '- 语气温和、具体、可执行。不要空泛地夸奖，也不要吓唬人。',
  '- 不出现诊断、用药、治疗建议。若完成度很低或数值异常，只建议"放慢速度、减小幅度，必要时咨询医生"。',
  '- comment 不超过 40 字，next 不超过 30 字。',
  '- tone 取 "encourage"（达标）、"steady"（接近）、"gentle"（差距较大）三者之一。',
  '',
  '严格输出 JSON，不要解释文字：',
  '{"comment":"...","next":"...","tone":"encourage"}'
].join('\n');

async function callLLM(env, userText) {
  const key = (env.DEEPSEEK_API_KEY || '').trim();
  if (!key) throw new Error('服务端未配置 DEEPSEEK_API_KEY');

  const model = (env.LLM_MODEL || 'deepseek-flash').trim();
  const ctrl = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error('模型调用超时（20 秒）')); }, 20000);
  });

  const req = fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 600,
      temperature: 0.5,
      stream: false
    })
  });

  const res = await Promise.race([req, ctrl]);
  if (!res.ok) {
    const t = await res.text();
    throw new Error('模型返回 HTTP ' + res.status + '：' + t.slice(0, 200));
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!content) throw new Error('模型返回内容为空');
  return JSON.parse(content);
}

export default async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: '本接口只接受 POST' }, 405);
  }

  let b;
  try { b = await request.json(); } catch (e) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const id = String(b.action || '');
  if (!NAMES[id]) {
    return json({ ok: false, error: 'action 必须是 sitstand / legraise / kneeflex 之一' }, 400);
  }

  const reps = Math.max(0, parseInt(b.reps, 10) || 0);
  const goal = Math.max(1, parseInt(b.goal, 10) || 10);
  const peak = Number(b.peak);
  const band = Array.isArray(b.band) ? b.band : null;
  const dur = Math.max(0, parseInt(b.durationSec, 10) || 0);

  // 只把真实存在的数字交给模型，缺什么就不说
  const lines = [
    '动作：' + NAMES[id],
    '完成次数：' + reps + ' 次（本组目标 ' + goal + ' 次）',
    '本次最好角度：' + (isFinite(peak) ? peak.toFixed(1) + '°' : '未记录')
  ];
  if (band && band.length === 2) {
    lines.push('达标区间：' + band[0] + '° 到 ' + band[1] + '°');
  }
  if (dur > 0) lines.push('训练时长：' + dur + ' 秒');
  lines.push('请据此点评。');

  try {
    const r = await callLLM(env, lines.join('\n'));
    return json({
      ok: true,
      comment: String(r.comment || '').slice(0, 60),
      next: String(r.next || '').slice(0, 40),
      tone: ['encourage', 'steady', 'gentle'].indexOf(r.tone) >= 0 ? r.tone : 'steady'
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
