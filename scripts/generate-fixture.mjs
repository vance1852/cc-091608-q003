/**
 * 生成 fixtures/overnight-stream.json 与 fixtures/late-arrival.json。
 * 确定性（固定种子），可重复执行。用法：npm run generate:fixtures
 *
 * 夜次 2026-09-15（Asia/Shanghai）：22:45 入睡，次日 07:15 结束。
 * 内置情节：
 *  - 手机时钟漂移：三个同步锚点，6 小时漂约 4 秒；
 *  - 02:10–02:22 半夜摘下设备（off-wrist，null），02:22 重戴；
 *  - 03:30–03:44 手机断连无数据（补传文件 late-arrival.json 覆盖，
 *    其中 03:37 有一次低氧事件，首次分析时不可见）；
 *  - 05:00–05:20 血氧低灌注（探头接触不良），其中 05:08 的假性下降低于
 *    判读标准但不得计入事件；
 *  - 06:00–06:30 血氧采样降级为 10s 间隔（过疏，不可判读），06:10 的
 *    下降同样不得计入；
 *  - 01:45 与 04:47 短暂清醒，06:20–06:35 较长清醒；
 *  - 三个事件簇 + 若干单次事件，两次事件伴体动（伪差警示）。
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

// ---------- 确定性随机 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260915);

// ---------- 锚点与时钟 ----------
const ANCHORS = [
  { monotonicMillis: 1000, wallTime: "2026-09-15T22:45:00+08:00", uncertaintyMillis: 120 },
  { monotonicMillis: 21601000, wallTime: "2026-09-16T04:45:04+08:00", uncertaintyMillis: 180 },
  { monotonicMillis: 30601000, wallTime: "2026-09-16T07:15:06+08:00", uncertaintyMillis: 250 },
];
const anchorEpoch = ANCHORS.map((a) => Date.parse(a.wallTime));

function wallToMono(wallEpoch) {
  for (let i = 1; i < ANCHORS.length; i += 1) {
    if (wallEpoch <= anchorEpoch[i]) {
      const rate =
        (anchorEpoch[i] - anchorEpoch[i - 1]) /
        (ANCHORS[i].monotonicMillis - ANCHORS[i - 1].monotonicMillis);
      return ANCHORS[i - 1].monotonicMillis + (wallEpoch - anchorEpoch[i - 1]) / rate;
    }
  }
  const n = ANCHORS.length - 1;
  const rate =
    (anchorEpoch[n] - anchorEpoch[n - 1]) /
    (ANCHORS[n].monotonicMillis - ANCHORS[n - 1].monotonicMillis);
  return ANCHORS[n - 1].monotonicMillis + (wallEpoch - anchorEpoch[n - 1]) / rate;
}

function monoToWall(mono) {
  for (let i = 1; i < ANCHORS.length; i += 1) {
    if (mono <= ANCHORS[i].monotonicMillis) {
      const rate =
        (anchorEpoch[i] - anchorEpoch[i - 1]) /
        (ANCHORS[i].monotonicMillis - ANCHORS[i - 1].monotonicMillis);
      return anchorEpoch[i - 1] + (mono - ANCHORS[i - 1].monotonicMillis) * rate;
    }
  }
  const n = ANCHORS.length - 1;
  const rate =
    (anchorEpoch[n] - anchorEpoch[n - 1]) /
    (ANCHORS[n].monotonicMillis - ANCHORS[n - 1].monotonicMillis);
  return anchorEpoch[n - 1] + (mono - ANCHORS[n - 1].monotonicMillis) * rate;
}

const W = (local) => Date.parse(`${local}+08:00`);
const NIGHT_START = W("2026-09-15T22:45:00");

// ---------- 事件剧本 ----------
const events = [];
function addEvent(startLocal, durationSec, depth, extra = {}) {
  const start = W(startLocal);
  events.push({ start, end: start + durationSec * 1000, depth, rise: 8 + rand() * 4, ...extra });
}
function cluster(startLocal, count, durMin, durMax, gapMin, gapMax, depthMin, depthMax) {
  let t = W(startLocal);
  for (let i = 0; i < count; i += 1) {
    const dur = durMin + rand() * (durMax - durMin);
    const depth = depthMin + rand() * (depthMax - depthMin);
    events.push({ start: t, end: t + dur * 1000, depth, rise: 8 + rand() * 4 });
    t += (dur + gapMin + rand() * (gapMax - gapMin)) * 1000;
  }
}
cluster("2026-09-16T00:50:00", 12, 18, 50, 130, 190, 4, 7.5);
cluster("2026-09-16T04:00:00", 14, 18, 45, 110, 150, 4, 8);
cluster("2026-09-16T05:40:00", 6, 15, 25, 100, 150, 4, 6);
addEvent("2026-09-15T23:40:20", 25, 5);
addEvent("2026-09-16T02:55:30", 40, 6);
addEvent("2026-09-16T06:45:30", 22, 4.5);
// 伴体动的事件（伪差警示）
addEvent("2026-09-16T01:48:05", 20, 4, { motion: true });
addEvent("2026-09-16T04:52:10", 22, 4, { motion: true });
// 不可判读区间内的下降（低灌注 / 过疏采样），不得计入事件
addEvent("2026-09-16T05:08:00", 30, 6);
addEvent("2026-09-16T06:10:00", 30, 6);
// 仅存在于补传文件中的事件
const lateEvents = [];
{
  const start = W("2026-09-16T03:37:00");
  lateEvents.push({ start, end: start + 35_000, depth: 6, rise: 8 + rand() * 4 });
}

// ---------- 情景窗口（墙面时间 → 单调时间） ----------
const OFF_WRIST = [W("2026-09-16T02:10:00"), W("2026-09-16T02:22:00")];
const GAP = [W("2026-09-16T03:30:00"), W("2026-09-16T03:44:00")];
const LOW_PERF = [W("2026-09-16T05:00:00"), W("2026-09-16T05:20:00")];
const COARSE = [W("2026-09-16T06:00:00"), W("2026-09-16T06:30:00")];
const mono = (w) => Math.round(wallToMono(w) / 1000) * 1000;

const BRIEF_A = [W("2026-09-16T01:45:30"), W("2026-09-16T01:49:00")];
const BRIEF_B = [W("2026-09-16T04:47:00"), W("2026-09-16T04:50:30")];
const LONG_WAKE = [W("2026-09-16T06:20:00"), W("2026-09-16T06:35:00")];

// ---------- 信号模型 ----------
function dipAt(wallEpoch, eventList) {
  let dip = 0;
  for (const ev of eventList) {
    if (wallEpoch >= ev.start && wallEpoch <= ev.end) {
      const tau = (wallEpoch - ev.start) / (ev.end - ev.start);
      // 梯形剖面：20% 下降、60% 平台、20% 恢复
      const profile = tau < 0.2 ? tau / 0.2 : tau < 0.8 ? 1 : (1 - tau) / 0.2;
      dip = Math.max(dip, ev.depth * profile);
    }
  }
  return dip;
}

function spo2At(wallEpoch, eventList) {
  const base =
    95.8 +
    0.8 * Math.sin((2 * Math.PI * (wallEpoch - NIGHT_START)) / (3 * 3_600_000)) +
    (rand() - 0.5) * 0.8;
  return Math.round(Math.min(100, Math.max(70, base - dipAt(wallEpoch, eventList))));
}

function pulseAt(wallEpoch, eventList) {
  let v =
    62 +
    4 * Math.sin((2 * Math.PI * (wallEpoch - NIGHT_START)) / (2.5 * 3_600_000)) +
    (rand() - 0.5) * 3;
  for (const ev of eventList) {
    const d = (wallEpoch - (ev.end + 5000)) / 8000;
    v += ev.rise * Math.exp(-d * d);
  }
  return Math.round(v);
}

const motionEvents = events.filter((e) => e.motion);
function actigraphyAt(wallEpoch) {
  if (wallEpoch >= BRIEF_A[0] && wallEpoch < BRIEF_A[1]) return Math.round(15 + rand() * 10);
  if (wallEpoch >= BRIEF_B[0] && wallEpoch < BRIEF_B[1]) return Math.round(15 + rand() * 10);
  if (wallEpoch >= LONG_WAKE[0] && wallEpoch < LONG_WAKE[1]) return Math.round(20 + rand() * 25);
  for (const ev of motionEvents) {
    if (wallEpoch < ev.end && wallEpoch + 30_000 > ev.start) return Math.round(25 + rand() * 10);
  }
  return Math.floor(rand() * 7);
}

// ---------- 批次装配 ----------
function letterId(seq) {
  // 1→a, 2→b, …, 26→z, 27→aa
  let s = "";
  let n = seq;
  while (n > 0) {
    s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 把 [startMono, endMono) 切成若干批次；span 可带 nulls/flags/interval。 */
