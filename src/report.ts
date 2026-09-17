/**
 * 报告明细：在 contracts.ScreeningReport 的骨架上扩展出医师需要的全部内容
 * ——事件时间轴、有效分母、质量说明、转诊建议与指标溯源。
 *
 * 报告仅用于初筛沟通，任何页面都必须携带非诊断声明。
 */

import type { ScreeningReport } from "./contracts.js";
import type {
  AnalyzedEvent,
  MetricProvenance,
  NightAnalysis,
  NightIndex,
  ReferralAdvice,
  UninterpretableInterval,
} from "./analysis.js";
import { type ValidDenominator } from "./quality.js";
import type { ExclusionRangeWall } from "./series.js";

export const SCREENING_DISCLAIMER =
  "本报告为居家初筛结果，用于沟通与分诊参考，不能替代多导睡眠监测等正式诊断结论。";

export interface DenominatorView {
  validMinutes: number;
  windowMinutes: number;
  coverageRatio: number;
}

export interface NightReportDetail extends ScreeningReport {
  /** 同一夜次的报告版本号（从 1 开始递增）。 */
  version: number;
  subjectId: string;
  timeZone: string;
  generatedAt: string;
  window: { fromWall: string; toWall: string } | null;
  interpretable: boolean;
  interpretabilityReasons: string[];
  /** 有效分母：指数只建立在有效血氧监测时长之上。 */
  validDenominator: DenominatorView | null;
  index: NightIndex | null;
  eventTimeline: AnalyzedEvent[];
  uninterpretableIntervals: UninterpretableInterval[];
  qualityNotes: string[];
  referral: ReferralAdvice;
  clockSummary: { driftPpm: number | null; extrapolatedTail: boolean };
  provenance: MetricProvenance[];
  disclaimer: string;
}

/** 不含版本字段的报告主体：每次重新生成都从分析结果重建。 */
export type NightReportBase = Omit<
  NightReportDetail,
  "reportId" | "version" | "state" | "signedAt"
>;

export interface ComposeMeta {
  subjectId: string;
  timeZone: string;
  generatedAt: string;
}

function toDenominatorView(denominator: ValidDenominator | null): DenominatorView | null {
  if (denominator === null) return null;
  return {
    validMinutes: Math.round((denominator.validMillis / 60_000) * 10) / 10,
    windowMinutes: Math.round((denominator.windowMillis / 60_000) * 10) / 10,
    coverageRatio: Math.round(denominator.coverageRatio * 1000) / 1000,
  };
}

/** 把夜次分析结果组装成报告主体（不含版本/签署字段，由 ReportStore 补充）。 */
export function composeReportBase(
  analysis: NightAnalysis,
  meta: ComposeMeta,
): NightReportBase {
  return {
    nightId: analysis.nightId,
    algorithmVersion: analysis.algorithmVersion,
    includedBatchIds: analysis.includedBatchIds,
    excludedRanges: analysis.excludedRanges.map((range: ExclusionRangeWall) => ({
      from: range.from,
      to: range.to,
      reason: range.reason,
    })),
    subjectId: meta.subjectId,
    timeZone: meta.timeZone,
    generatedAt: meta.generatedAt,
    window: analysis.window,
    interpretable: analysis.interpretable,
    interpretabilityReasons: analysis.interpretabilityReasons,
    validDenominator: toDenominatorView(analysis.denominator),
    index: analysis.index,
    eventTimeline: analysis.events,
    uninterpretableIntervals: analysis.uninterpretableIntervals,
    qualityNotes: analysis.qualityNotes,
    referral: analysis.referral,
    clockSummary: analysis.clockSummary,
    provenance: analysis.provenance,
    disclaimer: SCREENING_DISCLAIMER,
  };
}

/** 供终端/日志展示的中文摘要。 */
export function summarizeReport(report: NightReportDetail): string {
  const lines: string[] = [];
  lines.push(
    `报告 ${report.reportId}（${report.state === "signed" ? "已签署" : "草稿"} v${report.version}，` +
      `算法 ${report.algorithmVersion}）`,
  );
  lines.push(`夜次 ${report.nightId}｜受试者 ${report.subjectId}｜生成于 ${report.generatedAt}`);
  if (report.window !== null) {
    lines.push(`监测窗口：${report.window.fromWall} → ${report.window.toWall}`);
  }
  if (report.validDenominator !== null) {
    const d = report.validDenominator;
    lines.push(
      `有效分母：${d.validMinutes} 分钟 / 窗口 ${d.windowMinutes} 分钟` +
        `（覆盖率 ${(d.coverageRatio * 100).toFixed(1)}%）`,
    );
  }
  if (report.index !== null) {
    lines.push(
      `初筛指数：每有效小时候选事件 ${report.index.eventsPerValidHour} 次` +
        `（${report.index.eventCount} 件 / ${report.index.validHours} 有效小时）`,
    );
  } else {
    lines.push("初筛指数：不予计算（证据不足，避免误导）");
    for (const reason of report.interpretabilityReasons) lines.push(`  - ${reason}`);
  }
  if (report.uninterpretableIntervals.length > 0) {
    lines.push("不可判读区间：");
    for (const interval of report.uninterpretableIntervals) {
      lines.push(`  - ${interval.fromWall} → ${interval.toWall}：${interval.reasonText}`);
    }
  }
  if (report.eventTimeline.length > 0) {
    lines.push(`候选事件时间轴（共 ${report.eventTimeline.length} 件）：`);
    for (const event of report.eventTimeline) {
      const flags: string[] = [];
      if (event.pulseResponse === true) flags.push("伴脉率上升");
      if (event.movementArtifact) flags.push("体动干扰");
      if (event.partial) flags.push("触及不可判读区间，未计入指数");
      lines.push(
        `  - ${event.startWall} → ${event.endWall}` +
          `（持续 ${Math.round(event.durationMillis / 1000)} 秒，` +
          `谷值 ${event.nadirSpo2}%，下降 ${event.dropPct}%，可信度 ${event.confidence}` +
          `${flags.length > 0 ? `，${flags.join("，")}` : ""}）`,
      );
    }
  }
  if (report.qualityNotes.length > 0) {
    lines.push("质量说明：");
    for (const note of report.qualityNotes) lines.push(`  - ${note}`);
  }
  lines.push(`转诊建议：${report.referral.recommended ? "建议转正式睡眠检查" : "暂不转诊"}`);
  for (const rationale of report.referral.rationale) lines.push(`  - ${rationale}`);
  lines.push(`声明：${report.disclaimer}`);
  return lines.join("\n");
}
