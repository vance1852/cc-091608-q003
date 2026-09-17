import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCandidateEvents } from "../src/events.ts";
import { series, flat } from "./helpers.ts";

const NIGHT = "night-2026-09-15";
const T0 = "2026-09-15T23:00:00+08:00";

/** 180s 基线 96 → 20s 降至 91 → 恢复，共 260s。 */
function dipSeries(): Array<number | null> {
  return [...flat(96, 180), ...flat(91, 20), ...flat(96, 60)];
}

function pulseWithRise(): Array<number | null> {
  // 事件结束于第 200s；脉搏在结束后 5s 升到 72。
  const v = flat(60, 260);
  for (let i = 200; i < 220; i += 1) v[i] = 72;
  return v;
}

test("联合血氧下降与脉搏上升 → 佐证的候选事件", () => {
  const spo2 = series("spo2", T0, 1000, dipSeries(), "spo2-1");
  const pulse = series("pulse-wave", T0, 1000, pulseWithRise(), "pw-1");
  const act = series("actigraphy", T0, 30_000, flat(0, 9), "act-1");
  const events = detectCandidateEvents(NIGHT, spo2, pulse, act);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.confidence, "corroborated");
  assert.ok(e.corroborations.includes("pulse-rise"));
  assert.equal(e.nadirSpo2, 91);
  assert.ok(e.durationSeconds >= 19 && e.durationSeconds <= 22);
  assert.deepEqual(e.sourceBatchIds, ["spo2-1"]);
});

test("事件中伴体动 → 降级为 candidate 并带 motion-present 警示", () => {
  const spo2 = series("spo2", T0, 1000, dipSeries(), "spo2-1");
  const pulse = series("pulse-wave", T0, 1000, pulseWithRise(), "pw-1");
  const actValues = flat(0, 9);
  actValues[6] = 25; // 180~210s，正好覆盖事件
  const act = series("actigraphy", T0, 30_000, actValues, "act-1");
  const [e] = detectCandidateEvents(NIGHT, spo2, pulse, act);
  assert.equal(e!.confidence, "candidate");
  assert.ok(e!.cautions.includes("motion-present"));
});

test("下降不足 10 秒不计为事件", () => {
  const values = [...flat(96, 180), ...flat(91, 8), ...flat(96, 60)];
  const spo2 = series("spo2", T0, 1000, values, "spo2-1");
  const events = detectCandidateEvents(NIGHT, spo2, [], []);
  assert.equal(events.length, 0);
});

test("下降不足 3 个百分点不计为事件", () => {
  const values = [...flat(96, 180), ...flat(94, 30), ...flat(96, 60)];
  const spo2 = series("spo2", T0, 1000, values, "spo2-1");
  const events = detectCandidateEvents(NIGHT, spo2, [], []);
  assert.equal(events.length, 0);
});

test("事件被长间隙打断（无法确认恢复）→ 丢弃", () => {
  // 下降开始后 40 秒才出现下一样本（有效序列中断 > 30s）。
  const part1 = series("spo2", T0, 1000, [...flat(96, 180), ...flat(91, 15)], "spo2-1");
  const part2 = series("spo2", "2026-09-15T23:04:15+08:00", 1000, flat(96, 60), "spo2-2");
  const events = detectCandidateEvents(NIGHT, [...part1, ...part2], [], []);
  assert.equal(events.length, 0);
});

test("夜末未恢复的事件不纳入", () => {
  const values = [...flat(96, 180), ...flat(91, 30)];
  const spo2 = series("spo2", T0, 1000, values, "spo2-1");
  const events = detectCandidateEvents(NIGHT, spo2, [], []);
  assert.equal(events.length, 0);
});
