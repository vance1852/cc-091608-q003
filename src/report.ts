import type { ScreeningReport, SleepSegment } from "./contracts.ts";
import type { StreamFile } from "./ingest.ts";
import { mergeStreams } from "./ingest.ts";
import { DeviceClock } from "./clock.ts";
import { buildNightTimelines, expandBatches } from "./nights.ts";
import { assessQuality, type ExcludedRangeInput, type QualityAssessment } from "./quality.ts";
import { detectCandidateEvents, type CandidateEvent } from "./events.ts";
import { ALGORITHM_VERSION, computeNightMetrics, type NightMetrics } from "./metrics.ts";
import type { TimeInterval } from "./nights.ts";

/**
 * 版本化初筛报告。
 *
 * 规则：
 * - 技师排除片段后重新生成 → 产生新版本草稿，旧版本保留可查；
 * - 签署（sign）只针对当前最新草稿，签署后该版本冻结，任何修改
 *   （排除片段、补传批次）都只会生成新的草稿版本，签署版保持原样；
 * - 每个指标都带算法版本与批次溯源，报告整体带 includedBatchIds。
 */

export const SCREENING_DISCLAIMER =
  "本报告由居家腕式初筛设备生成，仅用于筛查沟通，不构成诊断结论；" +
  "候选事件未经脑电证实，正式诊断需多导睡眠监测（PSG）。";

export type RecommendationLevel =
  | "insufficient-data"
  | "negative-screen"
  | "borderline"
  | "positive-screen";

export interface ReportPayload {
  subjectId: string;
  generatedAt: string;
  timeCorrection: {
    anchorsUsed: number;
    observedDriftPpm: number[];
    extrapolatedSampleCount: number;
  };
  segments: SleepSegment[];
  events: CandidateEvent[];
  metrics: NightMetrics;
  uninterpretable: TimeInterval[];
  qualityNotes: string[];
  recommendation: { level: RecommendationLevel; text: string };
  disclaimer: string;
}

export interface VersionedReport extends ScreeningReport {
  version: number;
  createdAt: string;
  supersedesReportId?: string;
  payload: ReportPayload;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function buildRecommendation(metrics: NightMetrics): {
  level: RecommendationLevel;
  text: string;
} {
  if (metrics.odi3.status === "not-interpretable") {
    return {
      level: "insufficient-data",
      text:
        "本夜有效数据不足，未计算每小时指数（" +
        metrics.odi3.reasons.join("；") +
        "）。建议重新安排居家监测；若临床怀疑中重度睡眠呼吸暂停，请直接转正式多导睡眠监测（PSG）。",
    };
  }
  const odi = metrics.odi3.value;
  if (odi >= 15) {
    return {
      level: "positive-screen",
      text: `初筛提示频繁夜间低氧候选事件（ODI3≈${odi}/h），建议尽快转正式 PSG 确认。`,
    };
  }
  if (odi >= 5) {
    return {
      level: "positive-screen",
      text: `初筛提示夜间低氧候选事件偏多（ODI3≈${odi}/h），建议转正式 PSG 确认。`,
    };
  }
  if (odi >= 3) {
    return {
      level: "borderline",
      text: `初筛见轻度候选事件（ODI3≈${odi}/h），建议结合日间症状评估，必要时转正式检查。`,
    };
  }
  return {
    level: "negative-screen",
    text: `本次初筛未见明显低氧事件聚集（ODI3≈${odi}/h）；若临床怀疑仍存在，请以正式检查为准。`,
  };
}

export class ReportStore {
  private readonly now: () => Date;
  private readonly streams = new Map<string, StreamFile>();
  private readonly reports = new Map<string, VersionedReport>();
  private readonly reportIdsByNight = new Map<string, string[]>();

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  /** 入库采集流；同一 subjectId 的后续上传（补传）按批次合并。 */
  addStream(stream: StreamFile): void {
    const existing = this.streams.get(stream.subjectId);
    this.streams.set(stream.subjectId, existing ? mergeStreams(existing, stream) : stream);
  }

  listNights(): string[] {
    const nights = new Set<string>();
    for (const stream of this.streams.values()) {
      const clock = new DeviceClock(stream.anchors);
      for (const timeline of buildNightTimelines(expandBatches(stream.batches, clock), stream.subjectId)) {
        nights.add(timeline.nightId);
      }
    }
    return [...nights].sort();
  }

