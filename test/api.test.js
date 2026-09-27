'use strict';

/**
 * HTTP 接口测试：/api/analyze 接受含关键帧半径 r 的场景并返回规整后的场景；
 * /api/sample 返回的样例携带关键帧半径。使用 server 导出的 express app，零额外依赖。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server/index.js');

const server = app.listen(0);
after(() => server.close());
const PORT = server.address().port;

function postAnalyze(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/analyze',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    }).on('error', reject);
  });
}

const baseScene = (aKeys) => ({
  duration: 10,
  performers: [
    {
      id: 'a', name: '甲', radius: 10,
      keys: aKeys || [{ t: 0, x: 70, y: 0, r: 10 }, { t: 4, x: 70, y: 0, r: 50 }]
    },
    {
      id: 'b', name: '乙', radius: 10,
      keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }]
    }
  ]
});

test('POST /api/analyze：接受关键帧 r 并按可变半径解析（首碰 t=2.5）', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 1);
  const pair = r.json.pairs[0];
  assert.equal(pair.collision, true);
  assert.ok(Math.abs(pair.firstContact - 2.5) < 1e-6);
  assert.ok(Math.abs(pair.radiusSumMin - 20) < 1e-9);
  assert.ok(Math.abs(pair.radiusSumMax - 60) < 1e-9);
});

test('POST /api/analyze：返回最小安全余量 minMargin/minMarginT，pairs 按余量升序', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  const pair = r.json.pairs[0];
  // 甲静止 x=70（r 10→50），乙 r=10 从 0→100：
  // t=7 时距离为 0、半径和恒 60 → 最小安全余量 = −60 @ t=7
  assert.ok(Math.abs(pair.minMargin - (-60)) < 1e-6, `minMargin 应为 -60，实际 ${pair.minMargin}`);
  assert.ok(Math.abs(pair.minMarginT - 7) < 1e-6, `minMarginT 应为 7，实际 ${pair.minMarginT}`);
  // 场景级字段与首对一致
  assert.ok(Math.abs(r.json.minMargin - pair.minMargin) < 1e-12);
  assert.ok(Math.abs(r.json.minMarginT - pair.minMarginT) < 1e-12);
  assert.deepEqual(r.json.minMarginPair, [pair.aId, pair.bId]);
  // 升序
  for (let i = 1; i < r.json.pairs.length; i++) {
    assert.ok(r.json.pairs[i].minMargin >= r.json.pairs[i - 1].minMargin);
  }
});

test('POST /api/analyze：多对场景 pairs 严格按最小安全余量升序', async () => {
  const s = await getJson('/api/sample');
  const r = await postAnalyze({ duration: s.json.duration, performers: s.json.performers });
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 6);
  r.json.pairs.forEach((p) => {
    assert.ok(typeof p.minMargin === 'number' && isFinite(p.minMargin), '每对都带有限 minMargin');
    assert.ok(typeof p.minMarginT === 'number' && isFinite(p.minMarginT), '每对都带有限 minMarginT');
    assert.equal(p.collision, p.minMargin <= 1e-9, '余量 ≤ 0 ⟺ 碰撞');
  });
  for (let i = 1; i < r.json.pairs.length; i++) {
    assert.ok(
      r.json.pairs[i].minMargin >= r.json.pairs[i - 1].minMargin - 1e-12,
      'pairs 按余量升序'
    );
  }
  assert.ok(Math.abs(r.json.minMargin - r.json.pairs[0].minMargin) < 1e-12);
});

test('POST /api/analyze：返回的 scene 中缺省 r 被解析为继承值，显式 r 原样保留', async () => {
  const r = await postAnalyze(baseScene());
  assert.equal(r.status, 200);
  assert.ok(r.json.scene, '响应包含规整后的 scene');
  const [a, b] = r.json.scene.performers;
  assert.equal(a.keys[0].r, 10);
  assert.equal(a.keys[1].r, 50);
  // 乙的关键帧未设置 r -> 全部解析为其当前半径 10
  assert.deepEqual(b.keys.map((k) => k.r), [10, 10]);
});

test('POST /api/analyze：固定半径旧数据（无 r 字段）继续兼容', async () => {
  const old = {
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  };
  const r = await postAnalyze(old);
  assert.equal(r.status, 200);
  const pair = r.json.pairs[0];
  assert.ok(Math.abs(pair.intervals[0][0] - 4) < 1e-7);
  assert.ok(Math.abs(pair.intervals[0][1] - 6) < 1e-7);
});

test('POST /api/analyze：非法关键帧半径被拒绝', async () => {
  const bad = baseScene([{ t: 0, x: 70, y: 0, r: -5 }]);
  const r = await postAnalyze(bad);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /安全半径/);
});

test('GET /api/sample：样例含关键帧半径且可直接回传分析', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  const p3 = s.json.performers.find((p) => p.id === 'p3');
  assert.equal(p3.keys[2].r, 60);
  const r = await postAnalyze({ duration: s.json.duration, performers: s.json.performers });
  assert.equal(r.status, 200);
  assert.equal(r.json.pairCount, 6);
});

test('GET /healthz 正常', async () => {
  const r = await getJson('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

// ---------- 舞台禁入矩形 ----------

test('POST /api/analyze：接受 obstacles 并返回规整后的 obstacles 与 obstacleConflicts', async () => {
  const body = {
    duration: 10,
    obstacles: [
      { name: '高台', x: 40, y: 40, width: 20, height: 20 },
      { id: 'z9', x: 0, y: 0, width: 30, height: 30 }
    ],
    performers: [
      { id: 'a', name: '甲', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
      { id: 'b', name: '乙', radius: 0, keys: [{ t: 0, x: 0, y: 200 }, { t: 10, x: 100, y: 200 }] }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  // 顶层与 scene 内均带规整后的 obstacles
  assert.ok(Array.isArray(r.json.obstacles));
  assert.equal(r.json.obstacles.length, 2);
  assert.deepEqual(r.json.scene.obstacles, r.json.obstacles);
  assert.ok(r.json.obstacles[0].id, '缺省 id 自动补全');
  assert.equal(r.json.obstacles[0].name, '高台');
  assert.equal(r.json.obstacles[1].id, 'z9', '显式 id 保留');
  assert.equal(r.json.obstacles[1].name, '禁入区 2', '缺省 name 补序号');

  // 每人 × 每矩形 = 4 条；甲横穿矩形 1（t∈[4,6]），其余安全
  assert.equal(r.json.obstacleConflicts.length, 4);
  const hit = r.json.obstacleConflicts.find(
    (e) => e.performerId === 'a' && e.obstacleId === r.json.obstacles[0].id);
  assert.equal(hit.conflict, true);
  assert.ok(Math.abs(hit.intervals[0][0] - 4) < 1e-9);
  assert.ok(Math.abs(hit.intervals[0][1] - 6) < 1e-9);
  assert.ok(Math.abs(hit.firstEntry - 4) < 1e-9);
  const safeOnes = r.json.obstacleConflicts.filter((e) => !e.conflict);
  assert.equal(safeOnes.length, 3);
  // 冲突项排在前且按首入升序
  assert.equal(r.json.obstacleConflicts[0].conflict, true);
  assert.ok(Math.abs(r.json.firstObstacleEntry - 4) < 1e-9);
  assert.deepEqual(r.json.firstObstacleConflict, ['a', r.json.obstacles[0].id]);
});

test('POST /api/analyze：无 obstacles 的旧请求保持兼容（空数组与 null 场景字段）', async () => {
  const r = await postAnalyze({
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.obstacles, []);
  assert.deepEqual(r.json.obstacleConflicts, []);
  assert.equal(r.json.firstObstacleEntry, null);
  assert.equal(r.json.firstObstacleConflict, null);
  assert.deepEqual(r.json.scene.obstacles, []);
});

test('POST /api/analyze：非法 obstacles（尺寸/字段）返回 400', async () => {
  const base = {
    duration: 10,
    performers: [
      { name: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { name: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const badWidth = Object.assign({ obstacles: [{ x: 0, y: 0, width: -1, height: 10 }] }, base);
  let r = await postAnalyze(badWidth);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /禁入矩形/);

  const badCoord = Object.assign({ obstacles: [{ x: 'nope', y: 0, width: 1, height: 1 }] }, base);
  r = await postAnalyze(badCoord);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /禁入矩形/);

  const notArray = Object.assign({ obstacles: {} }, base);
  r = await postAnalyze(notArray);
  assert.equal(r.status, 400);
});

test('GET /api/sample：样例携带中央禁入矩形，回传分析得甲、乙侵入', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.obstacles) && s.json.obstacles.length === 1);
  const ob = s.json.obstacles[0];
  ['id', 'name', 'x', 'y', 'width', 'height'].forEach((f) => assert.ok(ob[f] !== undefined));
  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles
  });
  assert.equal(r.status, 200);
  const who = r.json.obstacleConflicts
    .filter((e) => e.conflict)
    .map((e) => e.performerId)
    .sort();
  assert.deepEqual(who, ['p1', 'p2'], '仅横穿者甲、乙侵入中央禁入区');
});

// ---------- 入场口令 cues ----------

test('POST /api/analyze：接受 cues 并返回 cueResults（触发/错过/前序未完成）', async () => {
  const body = {
    duration: 10,
    performers: [
      {
        id: 'a', name: '甲', radius: 5,
        keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }],
        cues: [
          { x: 40, y: 40, width: 20, height: 20, winStart: 4, winEnd: 6 },
          { x: 40, y: 40, width: 20, height: 20, winStart: 6, winEnd: 8 },
          { x: 40, y: 40, width: 20, height: 20, winStart: 8, winEnd: 10 }
        ]
      },
      { id: 'b', name: '乙', radius: 1, keys: [{ t: 0, x: 200, y: 0 }] }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.cueResults));
  assert.equal(r.json.cueResults.length, 1, '无口令者不出现在 cueResults');
  const cr = r.json.cueResults[0];
  assert.equal(cr.performerId, 'a');
  assert.deepEqual(cr.results.map((x) => x.status), ['triggered', 'missed', 'blocked']);
  // 圆心 x=40 -> t=4，窗 [4,6] 含端点，触发
  assert.ok(Math.abs(cr.results[0].triggerT - 4) < 1e-9);
  assert.ok(Array.isArray(cr.results[0].entries));
  assert.ok(Math.abs(cr.results[0].entries[0] - 4) < 1e-9);

  // 规整后的 scene 中口令保留（时窗、id 补全）
  const a = r.json.scene.performers[0];
  assert.equal(a.cues.length, 3);
  a.cues.forEach((c) => {
    ['id', 'x', 'y', 'width', 'height', 'winStart', 'winEnd'].forEach((f) => assert.ok(c[f] !== undefined));
  });
  assert.deepEqual(r.json.scene.performers[1].cues, []);
});

test('POST /api/analyze：cues 缺省时窗补 [0,duration]、非法字段返回 400', async () => {
  const ok = await postAnalyze({
    duration: 10,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }],
        cues: [{ x: 40, y: 40, width: 20, height: 20 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 0, y: 0 }] }
    ]
  });
  assert.equal(ok.status, 200);
  const c = ok.json.scene.performers[0].cues[0];
  assert.equal(c.winStart, 0);
  assert.equal(c.winEnd, 10);

  const base = {
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  const badField = JSON.parse(JSON.stringify(base));
  badField.performers[0].cues = [{ x: 'nope', y: 0, width: 1, height: 1 }];
  let r = await postAnalyze(badField);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /入场口令/);

  const badType = JSON.parse(JSON.stringify(base));
  badType.performers[0].cues = {};
  r = await postAnalyze(badType);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cues 必须为数组/);

  const badWidth = JSON.parse(JSON.stringify(base));
  badWidth.performers[0].cues = [{ x: 0, y: 0, width: -2, height: 1 }];
  r = await postAnalyze(badWidth);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /width 不能为负/);
});

test('GET /api/sample：样例携带入场口令且分析结果为甲三态链路、乙触发', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  const counts = s.json.performers.map((p) => (p.cues || []).length);
  assert.deepEqual(counts.slice(0, 2), [3, 1]);
  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles
  });
  assert.equal(r.status, 200);
  const jia = r.json.cueResults.find((e) => e.performerId === 'p1');
  assert.deepEqual(jia.results.map((x) => x.status), ['triggered', 'missed', 'blocked']);
  const yi = r.json.cueResults.find((e) => e.performerId === 'p2');
  assert.equal(yi.results[0].status, 'triggered');
});

// ---------- 道具交接 handoffs ----------

test('POST /api/analyze：接受 handoffs 并返回 handoffResults（区间 + 起始时窗）', async () => {
  const body = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 5, keys: [{ t: 0, x: 0, y: 50 }, { t: 12, x: 100, y: 50 }] },
      { id: 'b', name: '乙', radius: 5, keys: [{ t: 0, x: 100, y: 50 }, { t: 12, x: 0, y: 50 }] }
    ],
    handoffs: [
      { name: '中央交接', aId: 'a', bId: 'b', x: 20, y: 20, width: 60, height: 60, reach: 20, minDuration: 1 }
    ]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.handoffs));
  assert.equal(r.json.handoffs.length, 1);
  assert.equal(r.json.handoffResults.length, 1);
  const h = r.json.handoffResults[0];
  assert.equal(h.feasible, true);
  assert.equal(h.aName, '甲');
  assert.equal(h.bName, '乙');
  assert.equal(h.intervals.length, 1);
  assert.ok(Math.abs(h.intervals[0][0] - 4.8) < 1e-9);
  assert.ok(Math.abs(h.intervals[0][1] - 7.2) < 1e-9);
  assert.equal(h.windows.length, 1);
  assert.ok(Math.abs(h.windows[0][0] - 4.8) < 1e-9);
  assert.ok(Math.abs(h.windows[0][1] - 6.2) < 1e-9);
  assert.ok(Math.abs(h.firstEntry - 4.8) < 1e-9);
  assert.ok(Math.abs(h.lastExit - 7.2) < 1e-9);

  // 规整后的 scene 中保留交接配置（缺省 id 补全）
  assert.equal(r.json.scene.handoffs.length, 1);
  const sh = r.json.scene.handoffs[0];
  assert.ok(sh.id, '缺省 id 自动补全');
  assert.equal(sh.name, '中央交接');
  ['aId', 'bId', 'x', 'y', 'width', 'height', 'reach', 'minDuration'].forEach((f) => {
    assert.ok(sh[f] !== undefined, `scene.handoffs[0].${f} 存在`);
  });
});

test('POST /api/analyze：handoffs 缺省字段补默认（id/name、d=1），旧请求无 handoffs 兼容', async () => {
  const body = {
    duration: 10,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 100, y: 50 }, { t: 10, x: 0, y: 50 }] }
    ],
    handoffs: [{ aId: 'a', bId: 'b', x: 20, y: 20, width: 60, height: 60, reach: 100 }]
  };
  const r = await postAnalyze(body);
  assert.equal(r.status, 200);
  const sh = r.json.scene.handoffs[0];
  assert.equal(sh.minDuration, 1, '缺省最短持续为 1s');
  assert.ok(sh.id);
  assert.equal(sh.name, '交接 1');
  // 触达 100 时整段同区（t∈[2,8]）即可交接：时窗 [2,7]
  const hr = r.json.handoffResults[0];
  assert.ok(Math.abs(hr.intervals[0][0] - 2) < 1e-9);
  assert.ok(Math.abs(hr.intervals[0][1] - 8) < 1e-9);
  assert.deepEqual(hr.windows, [[2, 7]]);

  const old = await postAnalyze({
    duration: 10,
    performers: [
      { name: 'a', radius: 10, keys: [{ t: 0, x: 0, y: 0 }] },
      { name: 'b', radius: 10, keys: [{ t: 0, x: 50, y: 50 }] }
    ]
  });
  assert.equal(old.status, 200);
  assert.deepEqual(old.json.handoffs, []);
  assert.deepEqual(old.json.handoffResults, []);
  assert.deepEqual(old.json.scene.handoffs, []);
});

test('POST /api/analyze：非法 handoffs 返回 400（字段/类型/当事人/d>0）', async () => {
  const base = {
    duration: 10,
    performers: [
      { id: 'a', radius: 1, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 1, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  };
  async function expect400(handoffs, re, label) {
    const r = await postAnalyze(Object.assign({ handoffs: handoffs }, base));
    assert.equal(r.status, 400, label);
    assert.match(r.json.error, re, label);
  }

  await expect400({}, /handoffs 必须为数组/, 'handoffs 非数组');
  await expect400(
    [{ aId: 'a', bId: 'b', x: 0, y: 0, width: 1, height: 1, reach: 'x' }],
    /reach 必须为有限数/, 'reach 非数字');
  await expect400(
    [{ aId: 'a', bId: 'b', x: 0, y: 0, width: -1, height: 1, reach: 1 }],
    /width\/height 不能为负/, '负宽');
  await expect400(
    [{ aId: 'a', bId: 'b', x: 0, y: 0, width: 1, height: 1, reach: -2 }],
    /触达距离.*不能为负/, '负触达');
  await expect400(
    [{ aId: 'a', bId: 'b', x: 0, y: 0, width: 1, height: 1, reach: 1, minDuration: 0 }],
    /minDuration.*必须为正数/, 'd=0 必须拒绝');
  await expect400(
    [{ aId: 'a', bId: 'a', x: 0, y: 0, width: 1, height: 1, reach: 1 }],
    /不能为同一人/, '同一人');
  await expect400(
    [{ aId: 'a', bId: 'zzz', x: 0, y: 0, width: 1, height: 1, reach: 1 }],
    /不存在的表演者/, '悬空当事人');
  await expect400(
    [{ aId: 'a', x: 0, y: 0, width: 1, height: 1, reach: 1 }],
    /必须指定两名表演者/, '缺少 bId');
});

test('GET /api/sample：样例携带交接配置，分析结果含中央交接时窗', async () => {
  const s = await getJson('/api/sample');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.handoffs) && s.json.handoffs.length === 1);
  const h0 = s.json.handoffs[0];
  ['id', 'name', 'aId', 'bId', 'x', 'y', 'width', 'height', 'reach', 'minDuration']
    .forEach((f) => assert.ok(h0[f] !== undefined));
  const r = await postAnalyze({
    duration: s.json.duration,
    performers: s.json.performers,
    obstacles: s.json.obstacles,
    handoffs: s.json.handoffs
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.handoffResults.length, 1);
  const hr = r.json.handoffResults[0];
  assert.equal(hr.feasible, true);
  assert.equal(hr.windows.length, 1);
  assert.ok(Math.abs(hr.windows[0][0] - 4.90909091) < 1e-6);
  assert.ok(Math.abs(hr.windows[0][1] - 6.09090909) < 1e-6);
});
