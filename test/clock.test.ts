import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceClock, formatIsoWithOffset, parseOffsetMinutes } from "../src/clock.ts";

const ANCHORS = [
  { monotonicMillis: 1000, wallTime: "2026-09-15T22:45:00+08:00", uncertaintyMillis: 120 },
  { monotonicMillis: 21601000, wallTime: "2026-09-16T04:45:04+08:00", uncertaintyMillis: 180 },
];

test("锚点处校正结果与锚点墙面时间一致", () => {
  const clock = new DeviceClock(ANCHORS);
  const atFirst = clock.toWall(1000);
  assert.equal(atFirst.wallIso, "2026-09-15T22:45:00+08:00");
  assert.equal(atFirst.extrapolated, false);
  const atSecond = clock.toWall(21601000);
  assert.equal(atSecond.wallIso, "2026-09-16T04:45:04+08:00");
});

test("锚点间线性插值吸收恒定漂移", () => {
  const clock = new DeviceClock(ANCHORS);
  // 中点：单调 6 小时的一半 = 3 小时；墙面漂移 4 秒的一半 = 2 秒。
  const mid = clock.toWall(1000 + 10_800_000);
  assert.equal(mid.wallIso, "2026-09-16T01:45:02+08:00");
  assert.equal(mid.extrapolated, false);
  // 不确定度在锚点间插值。
  assert.ok(mid.uncertaintyMillis > 120 && mid.uncertaintyMillis < 180);
});

test("漂移率观测值符合锚点差", () => {
  const clock = new DeviceClock(ANCHORS);
  const [ppm] = clock.observedDriftPpm();
  // 6 小时漂移 4 秒 → 4000/21600000 ≈ 185.2 ppm
  assert.ok(Math.abs(ppm! - 185.2) < 0.1);
});

test("锚点范围外为外推，且不确定度随距离放大", () => {
  const clock = new DeviceClock(ANCHORS);
  const near = clock.toWall(21601000 + 60_000);
  const far = clock.toWall(21601000 + 3_600_000);
  assert.equal(near.extrapolated, true);
  assert.equal(far.extrapolated, true);
  assert.ok(far.uncertaintyMillis > near.uncertaintyMillis);
  assert.ok(near.uncertaintyMillis > 180);
});

test("非递增锚点被拒绝", () => {
  assert.throws(
    () =>
      new DeviceClock([
        { monotonicMillis: 2000, wallTime: "2026-09-15T22:45:00+08:00", uncertaintyMillis: 100 },
        { monotonicMillis: 2000, wallTime: "2026-09-15T23:45:00+08:00", uncertaintyMillis: 100 },
      ]),
    /严格递增/,
  );
  assert.throws(
    () =>
      new DeviceClock([
        { monotonicMillis: 1000, wallTime: "2026-09-15T23:45:00+08:00", uncertaintyMillis: 100 },
        { monotonicMillis: 2000, wallTime: "2026-09-15T22:45:00+08:00", uncertaintyMillis: 100 },
      ]),
    /回拨/,
  );
  assert.throws(() => new DeviceClock([]), /至少需要一个/);
});

test("时区偏移解析与格式化", () => {
  assert.equal(parseOffsetMinutes("2026-09-15T22:45:00+08:00"), 480);
  assert.equal(parseOffsetMinutes("2026-09-15T22:45:00-05:30"), -330);
  assert.equal(formatIsoWithOffset(Date.parse("2026-09-16T04:45:04.4Z"), 0), "2026-09-16T04:45:04+00:00");
  assert.throws(() => parseOffsetMinutes("2026-09-15T22:45:00"), /时区偏移/);
});
