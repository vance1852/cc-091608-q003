/**
 * 报告版本存储。
 *
 * 规则：
 * - 每次生成都产生新草稿，版本号在同一夜次内递增；
 * - 草稿可签署，签署时记录 signedAt；
 * - 已签署的版本保持原样、不可更改；后续补传数据或技师排除片段，
 *   只会生成新的草稿版本，绝不回写已签署报告。
 */

import type { NightReportBase, NightReportDetail } from "./report.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export class ReportStore {
  private readonly versionsByNight = new Map<string, NightReportDetail[]>();

  /** 基于最新分析结果生成新草稿（版本号 = 该夜次已有版本数 + 1）。 */
  createDraft(base: NightReportBase): NightReportDetail {
    const versions = this.versionsByNight.get(base.nightId) ?? [];
    const version = versions.length + 1;
    const draft: NightReportDetail = deepFreeze({
      ...base,
      reportId: `${base.nightId}-v${version}`,
      version,
      state: "draft",
    });
    versions.push(draft);
    this.versionsByNight.set(base.nightId, versions);
    return draft;
  }

  /** 签署草稿；已签署的报告再次签署会报错。 */
  sign(reportId: string, signedAt: string): NightReportDetail {
    const located = this.locate(reportId);
    if (located.report.state === "signed") {
      throw new Error(`报告 ${reportId} 已签署，不能重复签署`);
    }
    const signed: NightReportDetail = deepFreeze({
      ...located.report,
      state: "signed",
      signedAt,
    });
    located.versions[located.index] = signed;
    return signed;
  }

  get(reportId: string): NightReportDetail | undefined {
    for (const versions of this.versionsByNight.values()) {
      const found = versions.find((report) => report.reportId === reportId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** 某夜次的全部版本，按版本号升序。 */
  listForNight(nightId: string): readonly NightReportDetail[] {
    return this.versionsByNight.get(nightId) ?? [];
  }

  private locate(reportId: string): {
    report: NightReportDetail;
    versions: NightReportDetail[];
    index: number;
  } {
    for (const versions of this.versionsByNight.values()) {
      const index = versions.findIndex((report) => report.reportId === reportId);
      if (index >= 0) return { report: versions[index]!, versions, index };
    }
    throw new Error(`报告不存在: ${reportId}`);
  }
}