  /**
   * 生成某夜次的新版本报告（草稿）。若该夜次已有签署版，签署版保持
   * 原样，本方法只追加新的草稿版本。未显式给出 excludedRanges 时，
   * 沿用该夜次上一版报告的排除段（技师的判读决定随版本继承）。
   */
  generateReport(
    nightId: string,
    options?: { excludedRanges?: ExcludedRangeInput[] },
  ): VersionedReport {
    const history = this.reportIdsByNight.get(nightId) ?? [];
    const previous = history.length > 0 ? this.reports.get(history[history.length - 1]!) : undefined;
    const excludedRanges = options?.excludedRanges ?? previous?.excludedRanges ?? [];
    for (const stream of this.streams.values()) {
      const clock = new DeviceClock(stream.anchors);
      const samples = expandBatches(stream.batches, clock);
      const timeline = buildNightTimelines(samples, stream.subjectId).find(
        (t) => t.nightId === nightId,
      );
      if (!timeline) continue;

      const quality: QualityAssessment = assessQuality(timeline, excludedRanges);
      const pulse = timeline.samples.filter(
        (s) =>
          s.channel === "pulse-wave" &&
          !s.qualityFlags.includes("low-perfusion") &&
          !s.qualityFlags.includes("off-wrist"),
      );
      const actigraphy = timeline.samples.filter((s) => s.channel === "actigraphy");
      const events = detectCandidateEvents(nightId, quality.validSpo2Samples, pulse, actigraphy);
      const metrics = computeNightMetrics(timeline, quality, events, excludedRanges);

      const version = history.length + 1;
      const supersedesReportId = history[history.length - 1];
      const createdAt = this.now().toISOString();

      const payload: ReportPayload = {
        subjectId: stream.subjectId,
        generatedAt: createdAt,
        timeCorrection: {
          anchorsUsed: clock.anchorCount,
          observedDriftPpm: clock.observedDriftPpm().map((p) => Math.round(p * 10) / 10),
          extrapolatedSampleCount: samples.filter((s) => s.extrapolated).length,
        },
        segments: timeline.segments,
        events,
        metrics,
        uninterpretable: quality.uninterpretable,
        qualityNotes: quality.notes,
        recommendation: buildRecommendation(metrics),
        disclaimer: SCREENING_DISCLAIMER,
      };

      const report: VersionedReport = {
        reportId: `rpt-${nightId}-v${version}`,
        nightId,
        state: "draft",
        algorithmVersion: ALGORITHM_VERSION,
        includedBatchIds: [...new Set(timeline.samples.map((s) => s.batchId))].sort(),
        excludedRanges: excludedRanges.map((r) => ({ ...r })),
        version,
        createdAt,
        payload,
        ...(supersedesReportId ? { supersedesReportId } : {}),
      };
      this.reports.set(report.reportId, report);
      this.reportIdsByNight.set(nightId, [...history, report.reportId]);
      return report;
    }
    throw new Error(`未找到夜次 ${nightId} 的采集数据`);
  }

  /**
   * 签署当前最新草稿。签署后版本冻结（深冻结），再次签署或试图
   * 签署已被取代的旧草稿都会报错。
   */
  sign(reportId: string): VersionedReport {
    const report = this.reports.get(reportId);
    if (!report) throw new Error(`报告不存在: ${reportId}`);
    if (report.state === "signed") {
      throw new Error(`报告 ${reportId} 已签署，签署版不可变更`);
    }
    const history = this.reportIdsByNight.get(report.nightId) ?? [];
    if (history[history.length - 1] !== reportId) {
      throw new Error(`报告 ${reportId} 已被更新版本取代，请签署最新草稿`);
    }
    const signed: VersionedReport = {
      ...report,
      state: "signed",
      signedAt: this.now().toISOString(),
    };
    deepFreeze(signed);
    this.reports.set(reportId, signed);
    return signed;
  }

  getReport(reportId: string): VersionedReport | undefined {
    return this.reports.get(reportId);
  }

  history(nightId: string): VersionedReport[] {
    return (this.reportIdsByNight.get(nightId) ?? [])
      .map((id) => this.reports.get(id))
      .filter((r): r is VersionedReport => r !== undefined);
  }
}