function emitSpanBatches(batches, prefix, seqStart, span, valueFn, maxBatchSamples) {
  let seq = seqStart;
  let m = span.startMono;
  while (m < span.endMono) {
    const remaining = Math.floor((span.endMono - m) / span.interval);
    const count = Math.min(maxBatchSamples, remaining);
    if (count <= 0) break;
    const values = [];
    for (let k = 0; k < count; k += 1) {
      const wall = monoToWall(m + k * span.interval);
      values.push(span.nulls ? null : valueFn(wall));
    }
    batches.push({
      batchId: `${prefix}-${letterId(seq)}`,
      channel: span.channel,
      startedAtMonotonicMillis: m,
      intervalMillis: span.interval,
      values,
      qualityFlags: span.flags ?? [],
    });
    seq += 1;
    m += count * span.interval;
  }
  return seq;
}

function buildSpans(channel, interval) {
  const S = {
    offWrist: [mono(OFF_WRIST[0]), mono(OFF_WRIST[1])],
    gap: [mono(GAP[0]), mono(GAP[1])],
    lowPerf: [mono(LOW_PERF[0]), mono(LOW_PERF[1])],
    coarse: [mono(COARSE[0]), mono(COARSE[1])],
  };
  const end = 30601000;
  const normal = { channel, interval };
  const spans = [
    { ...normal, startMono: 5000, endMono: S.offWrist[0] },
    { ...normal, startMono: S.offWrist[0], endMono: S.offWrist[1], nulls: true, flags: ["off-wrist"] },
    { ...normal, startMono: S.offWrist[1], endMono: S.gap[0] },
    // gap：无批次
    { ...normal, startMono: S.gap[1], endMono: S.lowPerf[0] },
  ];
  if (channel !== "actigraphy") {
    spans.push({ ...normal, startMono: S.lowPerf[0], endMono: S.lowPerf[1], flags: ["low-perfusion"] });
  } else {
    spans.push({ ...normal, startMono: S.lowPerf[0], endMono: S.lowPerf[1] });
  }
  spans.push({ ...normal, startMono: S.lowPerf[1], endMono: S.coarse[0] });
  if (channel === "spo2") {
    // 血氧采样降级：10s 间隔
    spans.push({ channel, interval: 10000, startMono: S.coarse[0], endMono: S.coarse[1] });
  } else {
    spans.push({ ...normal, startMono: S.coarse[0], endMono: S.coarse[1] });
  }
  spans.push({ ...normal, startMono: S.coarse[1], endMono: end });
  return spans;
}

