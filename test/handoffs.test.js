'use strict';

/**
 * 道具交接时窗（prop handoffs）引擎用例：
 *  - analyzeHandoff：两人圆心同时严格位于交接区内部且间距 ≤ reach；
 *    贴边停留 / 仅瞬时触达（零长度相切）不计；跨关键帧相接区间合并；
 *    最短持续 d 过滤与起始时窗 [a, b-d]；起点即在内部按 0 计；
 *    退化交接区（0 宽/高）、缺当事人 / 同一人为不可行；
 *  - normalizeHandoffs：d>0 兜底、reach/尺寸非负、id/name 补全、非法项与
 *    悬空当事人过滤；
 *  - analyzeScene：handoffs 规整与 handoffResults 装配、旧场景缺省兼容；
 *  - 与稠密采样在随机分段轨迹上逐点一致。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function hf(over) {
  return Object.assign({
    id: 'h', aId: 'a', bId: 'b',
    x: 20, y: 20, width: 60, height: 60,
    reach: 20, minDuration: 1
  }, over || {});
}

// 两圆心恒在 (50,50)、(55,50)：间距 5，静止在交接区内部
const still = () => ({
  duration: T,
  performers: [
    { id: 'a', radius: 99, keys: [{ t: 0, x: 50, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 55, y: 50 }] }
  ]
});

test('交接：两圆心静止在区内且够近 → 整段 [0,T]，起始时窗 [0,T-d]（与半径无关）', () => {
  const s = still();
  const r = core.analyzeHandoff(hf({ minDuration: 2 }), s.performers, T);
  assert.equal(r.feasible, true);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 0, 1e-9);
  approx(r.intervals[0][1], T, 1e-7);
  assert.equal(r.windows.length, 1);
  approx(r.windows[0][0], 0, 1e-9);
  approx(r.windows[0][1], T - 2, 1e-7);
  // 半径 99 与判定无关：改触达距离为 4（间距 5 > 4）即全程不可交接
  const none = core.analyzeHandoff(hf({ reach: 4 }), s.performers, T);
  assert.equal(none.intervals.length, 0);
  assert.equal(none.windows.length, 0);
});

test('交接：两人横穿交接区，区间端点为进入 / 离开极限时刻', () => {
  // 甲 (0,50)->(100,50) 速度 100/12；乙 (100,50)->(0,50) 同速；
  // 区内 x∈(20,80)：两人同时在区内 t∈(2.4, 9.6)；
  // 圆心距 |100 - 2·(100/12)t| ≤ 20 ⇔ t∈[4.8, 7.2]
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 12, x: 0, y: 50 }] }
  ];
  const r = core.analyzeHandoff(hf(), performers, T);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 4.8, 1e-9, '进入（间距首次达到 20）');
  approx(r.intervals[0][1], 7.2, 1e-9, '离开（间距再次超过 20）');
  assert.equal(r.windows.length, 1);
  approx(r.windows[0][0], 4.8, 1e-9);
  approx(r.windows[0][1], 6.2, 1e-9, 'b-d = 7.2-1');
});

test('交接：可行区间不足最短持续 d → 不给时窗（但区间仍列出供诊断）', () => {
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 12, x: 0, y: 50 }] }
  ];
  // 可行段长 2.4；d=3 时无起始时窗
  const r = core.analyzeHandoff(hf({ minDuration: 3 }), performers, T);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.windows.length, 0);
  // d 恰等于段长：时窗退化为零宽度起点 [4.8, 4.8]（b-a≥d 含等号）
  const exact = core.analyzeHandoff(hf({ minDuration: 2.4 }), performers, T);
  assert.equal(exact.windows.length, 1);
  approx(exact.windows[0][0], 4.8, 1e-9);
  approx(exact.windows[0][1], 4.8, 1e-9);
});

test('交接：起点两圆心已在区内按 0 秒进入', () => {
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }, { t: 12, x: 200, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 55, y: 50 }, { t: 12, x: 200, y: 50 }] }
  ];
  const r = core.analyzeHandoff(hf(), performers, T);
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 0, 1e-9);
});

test('交接：一人沿交接区边界擦边（圆心恒在边界）整段不计', () => {
  // 甲 y=20 恒在下边界上（开区间 y∈(20,80) 不含边界）
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 30, y: 20 }, { t: 12, x: 70, y: 20 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ];
  const r = core.analyzeHandoff(hf({ reach: 100 }), performers, T);
  assert.deepEqual(r.intervals, []);
  assert.deepEqual(r.windows, []);
});

test('交接：仅瞬时触达（相对轨迹与 reach 圆相切 = 零长度区间）不计', () => {
  // 乙静止 (50,50)；甲水平走 y=70：圆心距最近 20，恰在 t=6 相切（reach=20）
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 70 }, { t: 12, x: 100, y: 70 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ];
  const r = core.analyzeHandoff(hf({ reach: 20, minDuration: 0.1 }), performers, T);
  assert.deepEqual(r.intervals, [], '零长度相切段应被丢弃');
  assert.deepEqual(r.windows, []);
  // 触达距离放宽一点：相切点两侧形成正长度区间
  const wider = core.analyzeHandoff(hf({ reach: 20.5, minDuration: 0.1 }), performers, T);
  assert.equal(wider.intervals.length, 1);
  assert.ok(wider.intervals[0][0] < 6 && wider.intervals[0][1] > 6);
});

test('交接：仅从交接区角点掠过（两坐标同时只在角点开集为空）不计', () => {
  // 甲走 x+y=40 的直线，内部要求 x>20 且 y>20 ⇔ x∈(20,20) 为空；
  // 仅经过角点 (20,20)
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 40 }, { t: 12, x: 40, y: 0 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 25, y: 25 }] }
  ];
  const r = core.analyzeHandoff(hf({ reach: 100 }), performers, T);
  assert.deepEqual(r.intervals, []);
});

test('交接：退化交接区（0 宽 / 0 高）没有内部，永不成立', () => {
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 51, y: 50 }] }
  ];
  assert.deepEqual(core.analyzeHandoff(hf({ width: 0 }), performers, T).intervals, []);
  assert.deepEqual(core.analyzeHandoff(hf({ height: 0 }), performers, T).intervals, []);
});

test('交接：跨关键帧相接区间合并为一段', () => {
  // 同一匀速直线，甲在 t=6（区内点）拆成两帧：结果与单帧一致
  const one = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 12, x: 0, y: 50 }] }
  ];
  const two = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 6, x: 50, y: 50 }, { t: 12, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 6, x: 50, y: 50 }, { t: 12, x: 0, y: 50 }] }
  ];
  const r1 = core.analyzeHandoff(hf(), one, T);
  const r2 = core.analyzeHandoff(hf(), two, T);
  assert.equal(r2.intervals.length, 1, '跨 t=6 关键帧相接的两段合并为一');
  assert.deepEqual(r1.intervals, r2.intervals);
  assert.deepEqual(r1.windows, r2.windows);
});

test('交接：分段往返可产生多个可行区间与多个时窗', () => {
  // 甲在 (50,50) 与 (150,50) 间往返；乙静止 (52,50)；交接区只包住 x≈50 一侧
  const performers = [
    { id: 'a', radius: 0, keys: [
      { t: 0, x: 50, y: 50 }, { t: 3, x: 150, y: 50 },
      { t: 6, x: 50, y: 50 }, { t: 9, x: 150, y: 50 }, { t: 12, x: 50, y: 50 }
    ] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 52, y: 50 }] }
  ];
  const r = core.analyzeHandoff(hf({ reach: 10, minDuration: 0.5 }), performers, T);
  // 起点在内 + 每次返回：t=0 段、约 t=5.4～6.6 段、约 t=11.4～12 段
  assert.ok(r.intervals.length >= 2, '应得到多段可行区间，实际 ' + r.intervals.length);
  assert.ok(r.windows.length >= 1);
  r.intervals.forEach((iv) => assert.ok(iv[1] - iv[0] > 0));
  // 时窗与段一一对应（起点相同）：仅段长 ≥ d 的段产生时窗，宽度 = 段长 - d
  r.windows.forEach((w) => {
    assert.ok(w[1] >= w[0]);
    const iv = r.intervals.find((vv) => Math.abs(vv[0] - w[0]) < 1e-6);
    assert.ok(iv, '时窗起点 ' + w[0] + ' 应有对应可行区间');
    assert.ok(iv[1] - iv[0] >= 0.5 - 1e-6);
    approx(w[1], iv[1] - 0.5, 1e-6, '时窗宽度 = 段长 - d');
  });
});

test('交接：当事人缺失 / 同一人 → feasible=false 且无区间', () => {
  const performers = [{ id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }];
  const missing = core.analyzeHandoff(hf({ bId: 'zzz' }), performers, T);
  assert.equal(missing.feasible, false);
  assert.deepEqual(missing.intervals, []);
  const same = core.analyzeHandoff(hf({ aId: 'a', bId: 'a' }), performers, T);
  assert.equal(same.feasible, false);
});

test('交接：与稠密采样在随机分段轨迹上逐点一致', () => {
  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(Math.random() * 4);
    function mkKeys() {
      const ks = [];
      for (let i = 0; i < n; i++) {
        ks.push({
          t: (T * i) / (n - 1),
          x: Math.random() * 120 - 10,
          y: Math.random() * 120 - 10
        });
      }
      return ks;
    }
    const performers = [
      { id: 'a', radius: Math.random() * 30, keys: mkKeys() },
      { id: 'b', radius: Math.random() * 30, keys: mkKeys() }
    ];
    const zone = {
      x: 10 + Math.random() * 50,
      y: 10 + Math.random() * 50,
      width: 10 + Math.random() * 50,
      height: 10 + Math.random() * 50
    };
    const reach = Math.random() * 40;
    const r = core.analyzeHandoff(hf(Object.assign({ reach: reach, minDuration: 0.01 }, zone)), performers, T);

    const inside = (p, t) => {
      const s = core.stateAt(p.keys, t, p.radius);
      return s.x > zone.x && s.x < zone.x + zone.width &&
        s.y > zone.y && s.y < zone.y + zone.height;
    };
    const okAt = (t) => {
      if (!inside(performers[0], t) || !inside(performers[1], t)) return false;
      const sa = core.stateAt(performers[0].keys, t, 0);
      const sb = core.stateAt(performers[1].keys, t, 0);
      return Math.hypot(sa.x - sb.x, sa.y - sb.y) <= reach + 1e-9;
    };
    const STEP = 0.002;
    const sampled = [];
    let start = null;
    let prev = false;
    for (let t = 0; t <= T + 1e-9; t += STEP) {
      const cur = okAt(t);
      if (cur && !prev) start = t;
      if (!cur && prev) sampled.push([start, t]);
      prev = cur;
    }
    if (prev) sampled.push([start, T]);

    assert.equal(r.intervals.length, sampled.length,
      `trial ${trial}: 区间数 ${r.intervals.length} vs 采样 ${sampled.length}`);
    r.intervals.forEach((iv, i) => {
      assert.ok(Math.abs(iv[0] - sampled[i][0]) < STEP * 3,
        `trial ${trial}: 进入 ${iv[0]} vs 采样 ${sampled[i][0]}`);
      assert.ok(Math.abs(iv[1] - sampled[i][1]) < STEP * 3,
        `trial ${trial}: 离开 ${iv[1]} vs 采样 ${sampled[i][1]}`);
      // 时窗：段长 ≥ d 才出现，宽度 = 段长 - d
      const segLen = iv[1] - iv[0];
      if (segLen >= 0.01 - 1e-6) {
        const w = r.windows.find((ww) => Math.abs(ww[0] - iv[0]) < 1e-6);
        assert.ok(w, `trial ${trial}: 段 ${iv} 应有时窗`);
        approx(w[1], iv[1] - 0.01, 1e-6);
      }
    });
  }
});

// ---------- normalizeHandoffs ----------

test('normalizeHandoffs：d>0 兜底、reach/尺寸非负、缺省 id/name 补全', () => {
  const ids = { a: true, b: true };
  const list = core.normalizeHandoffs([
    { aId: 'a', bId: 'b', x: 1, y: 2, width: -3, height: 4, reach: -5, minDuration: 0 },
    { aId: 'a', bId: 'b', x: 0, y: 0, width: 1, height: 1, reach: 2, minDuration: -3 }
  ], 10, ids);
  assert.equal(list.length, 2);
  assert.equal(list[0].width, 0, '负宽钳零');
  assert.equal(list[0].reach, 0, '负触达钳零');
  assert.equal(list[0].minDuration, 1, '非正 d 兜底为 1');
  assert.equal(list[1].minDuration, 1);
  assert.ok(list[0].id, '缺省 id 自动生成');
  assert.equal(list[0].name, '交接 1');
  assert.equal(list[1].name, '交接 2');
});

test('normalizeHandoffs：非法项 / 悬空当事人 / 同一人过滤，非数组安全返回', () => {
  const ids = { a: true, b: true };
  assert.deepEqual(core.normalizeHandoffs(null, 10, ids), []);
  const list = core.normalizeHandoffs([
    null,
    { aId: 'a', bId: 'b', x: 'x', y: 0, width: 1, height: 1, reach: 1 },
    { aId: 'a', b: 'zzz', x: 0, y: 0, width: 1, height: 1, reach: 1 },
    { aId: 'a', bId: 'a', x: 0, y: 0, width: 1, height: 1, reach: 1 },
    { aId: 'a', bId: 'b', x: 0, y: 0, width: 1, height: 1, reach: 1 }
  ], 10, ids);
  assert.equal(list.length, 1);
});

test('analyzeScene：装配 handoffResults，旧场景（无 handoffs）完全兼容', () => {
  const r = core.analyzeScene({
    duration: T,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ],
    handoffs: [hf({ x: 20, y: 20, width: 60, height: 60, reach: 20, minDuration: 1 })]
  });
  assert.equal(r.handoffs.length, 1);
  assert.equal(r.handoffResults.length, 1);
  assert.equal(r.handoffResults[0].aName, 'a');
  approx(r.handoffResults[0].intervals[0][0], 4.8, 1e-9);
  approx(r.handoffResults[0].windows[0][1], 6.2, 1e-9);

  const old = core.analyzeScene({
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  });
  assert.deepEqual(old.handoffs, []);
  assert.deepEqual(old.handoffResults, []);
});

test('内置样例：中央交接（甲 × 乙）给出约 [4.91, 7.09] 的可行区间与 [4.91, 6.09] 时窗', () => {
  const a = core.analyzeScene(core.builtinScene());
  assert.equal(a.handoffs.length, 1);
  const r = a.handoffResults[0];
  assert.equal(r.feasible, true);
  assert.equal(r.aId, 'p1');
  assert.equal(r.bId, 'p2');
  assert.equal(r.intervals.length, 1);
  approx(r.intervals[0][0], 4.90909091, 1e-6);
  approx(r.intervals[0][1], 7.09090909, 1e-6);
  assert.equal(r.windows.length, 1);
  approx(r.windows[0][0], 4.90909091, 1e-6);
  approx(r.windows[0][1], 6.09090909, 1e-6);
});
