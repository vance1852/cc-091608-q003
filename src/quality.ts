import type { CorrectedSample, NightTimeline, TimeInterval } from "./nights.ts";
import { formatIsoWithOffset } from "./clock.ts";

/**
 * 信号质量评估：把不能支持事件识别的区间明确列为“不可判读”，
 * 并给出有效分母。宁可不报指数，也不让低灌注、长间隙、过疏采样
 * 的数据产出一个看似精确的整夜指数。
 */

/** 血氧连续 null 超过该时长即记为信号间隙。 */
export const MAX_SPO2_NULL_GAP_MILLIS = 60_000;
/** 血氧采样间隔超过该值时，无法可靠识别 ≥10s 的 desat 事件。 */
export const MAX_SPO2_INTERVAL_MILLIS = 4_000;
/** 整夜有效血氧时长不足该值，不计算任何每小时指数。 */
export const MIN_VALID_MINUTES_FOR_INDEX = 180;
/** 有效时长占佩戴时长低于该比例，不计算任何每小时指数。 */
export const MIN_COVERAGE_RATIO_FOR_INDEX = 0.6;

export type UninterpretableReason =
  | "low-perfusion"
  | "off-wrist"
  | "no-data"
  | "signal-gap"
  | "sampling-too-coarse"
  | "technician-excluded";

export interface ExcludedRangeInput {
  from: string;
  to: string;
  reason: string;
}

export interface QualityAssessment {
  /** 所有不可判读区间（含技师排除段），按开始时间排序。 */
  uninterpretable: TimeInterval[];
  /** 可用于事件识别与指标的血氧样本。 */
  validSpo2Samples: CorrectedSample[];
  /** 有效分母（分钟）：有效血氧样本各自覆盖时长的总和。 */
  validMinutes: number;
  /** 佩戴总时长（分钟）。 */
  wearMinutes: number;
  /** 有效时长 / 佩戴时长。 */
  coverageRatio: number;
  /** 覆盖是否足以给出每小时指数。 */
  sufficientForIndex: boolean;
  /** 不足时的具体原因（供报告说明，中文）。 */
  insufficiencyReasons: string[];
  /** 面向技师/医师的质量说明。 */
  notes: string[];
}

function overlaps(sample: CorrectedSample, intervals: TimeInterval[]): boolean {
  const end = sample.epochMillis + sample.intervalMillis;
  return intervals.some((iv) => sample.epochMillis < iv.toEpoch && end > iv.fromEpoch);
}

function batchSpanIntervals(
  samples: CorrectedSample[],
  flag: string,
  offsetMinutes: number,
): TimeInterval[] {
  const byBatch = new Map<string, CorrectedSample[]>();
  for (const s of samples) {
    if (!s.qualityFlags.includes(flag)) continue;
    const list = byBatch.get(s.batchId);
    if (list) list.push(s);
    else byBatch.set(s.batchId, [s]);
  }
  const out: TimeInterval[] = [];
  for (const [batchId, list] of byBatch) {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    out.push({
      from: first.wallIso,
      to: formatIsoWithOffset(last.epochMillis + last.intervalMillis, offsetMinutes),
      fromEpoch: first.epochMillis,
      toEpoch: last.epochMillis + last.intervalMillis,
      reason: `${flag}（批次 ${batchId}）`,
    });
  }
  return out;
}

