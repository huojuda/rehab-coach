/* 正向运动学：把三个关节角变成一副火柴人骨架。
   纯数学，不碰 DOM，方便单独测试。
   画布坐标 x 向右、y 向下；角度单位是度，躯干以竖直为基准。 */
(function (root) {
  var D = Math.PI / 180;

  /* 各段长度（以身高为 1 归一化） */
  var LIMB = { torso: 0.34, thigh: 0.30, shin: 0.30, upper: 0.22, fore: 0.20, head: 0.075 };

  function stick(a) {
    var a0 = -90 * D;                    // 躯干方向：向上
    var at = a0 + a.hip * D;             // 大腿：站直 hip=180 → 90°（向下）
    var as = at + (180 - a.knee) * D;    // 小腿：从大腿方向再转 (180-膝角)
    var aa = a0 + a.shoulder * D;        // 上臂

    var H = { x: 0, y: 0 };
    var S = { x: H.x + LIMB.torso * Math.cos(a0), y: H.y + LIMB.torso * Math.sin(a0) };
    var K = { x: H.x + LIMB.thigh * Math.cos(at), y: H.y + LIMB.thigh * Math.sin(at) };
    var A = { x: K.x + LIMB.shin * Math.cos(as), y: K.y + LIMB.shin * Math.sin(as) };
    var E = { x: S.x + LIMB.upper * Math.cos(aa), y: S.y + LIMB.upper * Math.sin(aa) };
    var W = { x: E.x + LIMB.fore * Math.cos(aa), y: E.y + LIMB.fore * Math.sin(aa) };
    var N = { x: S.x + LIMB.head * Math.cos(a0), y: S.y + LIMB.head * Math.sin(a0) };

    return { H: H, S: S, K: K, A: A, E: E, W: W, N: N };
  }

  /* 在时间 t 处取一帧，帧间线性插值，所以 JSON 可以用很低的采样率 */
  function sampleAt(frames, fps, t) {
    if (!frames || !frames.length) return { hip: 180, knee: 180, shoulder: 180 };
    var x = Math.max(0, Math.min(frames.length - 1, t * fps));
    var i = Math.floor(x), u = x - i;
    var a = frames[i], b = frames[Math.min(frames.length - 1, i + 1)];
    return {
      hip: a.hip + (b.hip - a.hip) * u,
      knee: a.knee + (b.knee - a.knee) * u,
      shoulder: a.shoulder + (b.shoulder - a.shoulder) * u
    };
  }

  function inBand(v, lo, hi) { return v >= lo && v <= hi; }

  /* 达标帧占比 */
  function statsFor(frames, metric, lo, hi) {
    var n = 0, hit = 0;
    for (var i = 0; i < frames.length; i++) {
      n++;
      if (inBand(frames[i][metric], lo, hi)) hit++;
    }
    return { total: n, hit: hit, pct: n ? hit / n : 0 };
  }

  /* 按当前阈值数"做到位"的次数：进入达标带算一次，回到带外才能再计
     —— 与实时判定用的是同一套回差思路 */
  function countReps(frames, metric, lo, hi) {
    var inside = false, reps = 0;
    for (var i = 0; i < frames.length; i++) {
      var v = frames[i][metric];
      if (!inside && inBand(v, lo, hi)) { reps++; inside = true; }
      else if (inside && !inBand(v, lo, hi)) { inside = false; }
    }
    return reps;
  }

  /* 同一时刻两副骨架的关节偏差（用来画连线、算总分） */
  function deviation(pa, pb) {
    var keys = ['H', 'S', 'K', 'A', 'E', 'W'];
    var d = {}, sum = 0;
    for (var i = 0; i < keys.length; i++) {
      var p = pa[keys[i]], q = pb[keys[i]];
      var v = Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
      d[keys[i]] = v;
      sum += v;
    }
    return { per: d, mean: sum / keys.length };
  }

  root.FK = {
    LIMB: LIMB, stick: stick, sampleAt: sampleAt,
    statsFor: statsFor, countReps: countReps, deviation: deviation, inBand: inBand
  };
})(typeof window !== 'undefined' ? window : globalThis);
