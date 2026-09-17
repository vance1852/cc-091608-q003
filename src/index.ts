/**
 * 居家睡眠呼吸初筛模块的公共入口。
 */

export type {
  ClockAnchor,
  SampleBatch,
  ScreeningReport,
  SleepChannel,
  ReportState,
} from "./contracts.js";
export { DeviceClock, type CorrectedInstant } from "./clock.js";
export { parseOvernightStream, type OvernightStream } from "./ingest.js";
export {
  nightIdFor,
  nightWindowFor,
  formatWallTime,
  localParts,
  offsetMillisAt,
} from "./timezone.js";
export {
  buildChannelSeries,
  segmentSeries,
  isIndexable,
  INDEX_INVALIDATING_FLAGS,
  UNINTERPRETABLE_REASON_TEXT,
  type ChannelSeries,
  type ExclusionRangeWall,
  type TimedSample,
  type UninterpretableReason,
  type WearSegment,
} from "./series.js";
export { listNightIds, detectWakeBouts } from "./nights.js";
export {
  detectCandidateEvents,
  DEFAULT_EVENT_OPTIONS,
  type CandidateEvent,
  type EventDetectionOptions,
} from "./events.js";
export {
  computeDenominator,
  judgeInterpretability,
  DEFAULT_QUALITY_POLICY,
  type QualityPolicy,
  type ValidDenominator,
} from "./quality.js";
export {
  ALGORITHM_VERSION,
  analyzeNight,
  analyzeStream,
  type AnalysisOptions,
  type AnalyzedEvent,
  type NightAnalysis,
  type NightIndex,
  type ReferralAdvice,
  type UninterpretableInterval,
} from "./analysis.js";
export {
  composeReportBase,
  summarizeReport,
  SCREENING_DISCLAIMER,
  type NightReportBase,
  type NightReportDetail,
} from "./report.js";
export { ReportStore } from "./store.js";
