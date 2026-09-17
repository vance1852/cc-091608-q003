/**
 * 生成 fixtures/overnight-stream.json（脱敏合成数据，可复现）。
 *
 * 夜次 2026-09-15（Asia/Shanghai），受试者 sleep-29：
 * - 22:45 开始佩戴；两个同步锚点体现约 +185ppm 的手机时钟漂移；
 * - 01:28–02:06 摘下设备（全通道数据缺口），随后重新佩戴；
 * - 03:00–03:20 血氧降采样（30s 间隔）；04:50–05:20 探头低灌注；
 * - 03:20–03:31 短暂清醒（体动）；整夜 40 次血氧下降事件，其中 2 次伴体动伪差；
 * - 末段数据超出最后一个锚点，用于演示时钟外推标记。
 *
 * 运行：npm run generate:fixture
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const T0_MONO = 1000; // 首个锚点的单调时钟，对应 22:45:00+08:00
const mono = (tSeconds) => T0_MONO + tSeconds * 1000;

// 确定性伪随机，保证夹具可复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260915);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---- 场景常量（秒，自 22:45:00 起） ----
const OFF_WRIST = { from: 9780, to: 12060 }; // 01:28–02:06 摘下设备
const COARSE = { from: 15300, to: 16500 }; // 03:00–03:20 血氧降采样
const LOW_PERFUSION = { from: 21900, to: 23700 }; // 04:50–05:20 低灌注
const WAKE_BOUT = { from: 16500, to: 16860 }; // 03:20–03:31 短暂清醒
const MORNING_WAKE_FROM = 26700; // 06:10 起逐渐清醒
const RECORDING_END = 27900; // 06:30 结束
const NULL_RUNS = [
  { from: 6000, to: 6012 },
  { from: 20000, to: 20008 },
];
const MOVEMENT_WINDOWS = [
  { from: 3590, to: 3720 }, // 污染 3600 的事件
  { from: 24590, to: 24720 }, // 污染 24600 的事件
];

// 血氧下降事件：起始秒 + 时长 + 谷值
const desatEvents = [];
for (let t = 1200; t <= 8400; t += 300) desatEvents.push({ start: t });
for (let t = 13500; t < 15300; t += 300) desatEvents.push({ start: t });
for (let t = 24300; t <= 26700; t += 300) desatEvents.push({ start: t });
desatEvents.forEach((event, index) => {
  event.dur = 24 + (index % 3) * 6;
  event.nadir = 88 + (index % 3);
});

const inRange = (t, range) => t >= range.from && t < range.to;
const eventAt = (t) =>
  desatEvents.find((event) => t >= event.start && t < event.start + event.dur);

function spo2Value(t) {
  if (NULL_RUNS.some((run) => inRange(t, run))) return null;
  if (inRange(t, LOW_PERFUSION)) return randInt(90, 97); // 低灌注：抖动剧烈，不可信
  const event = eventAt(t);
  const baseline = rand() < 0.15 ? 95 : rand() < 0.85 ? 96 : 97;
  if (!event) return baseline;
  const offset = t - event.start;
  if (offset < 8) return Math.round(96 - ((96 - event.nadir) * offset) / 8);
  if (offset >= event.dur - 8) {
    return Math.round(event.nadir + ((96 - event.nadir) * (offset - (event.dur - 8))) / 8);
  }
  return event.nadir + randInt(0, 1);
}

function pulseValue(t) {
  if (inRange(t, LOW_PERFUSION)) return randInt(55, 80);
  if (MOVEMENT_WINDOWS.some((w) => inRange(t, w))) return randInt(78, 92);
  let value = 60 + randInt(-2, 2);
  for (const event of desatEvents) {
    const end = event.start + event.dur;
    if (t >= event.start && t <= end + 40) {
      const peak = end + 10;
      const bump =
        t <= peak
          ? (10 * (t - event.start)) / (peak - event.start)
          : 10 * (1 - (t - peak) / 30);
      value += Math.max(0, Math.round(bump));
    }
  }
  return value;
}

function actigraphyValue(t) {
  if (inRange(t, WAKE_BOUT)) return randInt(60, 140);
  if (MOVEMENT_WINDOWS.some((w) => t + 30 > w.from && t < w.to)) return randInt(45, 95);
  if (t >= 9690 && t < OFF_WRIST.from) return randInt(70, 110); // 摘设备时的动作
  if (t >= OFF_WRIST.to && t < OFF_WRIST.to + 30) return randInt(60, 100); // 重新佩戴
  if (t >= MORNING_WAKE_FROM) return randInt(25, 85);
  return randInt(0, 12);
}

// ---- 批次布局 ----
function makeBatches(channel, spans, intervalSeconds, valueFn) {
  const batches = [];
  spans.forEach(([from, to, flags], spanIndex) => {
    const interval = channel === "spo2" && from === COARSE.from ? 30 : intervalSeconds;
    const values = [];
    for (let t = from; t < to; t += interval) values.push(valueFn(t));
    batches.push({
      batchId: `${channel === "pulse-wave" ? "pw" : channel === "actigraphy" ? "act" : "spo2"}-b${String(spanIndex + 1).padStart(2, "0")}`,
      channel,
      startedAtMonotonicMillis: mono(from),
      intervalMillis: interval * 1000,
      values,
      qualityFlags: flags,
    });
  });
  return batches;
}

const SPO2_SPANS = [
  [4, 1804, []],
  [1804, 3604, []],
  [3604, 5404, []],
  [5404, 7204, []],
  [7204, 9004, []],
  [9004, OFF_WRIST.from, []],
  [OFF_WRIST.to, 13860, []],
  [13860, COARSE.from, []],
  [COARSE.from, COARSE.to, []],
  [COARSE.to, 18300, []],
  [18300, 20100, []],
  [20100, LOW_PERFUSION.from, []],
  [LOW_PERFUSION.from, LOW_PERFUSION.to, ["low-perfusion"]],
  [LOW_PERFUSION.to, 25500, []],
  [25500, 27300, []],
  [27300, RECORDING_END, []],
];

const PULSE_SPANS = SPO2_SPANS.filter(([from]) => from !== COARSE.from).concat([
  [COARSE.from, COARSE.to, []],
]);

const ACTIGRAPHY_SPANS = [
  [0, 1800, []],
  [1800, 3600, []],
  [3600, 5400, []],
  [5400, 7200, []],
  [7200, 9000, []],
  [9000, OFF_WRIST.from, []],
  [OFF_WRIST.to, 13860, []],
  [13860, 15660, []],
  [15660, 17460, []],
  [17460, 19260, []],
  [19260, 21060, []],
  [21060, 22860, []],
  [22860, 24660, []],
  [24660, 26460, []],
  [26460, RECORDING_END, []],
];

const batches = [
  // 原始批次（含低灌注标记与 null 样本），原样保留
  {
    batchId: "spo2-a",
    channel: "spo2",
    startedAtMonotonicMillis: 1000,
    intervalMillis: 1000,
    values: [97, 96, null, 91],
    qualityFlags: ["low-perfusion"],
  },
  ...makeBatches("spo2", SPO2_SPANS, 4, spo2Value),
  ...makeBatches("pulse-wave", PULSE_SPANS, 4, pulseValue),
  ...makeBatches("actigraphy", ACTIGRAPHY_SPANS, 30, actigraphyValue),
].sort((a, b) => a.startedAtMonotonicMillis - b.startedAtMonotonicMillis);

const stream = {
  subjectId: "sleep-29",
  timezone: "Asia/Shanghai",
  anchors: [
    { monotonicMillis: 1000, wallTime: "2026-09-15T22:45:00+08:00", uncertaintyMillis: 120 },
    {
      monotonicMillis: 21601000,
      wallTime: "2026-09-16T04:45:04+08:00",
      uncertaintyMillis: 180,
    },
  ],
  batches,
};

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "overnight-stream.json");
writeFileSync(target, JSON.stringify(stream));
console.log(
  `已生成 ${target}：${batches.length} 个批次，` +
    `${batches.reduce((sum, batch) => sum + batch.values.length, 0)} 个样本，` +
    `${desatEvents.length} 次血氧下降事件`,
);
