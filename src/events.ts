import type { CorrectedSample } from "./nights.ts";
import { ACTIGRAPHY_WAKE_THRESHOLD } from "./nights.ts";

/**
 * 候选低氧事件识别（初筛级别，非诊断）。
 *
 * 在“有效血氧样本”上运行：以滑动窗口中位数为基线，下降 ≥3 个百分点、
 * 持续 ≥10 秒记为候选 desat 事件；联合脉搏波（事件末脉搏上升）佐证、
 * 体动（事件中体动）提示伪差风险。所有事件都只是 candidate，
 * 未经脑电证实，报告中必须保持这一措辞。
 */

export const DESAT_DROP_PERCENT = 3;
export const DESAT_RECOVERY_MARGIN = 1;
export const MIN_EVENT_DURATION_MILLIS = 10_000;
export const MAX_EVENT_DURATION_MILLIS = 240_000;
export const BASELINE_WINDOW_MILLIS = 120_000;
export const BASELINE_MIN_SAMPLES = 30;
export const PULSE_RISE_MIN_BPM = 6;
/** 有效序列中断超过该时长，进行中的事件无法确认恢复，予以丢弃。 */
export const EVENT_CONTINUITY_GAP_MILLIS = 30_000;

export interface CandidateEvent {
  eventId: string;
  nightId: string;
  startedAt: string;
  endedAt: string;
  nadirAt: string;
  baselineSpo2: number;
  nadirSpo2: number;
  dropPercent: number;
  durationSeconds: number;
  /** 佐证，如 "pulse-rise"。 */
  corroborations: string[];
  /** 警示，如 "motion-present"。 */
  cautions: string[];
  confidence: "corroborated" | "candidate";
  sourceBatchIds: string[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface OpenEvent {
  start: CorrectedSample;
  baseline: number;
  nadir: number;
  nadirAt: CorrectedSample;
  samples: CorrectedSample[];
}

export function detectCandidateEvents(
  nightId: string,
  validSpo2: CorrectedSample[],
  pulseWave: CorrectedSample[],
  actigraphy: CorrectedSample[],
): CandidateEvent[] {
  const events: CandidateEvent[] = [];
  let open: OpenEvent | undefined;
  let previous: CorrectedSample | undefined;

  const closeEvent = (recovery: CorrectedSample) => {
    const finished = open;
    open = undefined;
    if (!finished) return;
    const durationMillis = recovery.epochMillis - finished.start.epochMillis;
    const drop = finished.baseline - finished.nadir;
    if (durationMillis < MIN_EVENT_DURATION_MILLIS || drop < DESAT_DROP_PERCENT) return;

    const start = finished.start;
    const cautions: string[] = [];
    if (durationMillis > MAX_EVENT_DURATION_MILLIS) cautions.push("prolonged");

    // 脉搏佐证：事件前 60s 基线 vs 结束后 20s 内最大脉搏。
    const prePulse: number[] = [];
    const postPulse: number[] = [];
    for (const p of pulseWave) {
      if (p.value === null) continue;
      if (p.epochMillis >= start.epochMillis - 60_000 && p.epochMillis < start.epochMillis) {
        prePulse.push(p.value);
      } else if (
        p.epochMillis >= recovery.epochMillis - 10_000 &&
        p.epochMillis <= recovery.epochMillis + 20_000
      ) {
        postPulse.push(p.value);
      }
    }
    const corroborations: string[] = [];
    if (prePulse.length >= 10 && postPulse.length >= 3) {
      const rise = Math.max(...postPulse) - median(prePulse);
      if (rise >= PULSE_RISE_MIN_BPM) corroborations.push("pulse-rise");
    }

    // 体动警示：事件窗口内出现明显体动，提示伪差可能。
    const motion = actigraphy.some(
      (a) =>
        a.value !== null &&
        a.value >= ACTIGRAPHY_WAKE_THRESHOLD &&
        a.epochMillis < recovery.epochMillis &&
        a.epochMillis + a.intervalMillis > start.epochMillis,
    );
    if (motion) cautions.push("motion-present");

    events.push({
      eventId: `evt-${nightId}-${String(events.length + 1).padStart(3, "0")}`,
      nightId,
      startedAt: start.wallIso,
      endedAt: recovery.wallIso,
      nadirAt: finished.nadirAt.wallIso,
      baselineSpo2: Math.round(finished.baseline * 10) / 10,
      nadirSpo2: Math.round(finished.nadir * 10) / 10,
      dropPercent: Math.round(drop * 10) / 10,
      durationSeconds: Math.round(durationMillis / 1000),
      corroborations,
      cautions,
      confidence: corroborations.includes("pulse-rise") && !motion ? "corroborated" : "candidate",
      sourceBatchIds: [...new Set(finished.samples.map((s) => s.batchId))].sort(),
    });
  };

  for (let i = 0; i < validSpo2.length; i += 1) {
    const sample = validSpo2[i]!;
    if (sample.value === null) continue;
    if (previous && sample.epochMillis - previous.epochMillis > EVENT_CONTINUITY_GAP_MILLIS) {
      // 有效序列中断：进行中的事件无法确认恢复，丢弃。
      open = undefined;
    }
    previous = sample;

    // 前 120s 滑动窗口基线（不含当前样本）。
    const windowValues: number[] = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const s = validSpo2[j]!;
      if (s.epochMillis < sample.epochMillis - BASELINE_WINDOW_MILLIS) break;
      if (s.value !== null) windowValues.push(s.value);
    }
    const baseline =
      windowValues.length >= BASELINE_MIN_SAMPLES ? median(windowValues) : undefined;

    if (!open) {
      if (baseline !== undefined && sample.value <= baseline - DESAT_DROP_PERCENT) {
        open = {
          start: sample,
          baseline,
          nadir: sample.value,
          nadirAt: sample,
          samples: [sample],
        };
      }
    } else {
      open.samples.push(sample);
      if (sample.value < open.nadir) {
        open.nadir = sample.value;
        open.nadirAt = sample;
      }
      if (sample.value >= open.baseline - DESAT_RECOVERY_MARGIN) {
        closeEvent(sample);
      }
    }
  }
  // 夜末仍未恢复的事件不纳入（无法确认是一次完整事件）。
  return events;
}
