/**
 * 采样序列与佩戴分段。
 *
 * 把同一通道的采样批次按单调时钟拼成连续序列（重叠部分裁剪并记录），
 * 再按“采样间隔是否断裂”切成佩戴分段；中途摘下设备会形成段间缺口，
 * 重新佩戴则产生新分段，但两者仍属同一夜次（夜次划分见 nights.ts）。
 *
 * 这里同时产出“不可判读区间”的原始素材：低灌注、信号丢失、数据缺口、
 * 采样间隔过长、技师排除——这些区间不参与任何指数计算。
 */

import type { SampleBatch, SleepChannel } from "./contracts.js";

/** 使样本不可用于指数计算的批次级质量标记。 */
export const INDEX_INVALIDATING_FLAGS: ReadonlySet<string> = new Set([
  "low-perfusion",
  "off-wrist",
  "sensor-detached",
  "motion-corrupted",
]);

export type UninterpretableReason =
  | "low-perfusion"
  | "signal-lost"
  | "data-gap"
  | "coarse-interval"
  | "technician-exclusion";

export const UNINTERPRETABLE_REASON_TEXT: Record<UninterpretableReason, string> = {
  "low-perfusion": "低灌注，探头接触不良，信号不可信",
  "signal-lost": "信号丢失（可能摘下设备或探头脱落）",
  "data-gap": "无数据（设备离腕或未记录）",
  "coarse-interval": "采样间隔过长，无法可靠识别事件",
  "technician-exclusion": "技师复核后排除",
};

export interface ExclusionRangeWall {
  from: string;
  to: string;
  reason: string;
}

export interface ExclusionRangeMono {
  fromMono: number;
  toMono: number;
  reason: string;
}

export interface TimedSample {
  /** 样本起始的单调时钟（毫秒）。 */
  mono: number;
  /** 样本覆盖时长（毫秒）。 */
  interval: number;
  value: number | null;
  batchId: string;
  batchFlags: readonly string[];
  /** 是否落在技师排除区间内。 */
  excluded: boolean;
}

export interface ChannelSeries {
  channel: SleepChannel;
  samples: TimedSample[];
  /** 拼接过程中发现的问题（如批次重叠被裁剪）。 */
  notes: string[];
}

/** 把某通道的批次拼成按单调时钟排序的样本序列。 */
export function buildChannelSeries(
  batches: SampleBatch[],
  channel: SleepChannel,
  exclusions: ExclusionRangeMono[],
): ChannelSeries {
  const notes: string[] = [];
  const sorted = batches
    .filter((batch) => batch.channel === channel)
    .sort((a, b) => a.startedAtMonotonicMillis - b.startedAtMonotonicMillis);
  const samples: TimedSample[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const batch of sorted) {
    let trimmed = 0;
    for (let index = 0; index < batch.values.length; index += 1) {
      const mono = batch.startedAtMonotonicMillis + index * batch.intervalMillis;
      if (mono < cursor) {
        trimmed += 1;
        continue;
      }
      const excluded = exclusions.some((range) => mono >= range.fromMono && mono < range.toMono);
      samples.push({
        mono,
        interval: batch.intervalMillis,
        value: batch.values[index] ?? null,
        batchId: batch.batchId,
        batchFlags: batch.qualityFlags,
        excluded,
      });
    }
    if (trimmed > 0) {
      notes.push(`批次 ${batch.batchId} 与前序批次重叠，已裁剪 ${trimmed} 个样本`);
    }
    const batchEnd = batch.startedAtMonotonicMillis + batch.values.length * batch.intervalMillis;
    cursor = Math.max(cursor, batchEnd);
  }
  return { channel, samples, notes };
}

/** 样本是否可用于指数计算（非空、未被排除、批次无失效标记）。 */
export function isIndexable(sample: TimedSample): boolean {
  if (sample.value === null || sample.excluded) return false;
  return !sample.batchFlags.some((flag) => INDEX_INVALIDATING_FLAGS.has(flag));
}

export interface WearSegment {
  segmentId: string;
  channel: SleepChannel;
  batchIds: string[];
  startMono: number;
  /** 段结束（不含）= 末样本起始 + 其间隔。 */
  endMono: number;
  sampleCount: number;
  /** 可用于指数计算的样本数。 */
  indexableSampleCount: number;
  flags: string[];
  maxIntervalMillis: number;
}

/** 把样本序列切成佩戴分段：相邻样本间隔超过 maxJoinGapMillis 即断裂。 */
export function segmentSeries(
  series: ChannelSeries,
  nightPrefix: string,
  maxJoinGapMillis: number,
): WearSegment[] {
  const segments: WearSegment[] = [];
  let current: TimedSample[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const batchIds: string[] = [];
    const flags = new Set<string>();
    let indexable = 0;
    let maxInterval = 0;
    for (const sample of current) {
      if (batchIds[batchIds.length - 1] !== sample.batchId) batchIds.push(sample.batchId);
      for (const flag of sample.batchFlags) flags.add(flag);
      if (isIndexable(sample)) indexable += 1;
      maxInterval = Math.max(maxInterval, sample.interval);
    }
    segments.push({
      segmentId: `${nightPrefix}-seg-${series.channel}-${segments.length + 1}`,
      channel: series.channel,
      batchIds,
      startMono: first.mono,
      endMono: last.mono + last.interval,
      sampleCount: current.length,
      indexableSampleCount: indexable,
      flags: [...flags],
      maxIntervalMillis: maxInterval,
    });
    current = [];
  };
  let previous: TimedSample | null = null;
  for (const sample of series.samples) {
    if (previous !== null && sample.mono - (previous.mono + previous.interval) > maxJoinGapMillis) {
      flush();
    }
    current.push(sample);
    previous = sample;
  }
  flush();
  return segments;
}

