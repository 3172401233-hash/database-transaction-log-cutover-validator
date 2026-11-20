# database-transaction-log-cutover-validator

验证事务日志切换、时间线和恢复点连续性。

主库切换后，旧时间线和新时间线的 WAL 可能交叉，归档日志还可能存在短暂缺口。
本工具接收 WAL 段范围、时间线族谱、检查点、提交记录、归档状态、副本复制位置和切换事件，
判断每个目标恢复时间点所需的日志链是否连续，并输出恢复链、缺失日志段、可用恢复点和阻止原因。

> **重要：本工具只做连续性校验，不执行真实恢复。**
> 它不会读取、回放或修改任何真实 WAL 文件，所有判断均基于调用方提供的元数据。

## 环境

- Node.js >= 24.16.0（开发验证使用 v24.16.0）

## 使用

```js
import { validateRecovery } from './index.js';

const result = validateRecovery({
  timelines: [
    { id: 1, parent: null, forkLsn: '0/0' },
    { id: 2, parent: 1, forkLsn: '0/3000000' }, // 切换点
  ],
  switchEvents: [{ from: 1, to: 2, lsn: '0/3000000', time: '2026-11-20T00:10:00Z' }],
  checkpoints: [{ timeline: 1, lsn: '0/1000000' }],
  commits: [
    { timeline: 1, lsn: '0/1500000', time: '2026-11-20T00:05:00Z', xid: 100 },
    { timeline: 2, lsn: '0/3500000', time: '2026-11-20T00:15:00Z', xid: 200 },
  ],
  walSegments: [
    { timeline: 1, segment: 1, archived: true },
    { timeline: 1, segment: 2, archived: true },
    { timeline: 2, segment: 3, archived: true },
  ],
  replicas: [{ name: 'ro-1', replayLsn: '0/4000000' }],
  targets: [{ lsn: '0/3500000' }],
});
```

### 输入字段

- `timelines`：时间线族谱（`id` / `parent` / `forkLsn`）；缺省时由 `switchEvents` 推导
- `switchEvents`：切换事件（`from` / `to` / `lsn` / `time`）
- `checkpoints`：检查点（`timeline` / `lsn` / `time`）
- `commits`：提交记录（`timeline` / `lsn` / `time` / `xid`），重复 LSN 自动去重
- `walSegments`：WAL 段（`timeline` / `segment` 段号或 `startLsn` / `archived` / `partial`）
- `replicas`：只读副本复制位置（`name` / `replayLsn`）
- `targets`：目标恢复点，按 `lsn` 或 `time` 指定

### 输出（每个 target）

- `status`：`recoverable` | `recoverable-at-last-commit` | `blocked`
- `recoveryPoint`：实际可恢复到的提交点（时间线 / LSN / 时间 / xid）
- `chain`：恢复链，逐段列出时间线、段名、LSN 区间和来源（`archive` 或 `replica:<名>`）
- `missingSegments`：缺失日志段及原因
- `availableRecoveryPoints`：目标之前所有可用恢复点
- `blockers` / `warnings`：阻止原因与警告

### 已处理的边界场景

- 切换瞬间的双时间线：子时间线从分叉 LSN 接续，父时间线负责分叉点之前
- 重复 LSN 的提交记录与重复段记录：自动去重合并，优先采用已完整归档的记录
- 日志段部分归档（`partial`）：视为归档缺口，副本追平也不能弥补
- 检查点晚于切换点：日志链只需新时间线上的段
- 检查点位于已分叉的时间线：报告阻止原因
- 只读副本尚未追平：未归档段无法补齐时阻止恢复并给出副本回放位置
- 目标落在未提交事务中间：返回最后一个可恢复提交点（`recoverable-at-last-commit`），不给出不确定结果
- 故障回切：回切产生的新时间线从正确的分叉点回溯，不依赖已废弃的分支

## 测试

```sh
node --test
```
