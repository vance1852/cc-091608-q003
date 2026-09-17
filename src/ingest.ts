/**
 * 数据流解析与校验：把 fixtures/overnight-stream.json 这样的原始 JSON
 * 变成带类型的 OvernightStream。校验失败时抛出带中文说明的错误，
 * 避免坏数据静默进入分析管线。
 */

import type { ClockAnchor, SampleBatch, SleepChannel } from "./contracts.js";

export interface OvernightStream {
  subjectId: string;
  timeZone: string;
  anchors: ClockAnchor[];
  batches: SampleBatch[];
}

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<SleepChannel>([
  "spo2",
  "pulse-wave",
  "actigraphy",
]);

function fail(message: string): never {
  throw new Error(`数据流格式非法: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${path} 必须是非空字符串`);
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} 必须是有限数值`);
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`);
  return value;
}

function parseAnchor(raw: unknown, index: number): ClockAnchor {
  const record = asRecord(raw, `anchors[${index}]`);
  const uncertainty = expectFiniteNumber(
    record.uncertaintyMillis,
    `anchors[${index}].uncertaintyMillis`,
  );
  if (uncertainty < 0) fail(`anchors[${index}].uncertaintyMillis 不能为负`);
  return {
    monotonicMillis: expectFiniteNumber(
      record.monotonicMillis,
      `anchors[${index}].monotonicMillis`,
    ),
    wallTime: expectString(record.wallTime, `anchors[${index}].wallTime`),
    uncertaintyMillis: uncertainty,
  };
}

function parseBatch(raw: unknown, index: number, streamSubjectId: string): SampleBatch {
  const path = `batches[${index}]`;
  const record = asRecord(raw, path);
  const channel = expectString(record.channel, `${path}.channel`);
  if (!KNOWN_CHANNELS.has(channel)) fail(`${path}.channel 未知: ${channel}`);
  const intervalMillis = expectFiniteNumber(record.intervalMillis, `${path}.intervalMillis`);
  if (intervalMillis <= 0) fail(`${path}.intervalMillis 必须为正数`);
  const values = expectArray(record.values, `${path}.values`).map((value, valueIndex) => {
    if (value === null) return null;
    return expectFiniteNumber(value, `${path}.values[${valueIndex}]`);
  });
  if (values.length === 0) fail(`${path}.values 不能为空`);
  const flagsRaw = record.qualityFlags === undefined ? [] : expectArray(record.qualityFlags, `${path}.qualityFlags`);
  const qualityFlags = flagsRaw.map((flag, flagIndex) =>
    expectString(flag, `${path}.qualityFlags[${flagIndex}]`),
  );
  const batchSubject =
    record.subjectId === undefined
      ? streamSubjectId
      : expectString(record.subjectId, `${path}.subjectId`);
  if (batchSubject !== streamSubjectId) {
    fail(`${path}.subjectId (${batchSubject}) 与数据流主体 (${streamSubjectId}) 不一致`);
  }
  return {
    batchId: expectString(record.batchId, `${path}.batchId`),
    subjectId: batchSubject,
    channel: channel as SleepChannel,
    startedAtMonotonicMillis: expectFiniteNumber(
      record.startedAtMonotonicMillis,
      `${path}.startedAtMonotonicMillis`,
    ),
    intervalMillis,
    values,
    qualityFlags,
  };
}

export function parseOvernightStream(raw: unknown): OvernightStream {
  const record = asRecord(raw, "顶层");
  const subjectId = expectString(record.subjectId, "subjectId");
  const timeZone = expectString(record.timezone, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    fail(`无法识别的时区: ${timeZone}`);
  }
  const anchors = expectArray(record.anchors, "anchors").map(parseAnchor);
  if (anchors.length === 0) fail("anchors 至少需要一个同步锚点");
  const batches = expectArray(record.batches, "batches").map((batch, index) =>
    parseBatch(batch, index, subjectId),
  );
  const seenBatchIds = new Set<string>();
  for (const batch of batches) {
    if (seenBatchIds.has(batch.batchId)) fail(`批次号重复: ${batch.batchId}`);
    seenBatchIds.add(batch.batchId);
  }
  return { subjectId, timeZone, anchors, batches };
}
