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

export interface ScreeningReport {
  reportId: string;
  nightId: string;
  state: ReportState;
  algorithmVersion: string;
  includedBatchIds: string[];
  excludedRanges: Array<{ from: string; to: string; reason: string }>;
  signedAt?: string;
}
