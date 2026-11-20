// LSN（日志序列号）工具：解析、格式化、段编号换算。
// LSN 格式与 PostgreSQL 一致："高32位/低32位" 的十六进制，例如 "0/3000000"。

export const SEGMENT_SIZE = 0x1000000n; // 16MB，与默认 WAL 段大小一致
const SEGMENTS_PER_LOG_ID = 256n;

export function parseLsn(lsn) {
  if (typeof lsn === 'bigint') return lsn;
  if (typeof lsn === 'number') return BigInt(lsn);
  const parts = String(lsn).split('/');
  if (parts.length !== 2) throw new Error(`非法 LSN: ${lsn}`);
  return (BigInt(`0x${parts[0]}`) << 32n) | BigInt(`0x${parts[1]}`);
}

export function formatLsn(value) {
  const hi = value >> 32n;
  const lo = value & 0xffffffffn;
  return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
}

export function segmentNumber(lsn) {
  return lsn / SEGMENT_SIZE;
}

export function segmentStartLsn(segNo) {
  return segNo * SEGMENT_SIZE;
}

export function segmentEndLsn(segNo) {
  return (segNo + 1n) * SEGMENT_SIZE;
}

// 段文件名：8 位时间线 + 8 位日志号 + 8 位段号（PostgreSQL 风格）
export function segmentName(timeline, segNo) {
  const tli = BigInt(timeline) & 0xffffffffn;
  const log = segNo / SEGMENTS_PER_LOG_ID;
  const seg = segNo % SEGMENTS_PER_LOG_ID;
  const hex = (v) => v.toString(16).toUpperCase().padStart(8, '0');
  return `${hex(tli)}${hex(log)}${hex(seg)}`;
}
