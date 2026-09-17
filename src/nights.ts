/**
 * 夜次归组。
 *
 * 夜次按“正午 → 次日正午”划分（见 timezone.nightIdFor），因此：
 * - 跨午夜睡眠自然属于同一夜次；
 * - 半夜摘下设备再重戴，只是夜内的段间缺口，不会拆出新夜次；
 * - 短暂清醒（体动监测到的觉醒）只是夜内事件，记入质量说明。
 */

import type { OvernightStream } from "./ingest.js";
import { DeviceClock } from "./clock.js";
import { nightIdFor } from "./timezone.js";
import type { ChannelSeries } from "./series.js";

/** 数据流中出现过的全部夜次，按时间先后排序。 */
export function listNightIds(stream: OvernightStream, clock: DeviceClock): string[] {
  const firstMonoByNight = new Map<string, number>();
  for (const batch of stream.batches) {
    // 批次可能横跨正午边界，首尾样本都要归组
    const batchEndMono =
      batch.startedAtMonotonicMillis + (batch.values.length - 1) * batch.intervalMillis;
    for (const mono of [batch.startedAtMonotonicMillis, batchEndMono]) {
      const nightId = nightIdFor(clock.correct(mono).epochMillis, stream.timeZone);
      const existing = firstMonoByNight.get(nightId);
      if (existing === undefined || mono < existing) {
        firstMonoByNight.set(nightId, mono);
      }
    }
  }
  return [...firstMonoByNight.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([nightId]) => nightId);
}

export interface WakeBout {
  fromMono: number;
  toMono: number;
}

export interface WakeBoutOptions {
  /** 体动计数达到该值视为清醒。 */
  wakeThreshold: number;
  /** 持续达到该时长才记为一次清醒（毫秒）。 */
  minBoutMillis: number;
  /** 超过该时长的清醒不再算“短暂”，单独说明（毫秒）。 */
  briefLimitMillis: number;
  /** 样本缺口超过该时长则清醒段断开（设备离腕不算清醒）（毫秒）。 */
  maxSampleGapMillis: number;
}

/** 从体动序列中识别清醒段（用于“短暂清醒”质量说明）。 */
export function detectWakeBouts(
  actigraphy: ChannelSeries,
  options: WakeBoutOptions,
): Array<WakeBout & { brief: boolean }> {
  const bouts: Array<WakeBout & { brief: boolean }> = [];
  let boutStart: number | null = null;
  let boutEnd = 0;
  const close = (): void => {
    if (boutStart === null) return;
    if (boutEnd - boutStart >= options.minBoutMillis) {
      bouts.push({
        fromMono: boutStart,
        toMono: boutEnd,
        brief: boutEnd - boutStart <= options.briefLimitMillis,
      });
    }
    boutStart = null;
  };
  let previous: { mono: number; interval: number } | null = null;
  for (const sample of actigraphy.samples) {
    // 样本缺口（如设备离腕）会打断清醒段：离腕期间没有体动证据
    if (previous !== null && sample.mono - (previous.mono + previous.interval) > options.maxSampleGapMillis) {
      close();
    }
    const awake = sample.value !== null && sample.value >= options.wakeThreshold;
    if (awake) {
      if (boutStart === null) boutStart = sample.mono;
      boutEnd = sample.mono + sample.interval;
    } else {
      close();
    }
    previous = sample;
  }
  close();
  return bouts;
}
