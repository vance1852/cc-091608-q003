import type { CorrectedSample } from "../src/nights.ts";
import { formatIsoWithOffset } from "../src/clock.ts";
import type { SampleBatch, SleepChannel } from "../src/contracts.ts";
import type { StreamFile } from "../src/ingest.ts";

export const OFFSET = 8 * 60; // Asia/Shanghai，分钟
/** 单元测试用的单调时钟原点：mono 1000 ↔ 2026-09-15T22:00:00+08:00，无漂移。 */
export const MONO_EPOCH = Date.parse("2026-09-15T22:00:00+08:00");
export const MONO_ORIGIN = 1000;

export function monoOf(iso: string): number {
  return MONO_ORIGIN + (Date.parse(iso) - MONO_EPOCH);
}

/** 构造一串校正后样本（单批次，等间隔）。 */
export function series(
  channel: SleepChannel,
  startIso: string,
  intervalMillis: number,
  values: Array<number | null>,
  batchId = "b1",
  qualityFlags: string[] = [],
): CorrectedSample[] {
  const start = Date.parse(startIso);
  return values.map((value, k) => ({
    channel,
    batchId,
    monotonicMillis: monoOf(startIso) + k * intervalMillis,
    epochMillis: start + k * intervalMillis,
    wallIso: formatIsoWithOffset(start + k * intervalMillis, OFFSET),
    offsetMinutes: OFFSET,
    extrapolated: false,
    timeUncertaintyMillis: 100,
    value,
    qualityFlags,
    intervalMillis,
  }));
}

/** 构造原始批次（单调时刻与 MONO_EPOCH 对齐）。 */
export function batch(
  channel: SleepChannel,
  batchId: string,
  startIso: string,
  intervalMillis: number,
  values: Array<number | null>,
  qualityFlags: string[] = [],
): SampleBatch {
  return {
    batchId,
    subjectId: "subj-1",
    channel,
    startedAtMonotonicMillis: monoOf(startIso),
    intervalMillis,
    values,
    qualityFlags,
  };
}

/** 用覆盖全部批次的双锚点包装批次为采集流。 */
export function streamFor(batches: SampleBatch[], subjectId = "subj-1"): StreamFile {
  let minMono = Number.POSITIVE_INFINITY;
  let maxMono = 0;
  for (const b of batches) {
    minMono = Math.min(minMono, b.startedAtMonotonicMillis);
    maxMono = Math.max(maxMono, b.startedAtMonotonicMillis + b.values.length * b.intervalMillis);
  }
  const wallOf = (mono: number) =>
    formatIsoWithOffset(MONO_EPOCH + (mono - MONO_ORIGIN), OFFSET);
  return {
    subjectId,
    timezone: "Asia/Shanghai",
    anchors: [
      { monotonicMillis: minMono, wallTime: wallOf(minMono), uncertaintyMillis: 100 },
      { monotonicMillis: maxMono, wallTime: wallOf(maxMono), uncertaintyMillis: 150 },
    ],
    batches,
  };
}

/** 常量数组快捷构造。 */
export function flat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}
