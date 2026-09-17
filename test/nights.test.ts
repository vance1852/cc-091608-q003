import { test } from "node:test";
import assert from "node:assert/strict";
import { nightIdFor, buildNightTimelines } from "../src/nights.ts";
import { OFFSET, series, flat } from "./helpers.ts";

test("夜次边界：正午为界，跨午夜同夜", () => {
  const at = (iso: string) => nightIdFor(Date.parse(iso), OFFSET);
  assert.equal(at("2026-09-15T12:00:00+08:00"), "night-2026-09-15");
  assert.equal(at("2026-09-15T23:59:59+08:00"), "night-2026-09-15");
  assert.equal(at("2026-09-16T00:00:00+08:00"), "night-2026-09-15");
  assert.equal(at("2026-09-16T11:59:59+08:00"), "night-2026-09-15");
  assert.equal(at("2026-09-16T12:00:00+08:00"), "night-2026-09-16");
});

test("中途摘下再重戴：同一夜次拆为两个佩戴段，摘下区间标记 off-wrist", () => {
  const before = series("spo2", "2026-09-15T23:00:00+08:00", 1000, flat(96, 600), "b1");
  const off = series("spo2", "2026-09-15T23:10:00+08:00", 1000, flat(0, 300).map(() => null), "b2", [
    "off-wrist",
  ]);
  const after = series("spo2", "2026-09-15T23:15:00+08:00", 1000, flat(96, 900), "b3");
  const [t] = buildNightTimelines([...before, ...off, ...after], "subj-1");
  assert.equal(t!.nightId, "night-2026-09-15");
  assert.equal(t!.segments.length, 2);
  assert.equal(t!.segments[0]!.nightId, t!.segments[1]!.nightId);
  assert.equal(t!.offWristIntervals.length, 1);
  assert.equal(t!.offWristIntervals[0]!.from, "2026-09-15T23:10:00+08:00");
  assert.equal(t!.offWristIntervals[0]!.to, "2026-09-15T23:15:00+08:00");
  assert.equal(t!.noDataGaps.length, 0);
});

test("完全无样本的空洞标记 no-data，等待补传", () => {
  const before = series("spo2", "2026-09-15T23:00:00+08:00", 1000, flat(96, 600), "b1");
  const after = series("spo2", "2026-09-15T23:20:00+08:00", 1000, flat(96, 600), "b2");
  const [t] = buildNightTimelines([...before, ...after], "subj-1");
  assert.equal(t!.segments.length, 2);
  assert.equal(t!.noDataGaps.length, 1);
  assert.equal(t!.noDataGaps[0]!.from, "2026-09-15T23:10:00+08:00");
  assert.equal(t!.noDataGaps[0]!.to, "2026-09-15T23:20:00+08:00");
});

test("段内短暂 null（<3 分钟）不拆段", () => {
  const values: Array<number | null> = flat(96, 600);
  for (let i = 300; i < 360; i += 1) values[i] = null;
  const samples = series("spo2", "2026-09-15T23:00:00+08:00", 1000, values, "b1");
  const [t] = buildNightTimelines(samples, "subj-1");
  assert.equal(t!.segments.length, 1);
  assert.equal(t!.noDataGaps.length, 0);
});

test("短暂清醒与较长清醒期都归入本夜次", () => {
  const values = flat(0, 60);
  for (let i = 20; i < 28; i += 1) values[i] = 15; // 23:10~23:14，4 分钟
  for (let i = 40; i < 60; i += 1) values[i] = 20; // 23:20~23:30，10 分钟
  const act = series("actigraphy", "2026-09-15T23:00:00+08:00", 30_000, values, "a1");
  const [t] = buildNightTimelines(act, "subj-1");
  assert.equal(t!.briefAwakenings.length, 1);
  assert.equal(t!.briefAwakenings[0]!.from, "2026-09-15T23:10:00+08:00");
  assert.equal(t!.wakePeriods.length, 1);
  assert.equal(t!.wakePeriods[0]!.from, "2026-09-15T23:20:00+08:00");
  assert.equal(t!.segments.length, 1);
});
