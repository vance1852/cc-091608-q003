/**
 * 单夜分析编排：时钟校正 → 夜次归组 → 事件识别 → 质量门控。
 *
 * 输出 NightAnalysis，包含报告所需的全部素材：事件时间轴、有效分母、
 * 不可判读区间、质量说明、转诊建议与指标溯源。任何一步证据不足，
 * 都如实记录，绝不产出看似精确的整夜指数。
 */

import type { SleepChannel } from "./contracts.js";
import { DeviceClock } from "./clock.js";
import type { OvernightStream } from "./ingest.js";
import {
  buildChannelSeries,
  dataGapIntervals,
  invalidIntervalsWithinSeries,
  isIndexable,
  segmentSeries,
  UNINTERPRETABLE_REASON_TEXT,
  type ExclusionRangeWall,
  type RawInvalidInterval,
  type UninterpretableReason,
  type WearSegment,
} from "./series.js";
import { detectWakeBouts, listNightIds, type WakeBout } from "./nights.js";
import {
  DEFAULT_EVENT_OPTIONS,
  detectCandidateEvents,
  type CandidateEvent,
  type EventDetectionOptions,
} from "./events.js";
import {
  computeDenominator,
  DEFAULT_QUALITY_POLICY,
  formatMinutes,
  judgeInterpretability,
  type QualityPolicy,
  type ValidDenominator,
} from "./quality.js";
import { nightWindowFor } from "./timezone.js";

export const ALGORITHM_VERSION = "home-screening/1.0.0";

export interface AnalysisOptions {
  /** 技师排除的时间区间（挂钟 ISO 字符串）。 */
  exclusions?: ExclusionRangeWall[];
  policy?: Partial<QualityPolicy>;
  eventOptions?: Partial<EventDetectionOptions>;
}

export interface AnalyzedEvent extends CandidateEvent {
  startWall: string;
  endWall: string;
}

export interface UninterpretableInterval {
  fromWall: string;
  toWall: string;
  reason: UninterpretableReason;
  reasonText: string;
}

export interface MetricProvenance {
  metric: string;
  algorithmVersion: string;
  sourceBatchIds: string[];
  sourceSegmentIds: string[];
}

export interface NightIndex {
  /** 每小时候选事件数（分母为有效血氧监测时长，非诊断性 AHI）。 */
  eventsPerValidHour: number;
  /** 计入指数的候选事件数（不含 partial 事件）。 */
  eventCount: number;
  validHours: number;
}

export interface ReferralAdvice {
  recommended: boolean;
  rationale: string[];
}

export interface NightAnalysis {
  nightId: string;
  algorithmVersion: string;
  window: { fromWall: string; toWall: string } | null;
  segments: WearSegment[];
  events: AnalyzedEvent[];
  denominator: ValidDenominator | null;
  interpretable: boolean;
  interpretabilityReasons: string[];
  uninterpretableIntervals: UninterpretableInterval[];
  qualityNotes: string[];
  includedBatchIds: string[];
  excludedRanges: ExclusionRangeWall[];
  index: NightIndex | null;
  referral: ReferralAdvice;
  wakeBouts: Array<WakeBout & { brief: boolean }>;
  clockSummary: { driftPpm: number | null; extrapolatedTail: boolean };
  provenance: MetricProvenance[];
}

const CHANNELS: SleepChannel[] = ["spo2", "pulse-wave", "actigraphy"];

function mergePolicy(overrides?: Partial<QualityPolicy>): QualityPolicy {
  return {
    ...DEFAULT_QUALITY_POLICY,
    ...overrides,
    maxIntervalMillis: {
      ...DEFAULT_QUALITY_POLICY.maxIntervalMillis,
      ...overrides?.maxIntervalMillis,
    },
  };
}

