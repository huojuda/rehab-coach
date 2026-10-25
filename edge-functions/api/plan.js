/**
 * POST /api/plan  —— 生成居家康复周计划
 *
 * 入参：{ condition: string, days: number, level: 'low'|'mid'|'high' }
 * 出参：{ ok, plan: { days: [{ day, focus, moves: [{id,name,sets,reps,tip}] }], note } }
 *
 * 设计要点：
 * 1. 动作集合硬约束为三个已知 id —— 大模型只能组合，不能发明。
 *    否则前端画不出对应示范，等于给出无法执行的计划。
 * 2. 服务端对返回内容做二次校验，剔除任何非白名单 id（防幻觉兜底）。
 * 3. 密钥只在服务端，前端拿不到。
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

// 唯一的动作白名单，与前端 ACTIONS 保持一致
const MOVES = [
  { id: 'sitstand', name: '坐站转移', focus: '下肢力量与平衡' },
  { id: 'legraise', name: '直腿抬高', focus: '股四头肌，膝保持伸直' },
  { id: 'kneeflex', name: '屈膝', focus: '膝关节活动度' }
];

const SYSTEM_PROMPT = [
  '你是居家康复训练计划助手，服务对象是行动不便的老年人。',
  '只能使用下列三个动作，禁止发明任何新动作：',
  MOVES.map(function (m, i) { return (i + 1) + '. id=' + m.id + '（' + m.name + '，' + m.focus + '）'; }).join('；'),
  '',
  '要求：',
  '- 每天安排 2 到 3 个动作，同一动作不要连续两天以上。',
  '- 强度保守：老年人居家训练以安全为先，宁可少也不要过量。',
  '- 每个动作给出 sets（组数）、reps（每组次数）、tip（一句不超过 20 字的要点）。',
  '- focus 用一句话说明当天重点，不超过 15 字。',
  '- 不得出现诊断、用药、治疗建议。若用户描述涉及急性疼痛或术后早期，只在 note 里提醒"请遵医嘱"。',
  '',
  '严格输出以下 JSON，不要任何解释文字：',
  '{"days":[{"day":1,"focus":"...","moves":[{"id":"sitstand","name":"坐站转移","sets":3,"reps":10,"tip":"..."}]}],"note":"..."}'
].join('\n');

async function callLLM(env, userText) {
  const key = (env.DEEPSEEK_API_KEY || '').trim();
  if (!key) throw new Error('服务端未配置 DEEPSEEK_API_KEY');

  const model = (env.LLM_MODEL || 'deepseek-flash').trim();
  const ctrl = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error('模型调用超时（25 秒）')); }, 25000);
  });

  const req = fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.3,
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

// 白名单校验：剔除模型臆造的动作，修正非法数值
function sanitize(plan, maxDays) {
  const byId = {};
  MOVES.forEach(function (m) { byId[m.id] = m; });

  const days = Array.isArray(plan && plan.days) ? plan.days : [];
  const out = [];

  for (let i = 0; i < days.length && out.length < maxDays; i++) {
    const d = days[i] || {};
    const moves = (Array.isArray(d.moves) ? d.moves : [])
      .filter(function (m) { return m && byId[m.id]; })
      .map(function (m) {
        const sets = Math.min(5, Math.max(1, parseInt(m.sets, 10) || 2));
        const reps = Math.min(20, Math.max(3, parseInt(m.reps, 10) || 10));
        return {
          id: m.id,
          name: byId[m.id].name,
          sets: sets,
          reps: reps,
          tip: String(m.tip || '').slice(0, 40)
        };
      });
    if (!moves.length) continue;   // 整天都被滤掉就跳过
    out.push({
      day: out.length + 1,
      focus: String(d.focus || '').slice(0, 30),
      moves: moves
    });
  }
  return { days: out, note: String((plan && plan.note) || '').slice(0, 120) };
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

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const condition = String(body.condition || '').slice(0, 200).trim();
  const days = Math.min(7, Math.max(1, parseInt(body.days, 10) || 3));
  const level = ['low', 'mid', 'high'].indexOf(body.level) >= 0 ? body.level : 'low';

  if (!condition) {
    return json({ ok: false, error: 'condition 不能为空，请描述关节/术后情况或主要困难' }, 400);
  }

  const userText = '患者情况：' + condition +
    '\n计划天数：' + days +
    '\n当前活动水平：' + ({ low: '很少活动', mid: '能短距离行走', high: '日常自理' })[level] +
    '\n请按上面的 JSON 格式输出 ' + days + ' 天计划。';

  try {
    const raw = await callLLM(env, userText);
    const plan = sanitize(raw, days);
    if (!plan.days.length) {
      return json({ ok: false, error: '模型未给出可用计划，请重试或换个描述' }, 502);
    }
    return json({ ok: true, plan: plan, model: (env.LLM_MODEL || 'deepseek-flash').trim() });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