// 随机孤立 null（探头瞬时抖动），避开事件 ±30s，且不产生连续 null
function sprinkleNulls(values, monos, eventList) {
  let lastNull = -10;
  for (let k = 0; k < values.length; k += 1) {
    if (values[k] === null) continue;
    const wall = monoToWall(monos[k]);
    const nearEvent = eventList.some((ev) => wall > ev.start - 30_000 && wall < ev.end + 30_000);
    if (!nearEvent && k - lastNull > 1 && rand() < 0.002) {
      values[k] = null;
      lastNull = k;
    }
  }
}

function buildChannelBatches(channel, prefix, interval, valueFn, eventList, maxBatchSamples, seqStart = 1) {
  const batches = [];
  let seq = seqStart;
  for (const span of buildSpans(channel, interval)) {
    seq = emitSpanBatches(batches, prefix, seq, span, valueFn, maxBatchSamples);
  }
  if (channel === "spo2" || channel === "pulse-wave") {
    for (const b of batches) {
      if (b.qualityFlags.includes("off-wrist")) continue;
      const monos = b.values.map((_, k) => b.startedAtMonotonicMillis + k * b.intervalMillis);
      sprinkleNulls(b.values, monos, eventList);
    }
  }
  return batches;
}

// ---------- 主文件 ----------
// spo2-a 为保留的原始批次，生成批次从 b 开始
const spo2Batches = buildChannelBatches("spo2", "spo2", 1000, (w) => spo2At(w, events), events, 1800, 2);
const pulseBatches = buildChannelBatches("pulse-wave", "pw", 1000, (w) => pulseAt(w, events), events, 1800);
const actBatches = buildChannelBatches("actigraphy", "act", 30000, (w) => actigraphyAt(w), events, 60);

