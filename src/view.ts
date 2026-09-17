import type { MetricResult } from "./metrics.ts";
import type { VersionedReport } from "./report.ts";

/**
 * 医师视图：同一屏看到事件时间轴、有效分母、质量说明与转诊建议，
 * 每个指标都能追溯到批次与算法版本。
 */

function metricLine(name: string, metric: MetricResult): string {
  if (metric.status === "not-interpretable") {
    return `  ${name}: 不可判读（${metric.reasons.join("；")}）`;
  }
  return `  ${name}: ${metric.value} ${metric.unit}`;
}

function provenanceLine(metric: MetricResult): string {
  const p = metric.provenance;
  const excluded =
    p.excludedRanges.length > 0
      ? p.excludedRanges.map((r) => `${r.from}~${r.to}(${r.reason})`).join(", ")
      : "无";
  return (
    `    溯源: 算法 ${p.algorithmVersion}；有效分母 ${p.validDenominatorMinutes} 分钟；` +
    `批次 ${p.batchIds.join(", ") || "无"}；排除区间 ${excluded}`
  );
}

export function renderPhysicianView(report: VersionedReport): string {
  const p = report.payload;
  const m = p.metrics;
  const lines: string[] = [];

  lines.push(`居家睡眠呼吸初筛报告（非诊断）  ${report.reportId}`);
  lines.push(
    `受试者 ${p.subjectId}  夜次 ${report.nightId}  版本 v${report.version}  状态 ${
      report.state === "signed" ? `已签署(${report.signedAt})` : "草稿"
    }  算法 ${report.algorithmVersion}`,
  );
  lines.push("");

  lines.push("■ 时间校正");
  lines.push(
    `  同步锚点 ${p.timeCorrection.anchorsUsed} 个；观测漂移 ${p.timeCorrection.observedDriftPpm.join(", ")} ppm；` +
      `锚点外外推样本 ${p.timeCorrection.extrapolatedSampleCount} 个`,
  );
  lines.push("");

  lines.push("■ 佩戴分段（夜次以本地正午为界，跨午夜与中途重戴归入同一夜次）");
  for (const seg of p.segments) {
    lines.push(`  ${seg.segmentId}: ${seg.startedAt} ~ ${seg.endedAt}（${seg.batchIds.length} 个批次）`);
  }
  lines.push("");

  lines.push("■ 有效分母");
  lines.push(
    `  佩戴 ${m.wearMinutes} 分钟；有效血氧 ${m.validMinutes} 分钟（覆盖率 ${(m.coverageRatio * 100).toFixed(1)}%）；` +
      `体动估计睡眠 ${m.estimatedSleepMinutes} 分钟`,
  );
  lines.push("");

  lines.push("■ 不可判读区间（这些时段不参与任何指数计算）");
  if (p.uninterpretable.length === 0) {
    lines.push("  无");
  }
  for (const iv of p.uninterpretable) {
    lines.push(`  ${iv.from} ~ ${iv.to}  ${iv.reason}`);
  }
  lines.push("");

  lines.push(`■ 候选事件时间轴（共 ${m.candidateEventCount} 个，其中脉搏佐证 ${m.corroboratedEventCount} 个）`);
  if (p.events.length === 0) {
    lines.push("  有效区间内未识别到候选事件");
  }
  for (const e of p.events) {
    const tags = [...e.corroborations.map((c) => `+${c}`), ...e.cautions.map((c) => `!${c}`)];
    lines.push(
      `  ${e.startedAt.slice(11, 19)} ~ ${e.endedAt.slice(11, 19)}  ` +
        `SpO2 ${e.baselineSpo2}→${e.nadirSpo2}%（降 ${e.dropPercent}%，${e.durationSeconds}s）` +
        `  [${e.confidence}] ${tags.join(" ")}  批次:${e.sourceBatchIds.join(",")}`,
    );
  }
  lines.push("");

  lines.push("■ 指标（均可溯源）");
  lines.push(metricLine("ODI3（每小时候选低氧事件）", m.odi3));
  lines.push(provenanceLine(m.odi3));
  lines.push(metricLine("平均 SpO2", m.meanSpo2));
  lines.push(metricLine("最低 SpO2", m.minSpo2));
  lines.push("");

  lines.push("■ 质量说明");
  for (const note of p.qualityNotes) {
    lines.push(`  - ${note}`);
  }
  lines.push("");

  lines.push("■ 建议");
  lines.push(`  ${p.recommendation.text}`);
  lines.push(`  ${p.disclaimer}`);

  return lines.join("\n");
}
