import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeStream } from "../src/analysis.js";
import {
  computeDenominator,
  DEFAULT_QUALITY_POLICY,
  judgeInterpretability,
} from "../src/quality.js";
import { makeAnchor, makeBatch, makeSample, makeStream } from "./helpers.js";

const HOUR = 3_600_000;
const ANCHORS = [
  makeAnchor(0, "2026-09-15T22:00:00+08:00"),
  makeAnchor(10 * HOUR, "2026-09-16T08:00:00+08:00"),
];

describe("有效分母", () => {
  it("null、低灌注、降采样样本都不计入有效时长", () => {
    const samples = [
      ...Array.from({ length: 90 }, (_, i) => makeSample(i * 1000, 96)),
      ...Array.from({ length: 10 }, (_, i) => makeSample(90_000 + i * 1000, null)),
      ...Array.from({ length: 100 }, (_, i) =>
        makeSample(100_000 + i * 1000, 95, { batchFlags: ["low-perfusion"] }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeSample(200_000 + i * 30_000, 96, { interval: 30_000 }),
      ),
    ];
    const denominator = computeDenominator(samples, 12_000)!;
    assert.equal(denominator.validMillis, 90_000);
    assert.equal(denominator.windowMillis, 500_000);
    assert.ok(Math.abs(denominator.coverageRatio - 0.18) < 1e-9);
  });

  it("无样本时分母为 null", () => {
    assert.equal(computeDenominator([], 12_000), null);
  });
});

describe("可判读性判定", () => {
  const policy = DEFAULT_QUALITY_POLICY;

  it("覆盖率不足、有效时长不足、窗口过短分别给出具体原因", () => {
    const lowCoverage = judgeInterpretability(
      { windowMillis: 8 * HOUR, validMillis: 5 * HOUR, coverageRatio: 0.625 },
      policy,
    );
    assert.equal(lowCoverage.interpretable, false);
    assert.ok(lowCoverage.reasons.some((reason) => reason.includes("覆盖率")));

    const shortValid = judgeInterpretability(
      { windowMillis: 8 * HOUR, validMillis: 2 * HOUR, coverageRatio: 0.25 },
      policy,
    );
    assert.equal(shortValid.interpretable, false);
    assert.ok(shortValid.reasons.some((reason) => reason.includes("有效血氧时长")));

    const shortWindow = judgeInterpretability(
      { windowMillis: 30 * 60_000, validMillis: 30 * 60_000, coverageRatio: 1 },
      policy,
    );
    assert.equal(shortWindow.interpretable, false);
    assert.ok(shortWindow.reasons.some((reason) => reason.includes("监测窗口")));
  });

  it("覆盖充分时可判读", () => {
    const verdict = judgeInterpretability(
      { windowMillis: 8 * HOUR, validMillis: 6 * HOUR, coverageRatio: 0.75 },
      policy,
    );
    assert.equal(verdict.interpretable, true);
    assert.equal(verdict.reasons.length, 0);
  });
});

describe("质量门控（夜次级）", () => {
  it("低灌注覆盖大半夜次：不计算指数，给出不可判读区间", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "good",
          startedAtMonotonicMillis: 0,
          intervalMillis: 4000,
          values: Array(1800).fill(96), // 2 小时有效
        }),
        makeBatch({
          batchId: "bad",
          startedAtMonotonicMillis: 2 * HOUR,
          intervalMillis: 4000,
          values: Array(4500).fill(93), // 5 小时低灌注
          qualityFlags: ["low-perfusion"],
        }),
      ],
    });
    const night = analyzeStream(stream).nights[0]!;
    assert.equal(night.interpretable, false);
    assert.equal(night.index, null);
    assert.ok(
      night.uninterpretableIntervals.some((interval) => interval.reason === "low-perfusion"),
    );
    assert.ok(night.interpretabilityReasons.length > 0);
  });

  it("降采样区间被列为不可判读，且不计入有效分母", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "fine",
          startedAtMonotonicMillis: 0,
          intervalMillis: 4000,
          values: Array(6300).fill(96), // 7 小时正常
        }),
        makeBatch({
          batchId: "coarse",
          startedAtMonotonicMillis: 7 * HOUR,
          intervalMillis: 30_000,
          values: Array(120).fill(96), // 1 小时降采样
        }),
      ],
    });
    const night = analyzeStream(stream).nights[0]!;
    assert.equal(night.interpretable, true);
    assert.ok(
      night.uninterpretableIntervals.some((interval) => interval.reason === "coarse-interval"),
    );
    // 有效时长约为 7 小时（降采样 1 小时不计入）
    assert.ok(night.denominator !== null);
    assert.ok(Math.abs(night.denominator.validMillis - 7 * HOUR) < 60_000);
  });

  it("连续信号丢失超过阈值记为不可判读区间", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "s1",
          startedAtMonotonicMillis: 0,
          intervalMillis: 4000,
          values: [
            ...Array(3600).fill(96), // 4 小时正常
            ...Array<number | null>(30).fill(null), // 2 分钟信号丢失
            ...Array(3600).fill(96),
          ],
        }),
      ],
    });
    const night = analyzeStream(stream).nights[0]!;
    assert.ok(
      night.uninterpretableIntervals.some((interval) => interval.reason === "signal-lost"),
    );
  });

  it("技师排除的区间不计入指数并列入不可判读", () => {
    const stream = makeStream({
      anchors: ANCHORS,
      batches: [
        makeBatch({
          batchId: "s1",
          startedAtMonotonicMillis: 0,
          intervalMillis: 4000,
          values: Array(7200).fill(96), // 8 小时
        }),
      ],
    });
    const excluded = analyzeStream(stream, {
      exclusions: [
        {
          from: "2026-09-16T01:00:00+08:00",
          to: "2026-09-16T02:00:00+08:00",
          reason: "家属碰掉了探头",
        },
      ],
    }).nights[0]!;
    assert.ok(
      excluded.uninterpretableIntervals.some(
        (interval) => interval.reason === "technician-exclusion",
      ),
    );
    assert.ok(excluded.denominator !== null);
    assert.ok(Math.abs(excluded.denominator.validMillis - 7 * HOUR) < 60_000);
    assert.equal(excluded.excludedRanges.length, 1);
  });
});
