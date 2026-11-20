import {
  SEGMENT_SIZE,
  parseLsn,
  formatLsn,
  segmentNumber,
  segmentEndLsn,
  segmentName,
} from './lsn.js';

// 事务日志切换校验器。
// 输入 WAL 段、时间线、检查点、提交记录、归档状态、副本复制位置和切换事件，
// 判断每个目标恢复时间点的日志链是否连续。
// 注意：本模块只做连续性校验，不执行真实恢复。

export function validateRecovery(input) {
  const ctx = buildContext(input);
  const targets = (input.targets ?? []).map((target) => evaluateTarget(target, ctx));
  return {
    timelines: [...ctx.timelines.values()].map((t) => ({
      id: t.id,
      parent: t.parent ?? null,
      forkLsn: formatLsn(t.forkLsn),
    })),
    targets,
  };
}

function buildContext(input) {
  const timelines = buildTimelines(input);
  const segments = new Map();
  for (const raw of input.walSegments ?? []) {
    const seg = normalizeSegment(raw);
    const key = `${seg.timeline}:${seg.segNo}`;
    const existing = segments.get(key);
    // 重复段记录：合并，优先采用“已完整归档”的记录
    if (!existing || (seg.archived && !seg.partial && !(existing.archived && !existing.partial))) {
      segments.set(key, seg);
    }
  }
  const commitSeen = new Set();
  const commits = [];
  for (const raw of input.commits ?? []) {
    const lsn = parseLsn(raw.lsn);
    const key = `${raw.timeline}:${lsn}`;
    if (commitSeen.has(key)) continue; // 重复 LSN 提交记录去重
    commitSeen.add(key);
    commits.push({ timeline: raw.timeline, lsn, time: raw.time ?? null, xid: raw.xid ?? null });
  }
  commits.sort((a, b) => (a.lsn < b.lsn ? -1 : a.lsn > b.lsn ? 1 : 0));
  const checkpoints = (input.checkpoints ?? [])
    .map((c) => ({ timeline: c.timeline, lsn: parseLsn(c.lsn), time: c.time ?? null }))
    .sort((a, b) => (a.lsn < b.lsn ? -1 : a.lsn > b.lsn ? 1 : 0));
  const replicas = (input.replicas ?? []).map((r) => ({
    name: r.name ?? 'replica',
    replayLsn: parseLsn(r.replayLsn),
  }));
  return { timelines, segments, commits, checkpoints, replicas };
}

function buildTimelines(input) {
  const timelines = new Map();
  if (input.timelines?.length) {
    for (const t of input.timelines) {
      timelines.set(t.id, {
        id: t.id,
        parent: t.parent ?? null,
        forkLsn: t.forkLsn ? parseLsn(t.forkLsn) : 0n,
      });
    }
  } else {
    // 未显式给出时间线时，从切换事件推导：时间线 1 为根
    timelines.set(1, { id: 1, parent: null, forkLsn: 0n });
    for (const ev of input.switchEvents ?? []) {
      timelines.set(ev.to, {
        id: ev.to,
        parent: ev.from,
        forkLsn: parseLsn(ev.lsn),
      });
    }
  }
  return timelines;
}

function normalizeSegment(raw) {
  const timeline = raw.timeline;
  let segNo;
  if (raw.segment != null) {
    segNo = typeof raw.segment === 'string' ? BigInt(`0x${raw.segment}`) : BigInt(raw.segment);
  } else {
    segNo = segmentNumber(parseLsn(raw.startLsn));
  }
  return {
    timeline,
    segNo,
    name: segmentName(timeline, segNo),
    startLsn: segNo * SEGMENT_SIZE,
    endLsn: segmentEndLsn(segNo),
    archived: raw.archived !== false,
    partial: raw.partial === true,
  };
}

// 从恢复时间线向上回溯到根时间线的祖先链（含自身，自身在前）
function ancestryPath(timelines, id) {
  const path = [];
  const seen = new Set();
  let cur = id;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const tl = timelines.get(cur);
    if (!tl) break;
    path.push(tl);
    cur = tl.parent;
  }
  return path;
}

