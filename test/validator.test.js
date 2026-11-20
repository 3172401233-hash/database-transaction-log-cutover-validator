import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecovery } from '../src/validator.js';
import { segmentName } from '../src/lsn.js';

// 段速查：seg(1) 表示段号 1，覆盖 LSN [0/1000000, 0/2000000)
function seg(timeline, segNo, extra = {}) {
  return { timeline, segment: segNo, archived: true, ...extra };
}

const SWITCH_LSN = '0/3000000'; // 时间线 1 -> 2 的切换点

function baseInput(overrides = {}) {
  return {
    timelines: [
      { id: 1, parent: null, forkLsn: '0/0' },
      { id: 2, parent: 1, forkLsn: SWITCH_LSN },
    ],
    switchEvents: [{ from: 1, to: 2, lsn: SWITCH_LSN, time: '2026-11-20T00:10:00Z' }],
    checkpoints: [{ timeline: 1, lsn: '0/1000000', time: '2026-11-20T00:00:00Z' }],
    commits: [
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
      { timeline: 2, lsn: '0/3500000', time: '2026-11-20T00:15:00Z', xid: 200 },
    ],
    walSegments: [seg(1, 1), seg(1, 2), seg(2, 3)],
    replicas: [],
    targets: [],
    ...overrides,
  };
}

test('正常切换：恢复链跨时间线连续，目标可恢复', () => {
  const result = validateRecovery(baseInput({ targets: [{ lsn: '0/3500000' }] }));
  const [r] = result.targets;
  assert.equal(r.status, 'recoverable');
  assert.deepEqual(r.recoveryPoint, {
    timeline: 2,
    lsn: '0/3500000',
    time: '2026-11-20T00:15:00Z',
    xid: 200,
  });
  assert.deepEqual(
    r.chain.map((c) => [c.timeline, c.segment, c.source]),
    [
      [1, segmentName(1, 1n), 'archive'],
      [1, segmentName(1, 2n), 'archive'],
      [2, segmentName(2, 3n), 'archive'],
    ]
  );
  assert.deepEqual(r.missingSegments, []);
  assert.deepEqual(r.blockers, []);
});

test('时间线分叉：按时间目标解析到新时间线上的恢复点并回溯父时间线', () => {
  const result = validateRecovery(baseInput({ targets: [{ time: '2026-11-20T00:20:00Z' }] }));
  const [r] = result.targets;
  assert.equal(r.status, 'recoverable-at-last-commit');
  assert.equal(r.recoveryPoint.timeline, 2);
  assert.equal(r.recoveryPoint.lsn, '0/3500000');
  assert.equal(r.chain.at(-1).timeline, 2);
  assert.equal(r.chain[0].timeline, 1);
});

