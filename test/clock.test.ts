import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeviceClock } from "../src/clock.js";
import { formatWallTime, nightIdFor, nightWindowFor } from "../src/timezone.js";
import { makeAnchor, TEST_TZ } from "./helpers.js";

// 与 fixtures/overnight-stream.json 相同的两个锚点：6 小时漂移约 4 秒
const FIXTURE_ANCHORS = [
  makeAnchor(1000, "2026-09-15T22:45:00+08:00", 120),
  makeAnchor(21601000, "2026-09-16T04:45:04+08:00", 180),
];

describe("DeviceClock 时钟校正", () => {
  const clock = new DeviceClock(FIXTURE_ANCHORS, TEST_TZ);

  it("锚点处原样映射，不确定度取锚点值", () => {
    const first = clock.correct(1000);
    assert.equal(first.wallTime, "2026-09-15T22:45:00+08:00");
    assert.equal(first.uncertaintyMillis, 120);
    assert.equal(first.extrapolated, false);

    const last = clock.correct(21601000);
    assert.equal(last.wallTime, "2026-09-16T04:45:04+08:00");
    assert.equal(last.uncertaintyMillis, 180);
  });

  it("锚点之间按漂移率插值（手机时钟漂移被吸收）", () => {
    // 单调时钟走 10800000ms，挂钟应走 10802000ms（漂移 +2 秒）
    const mid = clock.correct(10801000);
    assert.equal(mid.wallTime, "2026-09-16T01:45:02+08:00");
    assert.equal(mid.extrapolated, false);
    assert.ok(mid.uncertaintyMillis >= 120 && mid.uncertaintyMillis <= 180);
  });

  it("漂移率约为 +185ppm", () => {
    assert.ok(clock.driftPpm !== null);
    assert.ok(Math.abs(clock.driftPpm - 185.185) < 0.01);
  });

  it("锚点区间之外标记外推且不确定度增长", () => {
    const beyond = clock.correct(21601000 + 3_600_000);
    assert.equal(beyond.extrapolated, true);
    assert.ok(beyond.uncertaintyMillis > 180);
    const before = clock.correct(1000 - 3_600_000);
    assert.equal(before.extrapolated, true);
    assert.ok(before.uncertaintyMillis > 120);
  });

  it("invert 是 correct 的逆映射", () => {
    for (const mono of [1000, 5_000_000, 21601000, 30_000_000]) {
      const roundTrip = clock.invert(clock.correct(mono).epochMillis);
      assert.ok(Math.abs(roundTrip - mono) < 1, `mono=${mono} 往返误差 ${roundTrip - mono}`);
    }
  });

  it("单锚点退化为固定偏移，区间外标记外推", () => {
    const single = new DeviceClock([makeAnchor(0, "2026-09-15T22:00:00+08:00", 50)], TEST_TZ);
    assert.equal(single.driftPpm, null);
    assert.equal(single.correct(60_000).wallTime, "2026-09-15T22:01:00+08:00");
    assert.equal(single.correct(60_000).extrapolated, true);
  });

  it("拒绝空锚点与非法 wallTime", () => {
    assert.throws(() => new DeviceClock([], TEST_TZ), /锚点/);
    assert.throws(
      () => new DeviceClock([makeAnchor(0, "not-a-time")], TEST_TZ),
      /wallTime/,
    );
  });
});

describe("时区与夜次工具", () => {
  it("formatWallTime 输出带偏移的 ISO 字符串", () => {
    const epoch = Date.parse("2026-09-16T04:45:04+08:00");
    assert.equal(formatWallTime(epoch, TEST_TZ), "2026-09-16T04:45:04+08:00");
  });

  it("夜次按正午到正午划分，跨午夜归入前一晚", () => {
    assert.equal(nightIdFor(Date.parse("2026-09-15T13:00:00+08:00"), TEST_TZ), "2026-09-15");
    assert.equal(nightIdFor(Date.parse("2026-09-15T23:59:59+08:00"), TEST_TZ), "2026-09-15");
    assert.equal(nightIdFor(Date.parse("2026-09-16T03:00:00+08:00"), TEST_TZ), "2026-09-15");
    assert.equal(nightIdFor(Date.parse("2026-09-16T11:59:59+08:00"), TEST_TZ), "2026-09-15");
    assert.equal(nightIdFor(Date.parse("2026-09-16T12:00:00+08:00"), TEST_TZ), "2026-09-16");
  });

  it("nightWindowFor 返回正午到次日正午", () => {
    const window = nightWindowFor("2026-09-15", TEST_TZ);
    assert.equal(window.fromEpoch, Date.parse("2026-09-15T12:00:00+08:00"));
    assert.equal(window.toEpoch, Date.parse("2026-09-16T12:00:00+08:00"));
  });
});