function evaluateTarget(target, ctx) {
  const blockers = [];
  const warnings = [];
  const targetLsn = target.lsn ? parseLsn(target.lsn) : null;
  const targetTime = target.time ?? null;

  const recoveryCommit = findRecoveryCommit(ctx, target, targetLsn, targetTime);
  if (!recoveryCommit) {
    return {
      target,
      status: 'blocked',
      recoveryPoint: null,
      chain: [],
      missingSegments: [],
      availableRecoveryPoints: [],
      blockers: ['目标时间点之前不存在任何已提交事务，无可恢复提交点'],
      warnings,
    };
  }

  const exact = targetLsn != null && recoveryCommit.lsn === targetLsn;
  const recoveryPoint = {
    timeline: recoveryCommit.timeline,
    lsn: formatLsn(recoveryCommit.lsn),
    time: recoveryCommit.time,
    xid: recoveryCommit.xid,
  };

  const path = ancestryPath(ctx.timelines, recoveryCommit.timeline);
  if (path.length === 0 || !ctx.timelines.has(recoveryCommit.timeline)) {
    blockers.push(`恢复点所在时间线 ${recoveryCommit.timeline} 不在已知时间线族谱中`);
  }

  // 选择不晚于恢复点的最新检查点作为日志链起点
  const checkpoint = latestCheckpointBefore(ctx, recoveryCommit.lsn);
  let startLsn = 0n;
  let checkpointTimeline = null;
  if (checkpoint) {
    startLsn = checkpoint.lsn;
    checkpointTimeline = checkpoint.timeline;
    if (!path.some((n) => n.id === checkpointTimeline)) {
      blockers.push(
        `检查点 ${formatLsn(checkpoint.lsn)} 位于已分叉的时间线 ${checkpointTimeline}，` +
          `不在恢复时间线 ${recoveryCommit.timeline} 的祖先链上`
      );
    }
  } else {
    warnings.push('恢复点之前没有可用检查点，需要从基础备份起校验完整日志链');
  }

  const portions = buildPortions(path, recoveryCommit.lsn, startLsn, checkpointTimeline);
  const { chain, missingSegments } = resolvePortions(portions, ctx, blockers);

  const availableRecoveryPoints = ctx.commits
    .filter((c) => (targetLsn != null ? c.lsn <= targetLsn : targetTime == null || (c.time ?? '') <= targetTime))
    .map((c) => ({ timeline: c.timeline, lsn: formatLsn(c.lsn), time: c.time, xid: c.xid }));

  let status;
  if (blockers.length > 0) {
    status = 'blocked';
  } else if (!exact) {
    // 目标落在未提交事务中间：回退到最后一个可恢复提交点，而不是给出不确定结果
    status = 'recoverable-at-last-commit';
  } else {
    status = 'recoverable';
  }

  return {
    target,
    status,
    recoveryPoint,
    chain,
    missingSegments,
    availableRecoveryPoints,
    blockers,
    warnings,
  };
}

function findRecoveryCommit(ctx, target, targetLsn, targetTime) {
  let best = null;
  for (const c of ctx.commits) {
    const ok = targetLsn != null ? c.lsn <= targetLsn : targetTime == null || (c.time ?? '') <= targetTime;
    if (ok && (!best || c.lsn > best.lsn)) best = c;
  }
  return best;
}

function latestCheckpointBefore(ctx, lsn) {
  let best = null;
  for (const c of ctx.checkpoints) {
    if (c.lsn <= lsn && (!best || c.lsn > best.lsn)) best = c;
  }
  return best;
}

// 沿祖先链把 [起点, 恢复点] 拆成各时间线上的 LSN 区间。
// 切换瞬间子时间线从分叉 LSN 起接续，父时间线负责分叉点之前的部分。
function buildPortions(path, recoveryLsn, startLsn, checkpointTimeline) {
  const portions = [];
  let hi = recoveryLsn;
  for (let i = 0; i < path.length; i += 1) {
    const node = path[i];
    const isLast = checkpointTimeline != null ? node.id === checkpointTimeline : i === path.length - 1;
    let lo = node.forkLsn;
    if (isLast && startLsn > lo) lo = startLsn;
    if (hi > lo) {
      portions.unshift({ timeline: node.id, fromLsn: lo, toLsn: hi });
    }
    if (isLast) break;
    hi = node.forkLsn;
  }
  return portions;
}

function resolvePortions(portions, ctx, blockers) {
  const chain = [];
  const missingSegments = [];
  for (const portion of portions) {
    const firstSeg = segmentNumber(portion.fromLsn);
    const lastSeg = segmentNumber(portion.toLsn - 1n);
    for (let segNo = firstSeg; segNo <= lastSeg; segNo += 1n) {
      const key = `${portion.timeline}:${segNo}`;
      const name = segmentName(portion.timeline, segNo);
      const end = segmentEndLsn(segNo);
      const entry = {
        timeline: portion.timeline,
        segment: name,
        startLsn: formatLsn(segNo * SEGMENT_SIZE),
        endLsn: formatLsn(end),
      };
      const seg = ctx.segments.get(key);
      if (seg?.archived && !seg.partial) {
        chain.push({ ...entry, source: 'archive' });
        continue;
      }
      // 段未归档或部分归档：尝试从只读副本补齐
      const replica = ctx.replicas.find((r) => r.replayLsn >= end);
      if (replica && !seg?.partial) {
        chain.push({ ...entry, source: `replica:${replica.name}` });
        continue;
      }
      let reason;
      if (seg?.partial) {
        reason = '段仅部分归档，存在归档缺口';
      } else if (!seg) {
        reason = '段未出现在归档清单中';
      } else {
        reason = '段尚未归档';
      }
      if (!replica && ctx.replicas.length > 0 && !seg?.partial) {
        const lagging = ctx.replicas.map((r) => `${r.name} 已回放至 ${formatLsn(r.replayLsn)}`).join('，');
        reason += `；只读副本尚未追平（${lagging}，需要 ${formatLsn(end)}）`;
      }
      missingSegments.push({ timeline: portion.timeline, segment: name, reason });
      blockers.push(`时间线 ${portion.timeline} 的 WAL 段 ${name} 不可用于恢复链：${reason}`);
    }
  }
  return { chain, missingSegments };
}
