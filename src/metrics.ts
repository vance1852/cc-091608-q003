import type { CandidateEvent } from "./events.ts";
import type { CorrectedSample, NightTimeline } from "./nights.ts";
import { ACTIGRAPHY_WAKE_THRESHOLD } from "./nights.ts";
import type { QualityAssessment } from "./quality.ts";

/**
 * 初筛指标计算。每个指标都携带溯源信息（算法版本、使用的批次、
 * 排除区间、有效分母）；覆盖不足时指标状态为 not-interpretable，
 * 绝不输出一个看似精确的数值。
 */

export const ALGORITHM_VERSION = "hsat-screen-1.0.0";

export interface MetricProvenance {
  algorithmVersion: string;
  /** 参与计算的血氧批次。 */
  batchIds: string[];
  excludedRanges: Array<{ from: string; to: string; reason: string }>;
  validDenominatorMinutes: number;
}

export type MetricResult =
  | {
      status: "ok";
      value: number;
      unit: string;
      provenance: MetricProvenance;
    }
  | {
      status: "not-interpretable";
      reasons: string[];
      provenance: MetricProvenance;
    };

export interface NightMetrics {
  /** 每小时候选低氧事件数（ODI3，初筛口径）。 */
  odi3: MetricResult;
  /** 有效区间内的候选事件总数（计数，非指数）。 */
  candidateEventCount: number;
  corroboratedEventCount: number;
  meanSpo2: MetricResult;
  minSpo2: MetricResult;
  /** 体动估计的睡眠时长（分钟），仅供参考。 */
  estimatedSleepMinutes: number;
  wearMinutes: number;
  validMinutes: number;
  coverageRatio: number;
}

function provenance(
  validSpo2: CorrectedSample[],
  excludedRanges: Array<{ from: string; to: string; reason: string }>,
  validMinutes: number,
): MetricProvenance {
  return {
    algorithmVersion: ALGORITHM_VERSION,
    batchIds: [...new Set(validSpo2.map((s) => s.batchId))].sort(),
    excludedRanges,
    validDenominatorMinutes: Math.round(validMinutes * 10) / 10,
  };
}

export function computeNightMetrics(
  timeline: NightTimeline,
  quality: QualityAssessment,
  events: CandidateEvent[],
  excludedRanges: Array<{ from: string; to: string; reason: string }>,
): NightMetrics {
  const prov = provenance(quality.validSpo2Samples, excludedRanges, quality.validMinutes);
  const insufficient = {
    status: "not-interpretable" as const,
    reasons: quality.insufficiencyReasons,
    provenance: prov,
  };

  const validHours = quality.validMinutes / 60;
  const odi3: MetricResult = quality.sufficientForIndex
    ? {
        status: "ok",
        value: Math.round((events.length / validHours) * 10) / 10,
        unit: "events/hour（有效时间分母）",
        provenance: prov,
      }
    : insufficient;

  const spo2Values = quality.validSpo2Samples.map((s) => s.value!);
  const meanSpo2: MetricResult =
    quality.sufficientForIndex && spo2Values.length >= 30
      ? {
          status: "ok",
          value: Math.round((spo2Values.reduce((a, b) => a + b, 0) / spo2Values.length) * 10) / 10,
          unit: "%",
          provenance: prov,
        }
      : insufficient;
  const minSpo2: MetricResult =
    quality.sufficientForIndex && spo2Values.length >= 30
      ? {
          status: "ok",
          value: Math.min(...spo2Values),
          unit: "%",
          provenance: prov,
        }
      : insufficient;

  // 体动估计睡眠时长：佩戴段内低于清醒阈值的 epoch 比例。
  const inSegment = (epochMillis: number) =>
    timeline.segments.some(
      (seg) => epochMillis >= Date.parse(seg.startedAt) && epochMillis < Date.parse(seg.endedAt),
    );
  const asleepMillis = timeline.samples
    .filter(
      (s) =>
        s.channel === "actigraphy" &&
        s.value !== null &&
        s.value < ACTIGRAPHY_WAKE_THRESHOLD &&
        inSegment(s.epochMillis),
    )
    .reduce((sum, s) => sum + s.intervalMillis, 0);

  return {
    odi3,
    candidateEventCount: events.length,
    corroboratedEventCount: events.filter((e) => e.confidence === "corroborated").length,
    meanSpo2,
    minSpo2,
    estimatedSleepMinutes: Math.round(asleepMillis / 60_000),
    wearMinutes: Math.round(quality.wearMinutes * 10) / 10,
    validMinutes: Math.round(quality.validMinutes * 10) / 10,
    coverageRatio: Math.round(quality.coverageRatio * 1000) / 1000,
  };
}