function buildReferral(
  interpretable: boolean,
  index: NightIndex | null,
  events: AnalyzedEvent[],
): ReferralAdvice {
  if (!interpretable || index === null) {
    return {
      recommended: false,
      rationale: [
        "本次记录证据不足，无法给出可靠初筛结论；建议改善佩戴后复测",
        "若反复无法获得有效记录或临床高度怀疑，应直接转正式睡眠检查",
      ],
    };
  }
  const rationale: string[] = [];
  const perHour = index.eventsPerValidHour;
  let recommended: boolean;
  if (perHour >= 15) {
    recommended = true;
    rationale.push(`每小时候选事件 ${perHour} 次（初筛口径），负荷较高，建议尽快转正式多导睡眠监测`);
  } else if (perHour >= 5) {
    recommended = true;
    rationale.push(`每小时候选事件 ${perHour} 次（初筛口径），建议转正式睡眠检查以明确诊断`);
  } else {
    recommended = false;
    rationale.push(`每小时候选事件 ${perHour} 次（初筛口径），初筛未见明显异常；若症状持续，仍可考虑正式检查`);
  }
  const artifactCount = events.filter((event) => event.movementArtifact && !event.partial).length;
  if (index.eventCount > 0 && artifactCount / index.eventCount > 0.3) {
    rationale.push("体动干扰事件比例较高，指数可能高估，解读需谨慎");
  }
  return { recommended, rationale };
}