/** 血氧通道内超过阈值的连续 null 段。 */
function spo2NullGaps(
  spo2: CorrectedSample[],
  offsetMinutes: number,
): TimeInterval[] {
  const out: TimeInterval[] = [];
  let runStart: CorrectedSample | undefined;
  let runLast: CorrectedSample | undefined;
  const flush = () => {
    if (!runStart || !runLast) return;
    const from = runStart.epochMillis;
    const to = runLast.epochMillis + runLast.intervalMillis;
    if (to - from > MAX_SPO2_NULL_GAP_MILLIS) {
      out.push({
        from: formatIsoWithOffset(from, offsetMinutes),
        to: formatIsoWithOffset(to, offsetMinutes),
        fromEpoch: from,
        toEpoch: to,
        reason: "signal-gap",
      });
    }
    runStart = undefined;
    runLast = undefined;
  };
  for (const s of spo2) {
    if (s.value === null && !s.qualityFlags.includes("off-wrist")) {
      if (!runStart) runStart = s;
      runLast = s;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

export function assessQuality(
  timeline: NightTimeline,
  excludedRanges: ExcludedRangeInput[],
): QualityAssessment {
  const offsetMinutes = timeline.samples[0]?.offsetMinutes ?? 0;
  const uninterpretable: TimeInterval[] = [];
  const notes: string[] = [];

  // 1) 批次级低灌注标记
  uninterpretable.push(...batchSpanIntervals(timeline.samples, "low-perfusion", offsetMinutes));

  // 2) 摘下与无数据空洞（夜次分段已识别）
  uninterpretable.push(...timeline.offWristIntervals, ...timeline.noDataGaps);

  // 3) 血氧长 null 段
  const spo2 = timeline.samples.filter((s) => s.channel === "spo2");
  uninterpretable.push(...spo2NullGaps(spo2, offsetMinutes));

  // 4) 采样间隔过疏的血氧批次
  const coarseBatches = new Map<string, CorrectedSample[]>();
  for (const s of spo2) {
    if (s.intervalMillis > MAX_SPO2_INTERVAL_MILLIS) {
      const list = coarseBatches.get(s.batchId);
      if (list) list.push(s);
      else coarseBatches.set(s.batchId, [s]);
    }
  }
  for (const [batchId, list] of coarseBatches) {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    uninterpretable.push({
      from: first.wallIso,
      to: formatIsoWithOffset(last.epochMillis + last.intervalMillis, offsetMinutes),
      fromEpoch: first.epochMillis,
      toEpoch: last.epochMillis + last.intervalMillis,
      reason: `sampling-too-coarse（批次 ${batchId}，间隔 ${first.intervalMillis / 1000}s）`,
    });
  }

  // 5) 技师排除段
  for (const range of excludedRanges) {
    const fromEpoch = Date.parse(range.from);
    const toEpoch = Date.parse(range.to);
    if (!Number.isFinite(fromEpoch) || !Number.isFinite(toEpoch) || toEpoch <= fromEpoch) {
      throw new Error(`技师排除段时间无效: ${range.from} ~ ${range.to}`);
    }
    uninterpretable.push({
      from: range.from,
      to: range.to,
      fromEpoch,
      toEpoch,
      reason: `technician-excluded（${range.reason}）`,
    });
  }

  uninterpretable.sort((a, b) => a.fromEpoch - b.fromEpoch);

  // 有效血氧样本：非 null、无 off-wrist/low-perfusion 标记、采样足够密、
  // 不落在任何不可判读区间内。
  const validSpo2Samples = spo2.filter(
    (s) =>
      s.value !== null &&
      !s.qualityFlags.includes("off-wrist") &&
      !s.qualityFlags.includes("low-perfusion") &&
      s.intervalMillis <= MAX_SPO2_INTERVAL_MILLIS &&
      !overlaps(s, uninterpretable),
  );

  const validMinutes =
    validSpo2Samples.reduce((sum, s) => sum + s.intervalMillis, 0) / 60_000;
  const wearMinutes =
    timeline.segments.reduce((sum, seg) => {
      return sum + (Date.parse(seg.endedAt) - Date.parse(seg.startedAt));
    }, 0) / 60_000;
  const coverageRatio = wearMinutes > 0 ? validMinutes / wearMinutes : 0;

  const insufficiencyReasons: string[] = [];
  if (validMinutes < MIN_VALID_MINUTES_FOR_INDEX) {
    insufficiencyReasons.push(
      `有效血氧时长 ${validMinutes.toFixed(1)} 分钟，低于可判读下限 ${MIN_VALID_MINUTES_FOR_INDEX} 分钟`,
    );
  }
  if (coverageRatio < MIN_COVERAGE_RATIO_FOR_INDEX) {
    insufficiencyReasons.push(
      `有效覆盖率 ${(coverageRatio * 100).toFixed(1)}%，低于 ${(MIN_COVERAGE_RATIO_FOR_INDEX * 100).toFixed(0)}%`,
    );
  }
  const sufficientForIndex = insufficiencyReasons.length === 0;

  for (const iv of uninterpretable) {
    notes.push(`不可判读 ${iv.from} ~ ${iv.to}：${iv.reason}`);
  }
  for (const aw of timeline.briefAwakenings) {
    notes.push(`短暂清醒 ${aw.from} ~ ${aw.to}（已归入本夜次，不影响分段）`);
  }
  for (const wp of timeline.wakePeriods) {
    notes.push(`较长清醒期 ${wp.from} ~ ${wp.to}`);
  }
  const extrapolatedCount = timeline.samples.filter((s) => s.extrapolated).length;
  if (extrapolatedCount > 0) {
    notes.push(
      `有 ${extrapolatedCount} 个样本落在同步锚点范围之外，墙面时间为外推值，不确定度随距离放大`,
    );
  }

  return {
    uninterpretable,
    validSpo2Samples,
    validMinutes,
    wearMinutes,
    coverageRatio,
    sufficientForIndex,
    insufficiencyReasons,
    notes,
  };
}