export interface RawInvalidInterval {
  fromMono: number;
  toMono: number;
  reason: UninterpretableReason;
}

export interface InvalidIntervalOptions {
  /** 连续 null 超过该时长才记为信号丢失（毫秒）。 */
  minSignalLossMillis: number;
  /** 各通道允许的最大采样间隔，超过则记为采样间隔过长。 */
  maxIntervalMillis: Record<SleepChannel, number>;
}

/** 从样本序列中提取不可判读区间（段内原因；段间缺口由调用方补）。 */
export function invalidIntervalsWithinSeries(
  series: ChannelSeries,
  options: InvalidIntervalOptions,
): RawInvalidInterval[] {
  const intervals: RawInvalidInterval[] = [];
  const maxInterval = options.maxIntervalMillis[series.channel];

  // 批次级失效标记：整批不可判读
  const flagRuns = new Map<string, { fromMono: number; toMono: number }>();
  for (const sample of series.samples) {
    for (const flag of sample.batchFlags) {
      if (!INDEX_INVALIDATING_FLAGS.has(flag)) continue;
      const reason: UninterpretableReason = flag === "low-perfusion" ? "low-perfusion" : "signal-lost";
      const key = `${sample.batchId}:${reason}`;
      const run = flagRuns.get(key);
      if (run) {
        run.toMono = sample.mono + sample.interval;
      } else {
        flagRuns.set(key, { fromMono: sample.mono, toMono: sample.mono + sample.interval });
      }
    }
  }
  for (const [key, run] of flagRuns) {
    const reason = key.endsWith("low-perfusion") ? "low-perfusion" : "signal-lost";
    intervals.push({ ...run, reason });
  }

  // 采样间隔过长
  let coarseStart: number | null = null;
  let coarseEnd = 0;
  for (const sample of series.samples) {
    if (sample.interval > maxInterval) {
      if (coarseStart === null) coarseStart = sample.mono;
      coarseEnd = sample.mono + sample.interval;
    } else if (coarseStart !== null) {
      intervals.push({ fromMono: coarseStart, toMono: coarseEnd, reason: "coarse-interval" });
      coarseStart = null;
    }
  }
  if (coarseStart !== null) {
    intervals.push({ fromMono: coarseStart, toMono: coarseEnd, reason: "coarse-interval" });
  }

  // 连续 null（信号丢失）
  let nullStart: number | null = null;
  let nullEnd = 0;
  for (const sample of series.samples) {
    if (sample.value === null) {
      if (nullStart === null) nullStart = sample.mono;
      nullEnd = sample.mono + sample.interval;
    } else {
      if (nullStart !== null && nullEnd - nullStart >= options.minSignalLossMillis) {
        intervals.push({ fromMono: nullStart, toMono: nullEnd, reason: "signal-lost" });
      }
      nullStart = null;
    }
  }
  if (nullStart !== null && nullEnd - nullStart >= options.minSignalLossMillis) {
    intervals.push({ fromMono: nullStart, toMono: nullEnd, reason: "signal-lost" });
  }

  // 技师排除
  let exclusionStart: number | null = null;
  let exclusionEnd = 0;
  for (const sample of series.samples) {
    if (sample.excluded) {
      if (exclusionStart === null) exclusionStart = sample.mono;
      exclusionEnd = sample.mono + sample.interval;
    } else if (exclusionStart !== null) {
      intervals.push({
        fromMono: exclusionStart,
        toMono: exclusionEnd,
        reason: "technician-exclusion",
      });
      exclusionStart = null;
    }
  }
  if (exclusionStart !== null) {
    intervals.push({
      fromMono: exclusionStart,
      toMono: exclusionEnd,
      reason: "technician-exclusion",
    });
  }

  return intervals.sort((a, b) => a.fromMono - b.fromMono);
}

/** 段间缺口（设备离腕/未记录），限定在给定窗口内。 */
export function dataGapIntervals(
  segments: WearSegment[],
  windowStartMono: number,
  windowEndMono: number,
): RawInvalidInterval[] {
  const gaps: RawInvalidInterval[] = [];
  let cursor = windowStartMono;
  for (const segment of segments) {
    if (segment.startMono > cursor) {
      gaps.push({ fromMono: cursor, toMono: segment.startMono, reason: "data-gap" });
    }
    cursor = Math.max(cursor, segment.endMono);
  }
  if (cursor < windowEndMono) {
    gaps.push({ fromMono: cursor, toMono: windowEndMono, reason: "data-gap" });
  }
  return gaps;
}
