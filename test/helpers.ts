/**
 * 测试辅助：构造合成数据流与样本。
 */

import type { ClockAnchor, SampleBatch } from "../src/contracts.js";
import type { OvernightStream } from "../src/ingest.js";
import type { TimedSample } from "../src/series.js";

export const TEST_TZ = "Asia/Shanghai";

export function makeAnchor(
  monotonicMillis: number,
  wallTime: string,
  uncertaintyMillis = 100,
): ClockAnchor {
  return { monotonicMillis, wallTime, uncertaintyMillis };
}

export function makeBatch(partial: Partial<SampleBatch> & { batchId: string }): SampleBatch {
  return {
    subjectId: "test-subject",
    channel: "spo2",
    startedAtMonotonicMillis: 0,
    intervalMillis: 1000,
    values: [96],
    qualityFlags: [],
    ...partial,
  };
}

export function makeStream(overrides: Partial<OvernightStream> = {}): OvernightStream {
  return {
    subjectId: "test-subject",
    timeZone: TEST_TZ,
    anchors: [makeAnchor(0, "2026-09-15T22:00:00+08:00")],
    batches: [],
    ...overrides,
  };
}

export function makeSample(
  mono: number,
  value: number | null,
  overrides: Partial<TimedSample> = {},
): TimedSample {
  return {
    mono,
    interval: 1000,
    value,
    batchId: "b1",
    batchFlags: [],
    excluded: false,
    ...overrides,
  };
}

/**
 * 构造一段血氧序列：baseline 平线中插入若干次下降事件。
 * events: [起始秒, 持续秒, 谷值]
 */
export function spo2SeriesWithEvents(
  totalSeconds: number,
  baseline: number,
  events: Array<[startSec: number, durationSec: number, nadir: number]>,
  intervalMillis = 1000,
): TimedSample[] {
  const samples: TimedSample[] = [];
  for (let ms = 0; ms < totalSeconds * 1000; ms += intervalMillis) {
    const sec = ms / 1000;
    let value = baseline;
    for (const [start, duration, nadir] of events) {
      if (sec >= start && sec < start + duration) value = nadir;
    }
    samples.push(makeSample(ms, value, { interval: intervalMillis }));
  }
  return samples;
}