/** 分析单个夜次。 */
export function analyzeNight(
  stream: OvernightStream,
  clock: DeviceClock,
  nightId: string,
  options: AnalysisOptions = {},
): NightAnalysis {
  const policy = mergePolicy(options.policy);
  const eventOptions: EventDetectionOptions = {
    ...DEFAULT_EVENT_OPTIONS,
    maxSampleIntervalMillis: policy.maxIntervalMillis.spo2,
    ...options.eventOptions,
  };
  const exclusions = options.exclusions ?? [];
  const exclusionsMono = exclusions.map((range) => ({
    fromMono: clock.invert(Date.parse(range.from)),
    toMono: clock.invert(Date.parse(range.to)),
    reason: range.reason,
  }));

  const nightWindow = nightWindowFor(nightId, stream.timeZone);
  const nightFromMono = clock.invert(nightWindow.fromEpoch);
  const nightToMono = clock.invert(nightWindow.toEpoch);

  // 1) 各通道拼接采样序列，并裁剪到本夜次（正午 → 次日正午）
  const seriesByChannel = new Map<SleepChannel, ReturnType<typeof buildChannelSeries>>();
  const seriesNotes: string[] = [];
  for (const channel of CHANNELS) {
    const series = buildChannelSeries(stream.batches, channel, exclusionsMono);
    series.samples = series.samples.filter(
      (sample) => sample.mono >= nightFromMono && sample.mono < nightToMono,
    );
    seriesByChannel.set(channel, series);
    seriesNotes.push(...series.notes);
  }
  const spo2Series = seriesByChannel.get("spo2")!;
  const pulseSeries = seriesByChannel.get("pulse-wave")!;
  const actigraphySeries = seriesByChannel.get("actigraphy")!;

  // 2) 佩戴分段（中途摘下 → 段间缺口；重戴 → 新分段，仍属本夜次）
  const segments: WearSegment[] = [];
  for (const channel of CHANNELS) {
    segments.push(
      ...segmentSeries(seriesByChannel.get(channel)!, nightId, policy.maxJoinGapMillis),
    );
  }
  const spo2Segments = segments.filter((segment) => segment.channel === "spo2");

  // 3) 监测窗口 = 首个到末个血氧样本；无血氧数据则窗口为空
  const spo2Samples = spo2Series.samples;
  const windowMono =
    spo2Samples.length === 0
      ? null
      : {
          fromMono: spo2Samples[0]!.mono,
          toMono: spo2Samples[spo2Samples.length - 1]!.mono + spo2Samples[spo2Samples.length - 1]!.interval,
        };

  // 4) 不可判读区间（以血氧通道为准：指数只可能建立在血氧上）
  const rawUninterpretable: RawInvalidInterval[] = [];
  if (windowMono !== null) {
    rawUninterpretable.push(
      ...invalidIntervalsWithinSeries(spo2Series, {
        minSignalLossMillis: policy.minSignalLossMillis,
        maxIntervalMillis: policy.maxIntervalMillis,
      }),
      ...dataGapIntervals(spo2Segments, windowMono.fromMono, windowMono.toMono),
    );
  }
  const clippedUninterpretable = rawUninterpretable
    .filter((interval) => windowMono !== null && interval.toMono > interval.fromMono)
    .sort((a, b) => a.fromMono - b.fromMono);
  const uninterpretableIntervals: UninterpretableInterval[] = clippedUninterpretable.map(
    (interval) => ({
      fromWall: clock.correct(interval.fromMono).wallTime,
      toWall: clock.correct(interval.toMono).wallTime,
      reason: interval.reason,
      reasonText: UNINTERPRETABLE_REASON_TEXT[interval.reason],
    }),
  );

  // 5) 候选事件（血氧主线 + 脉搏/体动交叉验证）
  const rawEvents = detectCandidateEvents(
    spo2Samples,
    pulseSeries.samples,
    actigraphySeries.samples,
    clippedUninterpretable,
    nightId,
    eventOptions,
  );
  const events: AnalyzedEvent[] = rawEvents.map((event) => ({
    ...event,
    startWall: clock.correct(event.startMono).wallTime,
    endWall: clock.correct(event.endMono).wallTime,
  }));

  // 6) 有效分母与可判读性
  const denominator = computeDenominator(spo2Samples, policy.maxIntervalMillis.spo2);
  const verdict = judgeInterpretability(denominator, policy);

  // 7) 指数：只有可判读时才计算，分母为有效血氧时长
  const countableEvents = events.filter((event) => !event.partial);
  const index: NightIndex | null =
    verdict.interpretable && denominator !== null
      ? {
          eventsPerValidHour:
            Math.round((countableEvents.length / (denominator.validMillis / 3_600_000)) * 10) / 10,
          eventCount: countableEvents.length,
          validHours: Math.round((denominator.validMillis / 3_600_000) * 100) / 100,
        }
      : null;

  // 8) 质量说明
  const qualityNotes: string[] = [...seriesNotes];
  if (pulseSeries.samples.length === 0) {
    qualityNotes.push("缺少脉搏波数据，候选事件无法做脉率交叉验证");
  }
  if (actigraphySeries.samples.length === 0) {
    qualityNotes.push("缺少体动数据，无法评估体动伪差");
  }
  if (spo2Segments.length > 1) {
    qualityNotes.push(
      `夜间设备离腕后重新佩戴（${spo2Segments.length} 个佩戴段），已归入同一夜次`,
    );
  }
  const wakeBouts = detectWakeBouts(actigraphySeries, {
    wakeThreshold: eventOptions.movementThreshold,
    minBoutMillis: 5 * 60_000,
    briefLimitMillis: 60 * 60_000,
    maxSampleGapMillis: policy.maxJoinGapMillis,
  });
  for (const bout of wakeBouts) {
    const duration = formatMinutes(bout.toMono - bout.fromMono);
    qualityNotes.push(
      bout.brief
        ? `体动监测到短暂清醒约 ${duration}，已保留在同一夜次`
        : `体动监测到较长清醒约 ${duration}，该段指数代表性下降`,
    );
  }
  const lastSampleMono = spo2Samples.length > 0 ? spo2Samples[spo2Samples.length - 1]!.mono : null;
  const extrapolatedTail =
    lastSampleMono !== null && lastSampleMono > clock.lastAnchorMonotonicMillis;
  if (extrapolatedTail) {
    qualityNotes.push("末段数据超出最后一个同步锚点，挂钟时间为外推值，不确定度随距离增长");
  }
  if (clock.driftPpm !== null && Math.abs(clock.driftPpm) >= 30) {
    qualityNotes.push(
      `设备时钟与手机时钟存在约 ${Math.round(clock.driftPpm)} ppm 漂移，已按同步锚点校正`,
    );
  }
  const artifactCount = countableEvents.filter((event) => event.movementArtifact).length;
  if (artifactCount > 0) {
    qualityNotes.push(`${artifactCount} 件候选事件伴明显体动，可能为伪差，解读需谨慎`);
  }
  const partialCount = events.length - countableEvents.length;
  if (partialCount > 0) {
    qualityNotes.push(`${partialCount} 件候选事件触及不可判读区间，未计入指数`);
  }
  if (!verdict.interpretable) {
    qualityNotes.push(...verdict.reasons);
  }

  // 9) 纳入批次：本夜次内至少有一个未被排除样本的批次
  const includedBatchIds: string[] = [];
  const seenBatches = new Set<string>();
  for (const channel of CHANNELS) {
    for (const sample of seriesByChannel.get(channel)!.samples) {
      if (!sample.excluded && !seenBatches.has(sample.batchId)) {
        seenBatches.add(sample.batchId);
        includedBatchIds.push(sample.batchId);
      }
    }
  }

  // 10) 指标溯源：每个指标都能追到使用的批次、分段与算法版本
  const batchIdsOf = (channel: SleepChannel, onlyIndexable: boolean): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const sample of seriesByChannel.get(channel)!.samples) {
      if (onlyIndexable && !isIndexable(sample)) continue;
      if (!seen.has(sample.batchId)) {
        seen.add(sample.batchId);
        ids.push(sample.batchId);
      }
    }
    return ids;
  };
  const segmentIdsOf = (channel: SleepChannel): string[] =>
    segments.filter((segment) => segment.channel === channel).map((segment) => segment.segmentId);
  const provenance: MetricProvenance[] = [
    {
      metric: "eventsPerValidHour",
      algorithmVersion: ALGORITHM_VERSION,
      sourceBatchIds: batchIdsOf("spo2", true),
      sourceSegmentIds: segmentIdsOf("spo2"),
    },
    {
      metric: "validDenominator",
      algorithmVersion: ALGORITHM_VERSION,
      sourceBatchIds: batchIdsOf("spo2", true),
      sourceSegmentIds: segmentIdsOf("spo2"),
    },
    {
      metric: "pulseResponse",
      algorithmVersion: ALGORITHM_VERSION,
      sourceBatchIds: batchIdsOf("pulse-wave", true),
      sourceSegmentIds: segmentIdsOf("pulse-wave"),
    },
    {
      metric: "movementArtifact",
      algorithmVersion: ALGORITHM_VERSION,
      sourceBatchIds: batchIdsOf("actigraphy", false),
      sourceSegmentIds: segmentIdsOf("actigraphy"),
    },
  ];

  return {
    nightId,
    algorithmVersion: ALGORITHM_VERSION,
    window:
      windowMono === null
        ? null
        : {
            fromWall: clock.correct(windowMono.fromMono).wallTime,
            toWall: clock.correct(windowMono.toMono).wallTime,
          },
    segments,
    events,
    denominator,
    interpretable: verdict.interpretable,
    interpretabilityReasons: verdict.reasons,
    uninterpretableIntervals,
    qualityNotes,
    includedBatchIds,
    excludedRanges: exclusions,
    index,
    referral: buildReferral(verdict.interpretable, index, events),
    wakeBouts,
    clockSummary: { driftPpm: clock.driftPpm, extrapolatedTail },
    provenance,
  };
}

/** 分析数据流中的全部夜次。 */
export function analyzeStream(
  stream: OvernightStream,
  options: AnalysisOptions = {},
): { clock: DeviceClock; nights: NightAnalysis[] } {
  const clock = new DeviceClock(stream.anchors, stream.timeZone);
  const nights = listNightIds(stream, clock).map((nightId) =>
    analyzeNight(stream, clock, nightId, options),
  );
  return { clock, nights };
}
