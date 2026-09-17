/**
 * 候选事件识别：以血氧下降为主线，联合脉搏波与体动做交叉验证。
 *
 * - 血氧：相对滚动基线下降 ≥ dropThresholdPct 并持续 ≥ minDurationMillis
 *   记为一次候选事件；
 * - 脉搏波：事件前后脉率上升 ≥ pulseRiseThresholdBpm 记为“伴脉率上升”，
 *   提升可信度；无脉搏数据时如实记 null；
 * - 体动：事件期间有明显体动则标记为疑似伪差，降可信度。
 *
 * 所有事件都保留来源批次号，保证可溯源。
 */

import { isIndexable, type RawInvalidInterval, type TimedSample } from "./series.js";

export interface EventDetectionOptions {
  /** 相对基线的血氧下降阈值（百分点）。 */
  dropThresholdPct: number;
  /** 恢复到距基线该值以内视为事件结束（百分点）。 */
  recoveryPct: number;
  /** 事件最短持续（毫秒）。 */
  minDurationMillis: number;
  /** 相邻有效样本超过该间隔则事件截断（毫秒）。 */
  maxSampleGapMillis: number;
  /** 滚动基线窗口（毫秒）。 */
  baselineWindowMillis: number;
  /** 采样间隔超过该值的样本不参与事件检测（毫秒）。 */
  maxSampleIntervalMillis: number;
  /** 脉率上升阈值（次/分）。 */
  pulseRiseThresholdBpm: number;
  /** 体动伪差阈值（计数）。 */
  movementThreshold: number;
}

export const DEFAULT_EVENT_OPTIONS: EventDetectionOptions = {
  dropThresholdPct: 3,
  recoveryPct: 1.5,
  minDurationMillis: 10_000,
  maxSampleGapMillis: 15_000,
  baselineWindowMillis: 120_000,
  maxSampleIntervalMillis: 12_000,
  pulseRiseThresholdBpm: 6,
  movementThreshold: 40,
};