test('重复记录：重复 LSN 提交与重复段记录被去重合并', () => {
  const input = baseInput({
    commits: [
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 }, // 重复
      { timeline: 2, lsn: '0/3500000', time: '2026-11-20T00:15:00Z', xid: 200 },
    ],
    walSegments: [
      seg(1, 1, { archived: false }), // 先到的重复记录：未归档
      seg(1, 1), // 后到的重复记录：已归档，应被采用
      seg(1, 2),
      seg(2, 3),
    ],
    targets: [{ lsn: '0/3500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'recoverable');
  assert.equal(r.availableRecoveryPoints.length, 2);
  assert.equal(r.chain.filter((c) => c.segment === segmentName(1, 1n)).length, 1);
});

test('归档缺口：缺失段被报告并阻止恢复', () => {
  const input = baseInput({
    walSegments: [seg(1, 1), seg(2, 3)], // 时间线 1 的段 2 缺失
    targets: [{ lsn: '0/3500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'blocked');
  assert.deepEqual(
    r.missingSegments.map((m) => m.segment),
    [segmentName(1, 2n)]
  );
  assert.ok(r.blockers.some((b) => b.includes(segmentName(1, 2n))));
});

test('部分归档：段只归档了一部分视为缺口', () => {
  const input = baseInput({
    walSegments: [seg(1, 1), seg(1, 2, { partial: true }), seg(2, 3)],
    replicas: [{ name: 'ro-1', replayLsn: '0/FFFFFF0' }], // 副本已追平也不能弥补部分归档
    targets: [{ lsn: '0/3500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'blocked');
  assert.ok(r.missingSegments[0].reason.includes('部分归档'));
});

test('故障回切：回切产生的时间线 3 从时间线 1 分叉，不依赖时间线 2', () => {
  const input = baseInput({
    timelines: [
      { id: 1, parent: null, forkLsn: '0/0' },
      { id: 2, parent: 1, forkLsn: SWITCH_LSN },
      { id: 3, parent: 1, forkLsn: '0/2800000' }, // 故障后回切，分叉点在切换前
    ],
    switchEvents: [
      { from: 1, to: 2, lsn: SWITCH_LSN, time: '2026-11-20T00:10:00Z' },
      { from: 1, to: 3, lsn: '0/2800000', time: '2026-11-20T00:30:00Z' },
    ],
    commits: [
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
      { timeline: 3, lsn: '0/3200000', time: '2026-11-20T00:35:00Z', xid: 300 },
    ],
    walSegments: [seg(1, 1), seg(1, 2), seg(3, 2), seg(3, 3)],
    targets: [{ lsn: '0/3200000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'recoverable');
  assert.equal(r.recoveryPoint.timeline, 3);
  assert.deepEqual(
    r.chain.map((c) => c.timeline),
    [1, 1, 3, 3]
  );
});

test('检查点晚于切换点：日志链只需新时间线上的段', () => {
  const input = baseInput({
    checkpoints: [{ timeline: 2, lsn: '0/3200000', time: '2026-11-20T00:12:00Z' }],
    walSegments: [seg(2, 3)], // 不需要任何时间线 1 的段
    targets: [{ lsn: '0/3500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'recoverable');
  assert.deepEqual(
    r.chain.map((c) => [c.timeline, c.segment]),
    [[2, segmentName(2, 3n)]]
  );
});

test('只读副本尚未追平：未归档段无法补齐，恢复被阻止', () => {
  const input = baseInput({
    commits: [
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
      { timeline: 2, lsn: '0/4500000', time: '2026-11-20T00:15:00Z', xid: 200 },
    ],
    walSegments: [seg(1, 1), seg(1, 2), seg(2, 3)], // 段 4 未归档
    replicas: [{ name: 'ro-1', replayLsn: '0/4000000' }], // 副本只回放到段 4 起点
    targets: [{ lsn: '0/4500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'blocked');
  assert.ok(r.blockers.some((b) => b.includes('尚未追平')));
  assert.deepEqual(
    r.missingSegments.map((m) => m.segment),
    [segmentName(2, 4n)]
  );
});

test('只读副本已追平：未归档段可从副本补齐', () => {
  const input = baseInput({
    commits: [
      { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
      { timeline: 2, lsn: '0/4500000', time: '2026-11-20T00:15:00Z', xid: 200 },
    ],
    walSegments: [seg(1, 1), seg(1, 2), seg(2, 3)],
    replicas: [{ name: 'ro-1', replayLsn: '0/5000000' }],
    targets: [{ lsn: '0/4500000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'recoverable');
  assert.equal(r.chain.at(-1).source, 'replica:ro-1');
});

test('目标落在未提交事务中间：返回最后一个可恢复提交点', () => {
  const input = baseInput({ targets: [{ lsn: '0/3600000' }] }); // 最后一个提交在 0/3500000
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'recoverable-at-last-commit');
  assert.equal(r.recoveryPoint.lsn, '0/3500000');
  assert.equal(r.recoveryPoint.xid, 200);
});

test('目标之前没有任何已提交事务：阻止并说明原因', () => {
  const input = baseInput({ targets: [{ lsn: '0/0500000' }] });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'blocked');
  assert.equal(r.recoveryPoint, null);
  assert.ok(r.blockers.some((b) => b.includes('已提交事务')));
});

test('检查点位于分叉时间线：报告阻止原因', () => {
  const input = baseInput({
    timelines: [
      { id: 1, parent: null, forkLsn: '0/0' },
      { id: 2, parent: 1, forkLsn: SWITCH_LSN },
      { id: 3, parent: 1, forkLsn: '0/2800000' },
    ],
    checkpoints: [{ timeline: 2, lsn: '0/3100000' }], // 恢复点在时间线 3，检查点却在时间线 2
    commits: [{ timeline: 3, lsn: '0/3200000', time: '2026-11-20T00:35:00Z', xid: 300 }],
    walSegments: [seg(3, 3)],
    targets: [{ lsn: '0/3200000' }],
  });
  const [r] = validateRecovery(input).targets;
  assert.equal(r.status, 'blocked');
  assert.ok(r.blockers.some((b) => b.includes('已分叉的时间线')));
});
