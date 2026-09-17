import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeStream } from "../src/analysis.js";
import { listNightIds } from "../src/nights.js";
import { DeviceClock } from "../src/clock.js";
import { makeAnchor, makeBatch, makeStream, TEST_TZ } from "./helpers.js";

const HOUR = 3_600_000;

/** 22:00 开始的锚点，单调时钟与挂钟一致（无漂移）。 */
const ANCHORS = [
  makeAnchor(0, "2026-09-15T22:00:00+08:00"),
  makeAnchor(9 * HOUR, "2026-09-16T07:00:00+08:00"),
];

describe("夜次归组", () => {
  it("跨午夜的数据属于同一夜次", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "s1",
          startedAtMonotonicMillis: 1.5 * HOUR, // 23:30
          intervalMillis: 4000,
          values: Array(900).fill(96), // 1 小时，跨过 00:00
        }),
      ],
    });
    const clock = new DeviceClock(stream.anchors, TEST_TZ);
    assert.deepEqual(listNightIds(stream, clock), ["2026-09-15"]);
  });

  it("半夜摘下再重戴不拆夜次，只形成夜内佩戴段", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "s1",
          startedAtMonotonicMillis: HOUR, // 23:00
          intervalMillis: 4000,
          values: Array(450).fill(96), // 30 分钟
        }),
        makeBatch({
          batchId: "s2",
          startedAtMonotonicMillis: HOUR + 40 * 60_000, // 40 分钟后重戴
          intervalMillis: 4000,
          values: Array(450).fill(96),
        }),
      ],
    });
    const { nights } = analyzeStream(stream);
    assert.equal(nights.length, 1);
    const night = nights[0]!;
    assert.equal(night.nightId, "2026-09-15");
    assert.equal(night.segments.filter((s) => s.channel === "spo2").length, 2);
    assert.ok(night.qualityNotes.some((note) => note.includes("重新佩戴")));
    assert.ok(
      night.uninterpretableIntervals.some((interval) => interval.reason === "data-gap"),
    );
  });

  it("短暂清醒记入质量说明且保留在同一夜次", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "s1",
          startedAtMonotonicMillis: HOUR,
          intervalMillis: 4000,
          values: Array(1800).fill(96), // 2 小时血氧
        }),
        makeBatch({
          batchId: "a1",
          channel: "actigraphy",
          startedAtMonotonicMillis: HOUR,
          intervalMillis: 30_000,
          values: Array.from({ length: 240 }, (_, index) =>
            index >= 60 && index < 80 ? 80 : 2, // 30–40 分钟处清醒 10 分钟
          ),
        }),
      ],
    });
    const { nights } = analyzeStream(stream);
    const night = nights[0]!;
    assert.equal(night.nightId, "2026-09-15");
    assert.ok(night.qualityNotes.some((note) => note.includes("短暂清醒")));
    assert.equal(night.wakeBouts.length, 1);
    assert.equal(night.wakeBouts[0]!.brief, true);
  });

  it("正午之后的数据归入下一夜次", () => {
    const stream = makeStream({
      anchors: [
        makeAnchor(0, "2026-09-15T22:00:00+08:00"),
        makeAnchor(40 * HOUR, "2026-09-17T14:00:00+08:00"),
      ],
      batches: [
        makeBatch({ batchId: "s1", startedAtMonotonicMillis: 0, values: [96, 96] }),
        makeBatch({
          batchId: "s2",
          startedAtMonotonicMillis: 15 * HOUR, // 次日 13:00
          values: [96, 96],
        }),
      ],
    });
    const clock = new DeviceClock(stream.anchors, TEST_TZ);
    assert.deepEqual(listNightIds(stream, clock), ["2026-09-15", "2026-09-16"]);
  });
});
