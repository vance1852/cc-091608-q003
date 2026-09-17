import type { SampleBatch, SleepChannel, SleepSegment } from "./contracts.ts";
import { DeviceClock, formatIsoWithOffset } from "./clock.ts";

/**
 * 夜次归属与佩戴分段。
 *
 * 夜次以本地正午为界：夜次 D = [D 12:00, D+1 12:00) 本地时间。
 * 因此 23:00 与次日 02:00 的样本同属一夜；半夜摘下设备、稍后又戴上，
 * 只是同一夜次里的两个佩戴段，不会被拆到别的夜次。
 */

/** 任意通道连续无有效样本超过该时长，视为佩戴中断（摘下/未回传）。 */
export const PRESENCE_GAP_MILLIS = 3 * 60_000;
/** 体动计数达到该值的 epoch 判为清醒。 */
export const ACTIGRAPHY_WAKE_THRESHOLD = 10;
/** 清醒持续不超过该时长记为“短暂清醒”，仍属本夜睡眠上下文。 */
export const BRIEF_AWAKENING_MAX_MILLIS = 5 * 60_000;

export interface CorrectedSample {
  channel: SleepChannel;
  batchId: string;
  monotonicMillis: number;
  epochMillis: number;
  wallIso: string;
  offsetMinutes: number;
  /** 该样本的墙面时间是否为锚点范围外的外推值。 */
  extrapolated: boolean;
  /** 时间校正残余不确定度（毫秒）。 */
  timeUncertaintyMillis: number;
  value: number | null;
  qualityFlags: readonly string[];
  intervalMillis: number;
}

export interface TimeInterval {
  from: string;
  to: string;
  fromEpoch: number;
  toEpoch: number;
  reason: string;
}

