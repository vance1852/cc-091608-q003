export type SleepChannel = "spo2" | "pulse-wave" | "actigraphy";
export type ReportState = "draft" | "signed";

export interface ClockAnchor {
  monotonicMillis: number;
  wallTime: string;
  uncertaintyMillis: number;
}

export interface SampleBatch {
  batchId: string;
  subjectId: string;
  channel: SleepChannel;
  startedAtMonotonicMillis: number;
  intervalMillis: number;
  values: Array<number | null>;
  qualityFlags: string[];
}

/**
 * 一段连续佩戴记录。夜次归属以本地正午为界（夜次 2026-09-15 覆盖
 * 2026-09-15 12:00 至 2026-09-16 12:00 本地时间），因此跨午夜睡眠与
 * 中途摘下后重戴都归入同一夜次，只是拆成多个睡眠段。
 */
export interface SleepSegment {
  segmentId: string;
  nightId: string;
  kind: "wear";
  startedAt: string;
  endedAt: string;
  batchIds: string[];
}

export interface ScreeningReport {
  reportId: string;
  nightId: string;
  state: ReportState;
  algorithmVersion: string;
  includedBatchIds: string[];
  excludedRanges: Array<{ from: string; to: string; reason: string }>;
  signedAt?: string;
}