// 原始批次 spo2-a 保持逐字不变（低灌注标记的 4 个样本）
const originalSpo2A = {
  batchId: "spo2-a",
  channel: "spo2",
  startedAtMonotonicMillis: 1000,
  intervalMillis: 1000,
  values: [97, 96, null, 91],
  qualityFlags: ["low-perfusion"],
};

const mainStream = {
  subjectId: "sleep-29",
  timezone: "Asia/Shanghai",
  anchors: ANCHORS,
  batches: [originalSpo2A, ...spo2Batches, ...pulseBatches, ...actBatches],
};

// ---------- 补传文件：覆盖 03:30–03:44 断连窗口 ----------
const lateSpans = (channel, interval) => [
  { channel, interval, startMono: mono(GAP[0]), endMono: mono(GAP[1]) },
];
const lateBatches = [];
for (const [channel, prefix, interval, fn] of [
  ["spo2", "spo2-late", 1000, (w) => spo2At(w, lateEvents)],
  ["pulse-wave", "pw-late", 1000, (w) => pulseAt(w, lateEvents)],
  ["actigraphy", "act-late", 30000, (w) => actigraphyAt(w)],
]) {
  let seq = 1;
  for (const span of lateSpans(channel, interval)) {
    seq = emitSpanBatches(lateBatches, prefix, seq, span, fn, 10_000);
  }
}
const lateStream = {
  subjectId: "sleep-29",
  timezone: "Asia/Shanghai",
  anchors: ANCHORS,
  batches: lateBatches,
};

await writeFile(join(fixturesDir, "overnight-stream.json"), JSON.stringify(mainStream));
await writeFile(join(fixturesDir, "late-arrival.json"), JSON.stringify(lateStream));

const mainEvents = events.filter((e) => {
  const mid = (e.start + e.end) / 2;
  const inLowPerf = mid >= LOW_PERF[0] && mid < LOW_PERF[1];
  const inCoarse = mid >= COARSE[0] && mid < COARSE[1];
  return !inLowPerf && !inCoarse;
});
console.log(
  `已生成 fixtures：主文件 ${mainStream.batches.length} 批次，补传 ${lateStream.batches.length} 批次；` +
    `主文件剧本事件 ${mainEvents.length} 个（另有 2 个位于不可判读区间），补传事件 ${lateEvents.length} 个`,
);
