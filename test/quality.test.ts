import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNightTimelines } from "../src/nights.ts";
import { assessQuality } from "../src/quality.ts";
import { series, flat } from "./helpers.ts";

function timelineWithCoarseAndLowPerf() {
  const b1 = series("spo2", "2026-09-15T22:00:00+08:00", 1000, flat(96, 600), "b1");
  const lowPerf = series("spo2", "2026-09-15T22:10:00+08:00", 1000, flat(94, 600), "b-low", [
    "low-perfusion",
  ]);
  const b2 = series("spo2", "2026-09-15T22:20:00+08:00", 1000, flat(96, 600), "b2");
  const coarse = series("spo2", "2026-09-15T22:30:00+08:00", 10_000, flat(95, 60), "b-coarse");
  const b3 = series("spo2", "2026-09-15T22:40:00+08:00", 1000, flat(96, 1200), "b3");
  const [timeline] = buildNightTimelines(
    [...b1, ...lowPerf, ...b2, ...coarse, ...b3],
    "subj-1",
  );
  return timeline!;
}

test("低灌注批次与过疏采样批次都列为不可判读，且不计入有效分母", () => {
  const q = assessQuality(timelineWithCoarseAndLowPerf(), []);
  const reasons = q.uninterpretable.map((i) => i.reason);
  assert.ok(reasons.some((r) => r.includes("low-perfusion")));
  assert.ok(reasons.some((r) => r.includes("sampling-too-coarse")));
  // 佩戴 60 分钟，低灌注 10 分钟 + 过疏 10 分钟 → 有效 40 分钟。
  assert.equal(Math.round(q.wearMinutes), 60);
  assert.equal(Math.round(q.validMinutes), 40);
  // 有效样本不含低灌注/过疏批次。
  assert.ok(q.validSpo2Samples.every((s) => s.batchId !== "b-low" && s.batchId !== "b-coarse"));
});

test("有效时长不足时不给出每小时指数", () => {
  const q = assessQuality(timelineWithCoarseAndLowPerf(), []);
  assert.equal(q.sufficientForIndex, false);
  assert.ok(q.insufficiencyReasons.some((r) => r.includes("有效血氧时长")));
});

test("技师排除段进入不可判读区间并扣减分母", () => {
  const q = assessQuality(timelineWithCoarseAndLowPerf(), [
    { from: "2026-09-15T22:40:00+08:00", to: "2026-09-15T22:50:00+08:00", reason: "测试排除" },
  ]);
  assert.ok(q.uninterpretable.some((i) => i.reason.includes("technician-excluded")));
  assert.equal(Math.round(q.validMinutes), 30);
});

test("血氧长 null 段标记 signal-gap", () => {
  const values: Array<number | null> = flat(96, 3600);
  for (let i = 1800; i < 1920; i += 1) values[i] = null; // 2 分钟 null
  const samples = series("spo2", "2026-09-15T22:00:00+08:00", 1000, values, "b1");
  const [timeline] = buildNightTimelines(samples, "subj-1");
  const q = assessQuality(timeline!, []);
  assert.ok(q.uninterpretable.some((i) => i.reason === "signal-gap"));
});

test("覆盖充足时 sufficientForIndex 为真", () => {
  const samples = series("spo2", "2026-09-15T22:00:00+08:00", 1000, flat(96, 4 * 3600), "b1");
  const [timeline] = buildNightTimelines(samples, "subj-1");
  const q = assessQuality(timeline!, []);
  assert.equal(q.sufficientForIndex, true);
  assert.equal(Math.round(q.validMinutes), 240);
});