export interface CandidateEvent {
  eventId: string;
  kind: "desaturation";
  startMono: number;
  endMono: number;
  durationMillis: number;
  baselineSpo2: number;
  nadirSpo2: number;
  dropPct: number;
  /** 事件前后脉率明显上升；无脉搏数据时为 null。 */
  pulseResponse: boolean | null;
  /** 事件期间有明显体动，疑似伪差。 */
  movementArtifact: boolean;
  confidence: "high" | "medium" | "low";
  /** 事件触及不可判读区间，边界不可靠，不计入指数。 */
  partial: boolean;
  sourceBatchIds: string[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface RawEvent {
  startMono: number;
  endMono: number;
  baseline: number;
  nadir: number;
  batchIds: string[];
  truncatedByGap: boolean;
}

/** 在血氧有效样本上做阈值状态机检测。 */
function detectRawEvents(
  samples: TimedSample[],
  options: EventDetectionOptions,
): RawEvent[] {
  const indexable = samples.filter(
    (sample): sample is TimedSample & { value: number } =>
      isIndexable(sample) &&
      sample.value !== null &&
      sample.interval <= options.maxSampleIntervalMillis,
  );
  if (indexable.length === 0) return [];
  const nightBaseline = median(indexable.map((sample) => sample.value));

  const events: RawEvent[] = [];
  let inEvent = false;
  let startMono = 0;
  let nadir = Number.POSITIVE_INFINITY;
  let baselineAtStart = nightBaseline;
  let batchIds: string[] = [];
  let lastMono = 0;
  let lastInterval = 0;

  const baselineAt = (position: number): number => {
    const windowStart = indexable[position]!.mono - options.baselineWindowMillis;
    const windowValues: number[] = [];
    for (let back = position - 1; back >= 0 && indexable[back]!.mono >= windowStart; back -= 1) {
      windowValues.push(indexable[back]!.value);
    }
    return windowValues.length >= 8 ? median(windowValues) : nightBaseline;
  };

  const closeEvent = (endMono: number, truncatedByGap: boolean): void => {
    if (endMono - startMono >= options.minDurationMillis) {
      events.push({
        startMono,
        endMono,
        baseline: baselineAtStart,
        nadir,
        batchIds,
        truncatedByGap,
      });
    }
    inEvent = false;
  };

  for (let position = 0; position < indexable.length; position += 1) {
    const sample = indexable[position]!;
    if (inEvent && sample.mono - (lastMono + lastInterval) > options.maxSampleGapMillis) {
      closeEvent(lastMono + lastInterval, true);
    }
    const baseline = baselineAt(position);
    if (!inEvent) {
      if (sample.value <= baseline - options.dropThresholdPct) {
        inEvent = true;
        startMono = sample.mono;
        baselineAtStart = baseline;
        nadir = sample.value;
        batchIds = [sample.batchId];
      }
    } else {
      if (sample.value >= baselineAtStart - options.recoveryPct) {
        closeEvent(lastMono + lastInterval, false);
      } else {
        nadir = Math.min(nadir, sample.value);
        if (batchIds[batchIds.length - 1] !== sample.batchId) batchIds.push(sample.batchId);
      }
    }
    lastMono = sample.mono;
    lastInterval = sample.interval;
  }
  if (inEvent) closeEvent(lastMono + lastInterval, false);
  return events;
}

function medianPulseIn(
  pulse: Array<TimedSample & { value: number }>,
  fromMono: number,
  toMono: number,
): number | null {
  const values = pulse
    .filter((sample) => sample.mono >= fromMono && sample.mono < toMono)
    .map((sample) => sample.value);
  return values.length > 0 ? median(values) : null;
}

function maxPulseIn(
  pulse: Array<TimedSample & { value: number }>,
  fromMono: number,
  toMono: number,
): number | null {
  let max: number | null = null;
  for (const sample of pulse) {
    if (sample.mono >= fromMono && sample.mono < toMono) {
      max = max === null ? sample.value : Math.max(max, sample.value);
    }
  }
  return max;
}

/**
 * 识别候选事件并做交叉验证。
 * @param spo2Samples 血氧通道样本（全量，函数内部筛有效）
 * @param pulseSamples 脉搏波（脉率）样本
 * @param actigraphySamples 体动样本
 * @param uninterpretable 不可判读区间（用于标记 partial 事件）
 */
export function detectCandidateEvents(
  spo2Samples: TimedSample[],
  pulseSamples: TimedSample[],
  actigraphySamples: TimedSample[],
  uninterpretable: RawInvalidInterval[],
  nightPrefix: string,
  options: EventDetectionOptions = DEFAULT_EVENT_OPTIONS,
): CandidateEvent[] {
  const pulse = pulseSamples.filter(
    (sample): sample is TimedSample & { value: number } =>
      isIndexable(sample) &&
      sample.value !== null &&
      sample.interval <= options.maxSampleIntervalMillis,
  );
  const actigraphy = actigraphySamples.filter(
    (sample): sample is TimedSample & { value: number } =>
      sample.value !== null && !sample.excluded,
  );

  return detectRawEvents(spo2Samples, options).map((raw, index) => {
    // 脉搏交叉验证：事件前 90~10 秒为基线，事件开始到结束后 45 秒取峰值
    const preBaseline = medianPulseIn(pulse, raw.startMono - 90_000, raw.startMono - 10_000);
    const postMax = maxPulseIn(pulse, raw.startMono, raw.endMono + 45_000);
    const pulseResponse =
      preBaseline === null || postMax === null
        ? null
        : postMax - preBaseline >= options.pulseRiseThresholdBpm;

    // 体动交叉验证
    const movementArtifact = actigraphy.some(
      (sample) =>
        sample.mono < raw.endMono &&
        sample.mono + sample.interval > raw.startMono &&
        sample.value >= options.movementThreshold,
    );

    const partial =
      raw.truncatedByGap ||
      uninterpretable.some(
        (interval) => interval.fromMono < raw.endMono && interval.toMono > raw.startMono,
      );

    const confidence: CandidateEvent["confidence"] = movementArtifact
      ? "low"
      : pulseResponse === true
        ? "high"
        : "medium";

    return {
      eventId: `${nightPrefix}-evt-${index + 1}`,
      kind: "desaturation",
      startMono: raw.startMono,
      endMono: raw.endMono,
      durationMillis: raw.endMono - raw.startMono,
      baselineSpo2: Math.round(raw.baseline * 10) / 10,
      nadirSpo2: Math.round(raw.nadir * 10) / 10,
      dropPct: Math.round((raw.baseline - raw.nadir) * 10) / 10,
      pulseResponse,
      movementArtifact,
      confidence,
      partial,
      sourceBatchIds: raw.batchIds,
    };
  });
}