export interface NightTimeline {
  nightId: string;
  subjectId: string;
  segments: SleepSegment[];
  /** 设备摘下区间（批次带 off-wrist 标记）。 */
  offWristIntervals: TimeInterval[];
  /** 完全无有效样本的区间（如手机断连未回传，等待补传）。 */
  noDataGaps: TimeInterval[];
  /** 短暂清醒（≤5 分钟），仅作上下文说明，不拆分夜次。 */
  briefAwakenings: TimeInterval[];
  /** 较长清醒期。 */
  wakePeriods: TimeInterval[];
  samples: CorrectedSample[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 夜次归属：本地正午到次日正午为同一夜次，夜次名为入睡晚的日期。 */
export function nightIdFor(epochMillis: number, offsetMinutes: number): string {
  const shifted = new Date(epochMillis + offsetMinutes * 60_000);
  let dayStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  if (shifted.getUTCHours() < 12) {
    dayStart -= 24 * 3_600_000;
  }
  const d = new Date(dayStart);
  return `night-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 展开批次为带校正墙面时间的样本序列（按单调时刻排序）。 */
export function expandBatches(batches: SampleBatch[], clock: DeviceClock): CorrectedSample[] {
  const out: CorrectedSample[] = [];
  for (const batch of batches) {
    for (let k = 0; k < batch.values.length; k += 1) {
      const monotonicMillis = batch.startedAtMonotonicMillis + k * batch.intervalMillis;
      const corrected = clock.toWall(monotonicMillis);
      out.push({
        channel: batch.channel,
        batchId: batch.batchId,
        monotonicMillis,
        epochMillis: corrected.epochMillis,
        wallIso: corrected.wallIso,
        offsetMinutes: corrected.offsetMinutes,
        extrapolated: corrected.extrapolated,
        timeUncertaintyMillis: corrected.uncertaintyMillis,
        value: batch.values[k] ?? null,
        qualityFlags: batch.qualityFlags,
        intervalMillis: batch.intervalMillis,
      });
    }
  }
  out.sort((a, b) => a.monotonicMillis - b.monotonicMillis);
  return out;
}

function isPresent(sample: CorrectedSample): boolean {
  return sample.value !== null && !sample.qualityFlags.includes("off-wrist");
}

function intervalFromSamples(
  samples: CorrectedSample[],
  reason: string,
  offsetMinutes: number,
): TimeInterval {
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const toEpoch = last.epochMillis + last.intervalMillis;
  return {
    from: first.wallIso,
    to: formatIsoWithOffset(toEpoch, offsetMinutes),
    fromEpoch: first.epochMillis,
    toEpoch,
    reason,
  };
}

function makeInterval(
  fromEpoch: number,
  toEpoch: number,
  reason: string,
  offsetMinutes: number,
): TimeInterval {
  return {
    from: formatIsoWithOffset(fromEpoch, offsetMinutes),
    to: formatIsoWithOffset(toEpoch, offsetMinutes),
    fromEpoch,
    toEpoch,
    reason,
  };
}

/** 体动清醒判定：把清醒段分为短暂清醒与较长清醒期。 */
function scoreWakefulness(
  actigraphy: CorrectedSample[],
  offsetMinutes: number,
): { brief: TimeInterval[]; periods: TimeInterval[] } {
  const brief: TimeInterval[] = [];
  const periods: TimeInterval[] = [];
  let run: CorrectedSample[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const interval = intervalFromSamples(run, "wake", offsetMinutes);
    if (interval.toEpoch - interval.fromEpoch <= BRIEF_AWAKENING_MAX_MILLIS) {
      brief.push({ ...interval, reason: "brief-awakening" });
    } else {
      periods.push({ ...interval, reason: "wake-period" });
    }
    run = [];
  };
  for (const s of actigraphy) {
    if (s.value !== null && s.value >= ACTIGRAPHY_WAKE_THRESHOLD) {
      run.push(s);
    } else {
      flush();
    }
  }
  flush();
  return { brief, periods };
}

/**
 * 构建全部夜次的时间线：先按夜次分组，再在夜次内按“任意通道有有效样本”
 * 的连续性切分佩戴段。段间空洞显式区分：批次带 off-wrist 标记的部分为
 * 摘下区间，完全无样本的部分为无数据区间（可能等待补传）。
 */
export function buildNightTimelines(
  samples: CorrectedSample[],
  subjectId: string,
): NightTimeline[] {
  const byNight = new Map<string, CorrectedSample[]>();
  for (const s of samples) {
    const nightId = nightIdFor(s.epochMillis, s.offsetMinutes);
    const list = byNight.get(nightId);
    if (list) list.push(s);
    else byNight.set(nightId, [s]);
  }

  const timelines: NightTimeline[] = [];
  for (const [nightId, nightSamples] of [...byNight.entries()].sort()) {
    const offsetMinutes = nightSamples[0]?.offsetMinutes ?? 0;
    const segments: SleepSegment[] = [];
    const offWristIntervals: TimeInterval[] = [];
    const noDataGaps: TimeInterval[] = [];

    let current: CorrectedSample[] = [];
    let pendingVoid: CorrectedSample[] = [];
    let lastPresent: CorrectedSample | undefined;

    const closeSegment = () => {
      if (current.length === 0) return;
      const first = current[0]!;
      const last = current[current.length - 1]!;
      const batchIds = [...new Set(current.map((s) => s.batchId))].sort();
      segments.push({
        segmentId: `${nightId}#seg-${segments.length + 1}`,
        nightId,
        kind: "wear",
        startedAt: first.wallIso,
        endedAt: formatIsoWithOffset(last.epochMillis + last.intervalMillis, offsetMinutes),
        batchIds,
      });
      current = [];
    };

    /** 把 [voidStartEpoch, voidEndEpoch) 的空洞按标记细分为摘下/无数据。 */
    const emitVoid = (voidStartEpoch: number, voidEndEpoch: number) => {
      const runs: TimeInterval[] = [];
      let run: CorrectedSample[] = [];
      let runOffWrist = false;
      const flushRun = () => {
        if (run.length === 0) return;
        runs.push(intervalFromSamples(run, runOffWrist ? "off-wrist" : "no-data", offsetMinutes));
        run = [];
      };
      for (const s of pendingVoid) {
        const off = s.qualityFlags.includes("off-wrist");
        if (run.length > 0 && off !== runOffWrist) flushRun();
        runOffWrist = off;
        run.push(s);
      }
      flushRun();
      pendingVoid = [];

      let cursor = voidStartEpoch;
      for (const r of runs) {
        // 亚秒级碎片来自批次边界的取整，没有判读意义，跳过。
        if (r.fromEpoch - cursor >= 1000) {
          noDataGaps.push(makeInterval(cursor, r.fromEpoch, "no-data", offsetMinutes));
        }
        (r.reason === "off-wrist" ? offWristIntervals : noDataGaps).push(r);
        cursor = Math.max(cursor, r.toEpoch);
      }
      if (voidEndEpoch - cursor >= 1000) {
        noDataGaps.push(makeInterval(cursor, voidEndEpoch, "no-data", offsetMinutes));
      }
    };

    for (const s of nightSamples) {
      if (isPresent(s)) {
        if (lastPresent && s.monotonicMillis - lastPresent.monotonicMillis > PRESENCE_GAP_MILLIS) {
          // 空洞超过阈值：结束当前佩戴段，并结算空洞区间。
          closeSegment();
          emitVoid(lastPresent.epochMillis + lastPresent.intervalMillis, s.epochMillis);
        } else {
          // 段内短暂 null（探头抖动等），留给质量评估处理。
          pendingVoid = [];
        }
        current.push(s);
        lastPresent = s;
      } else {
        pendingVoid.push(s);
      }
    }
    closeSegment();
    if (lastPresent && pendingVoid.length > 0) {
      const lastVoid = pendingVoid[pendingVoid.length - 1]!;
      emitVoid(
        lastPresent.epochMillis + lastPresent.intervalMillis,
        lastVoid.epochMillis + lastVoid.intervalMillis,
      );
    }

    const actigraphy = nightSamples.filter((s) => s.channel === "actigraphy");
    const { brief, periods } = scoreWakefulness(actigraphy, offsetMinutes);

    timelines.push({
      nightId,
      subjectId,
      segments,
      offWristIntervals,
      noDataGaps,
      briefAwakenings: brief,
      wakePeriods: periods,
      samples: nightSamples,
    });
  }
  return timelines;
}
