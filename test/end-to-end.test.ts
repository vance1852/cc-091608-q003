import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ALGORITHM_VERSION, analyzeStream } from "../src/analysis.js";
import { parseOvernightStream } from "../src/ingest.js";
import { composeReportBase, SCREENING_DISCLAIMER } from "../src/report.js";
import { ReportStore } from "../src/store.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/overnight-stream.json", import.meta.url),
);

function loadFixture() {
  return parseOvernightStream(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

const META = {
  subjectId: "sleep-29",
  timeZone: "Asia/Shanghai",
  generatedAt: "2026-09-16T09:30:00+08:00",
};

describe("样例夜次端到端（fixtures/overnight-stream.json）", () => {
  const stream = loadFixture();
  const { nights } = analyzeStream(stream);
  const night = nights[0]!;

  it("全部数据归入跨午夜夜次 2026-09-15", () => {
    assert.equal(nights.length, 1);
    assert.equal(night.nightId, "2026-09-15");
    assert.ok(night.window !== null);
    assert.ok(night.window.fromWall.startsWith("2026-09-15T22:45"));
    assert.ok(night.window.toWall.startsWith("2026-09-16T06:30"));
  });

  it("证据充分时给出带有效分母的初筛指数", () => {
    assert.equal(night.interpretable, true);
    assert.ok(night.index !== null);
    assert.equal(night.index.eventCount, 40);
    assert.ok(night.index.eventsPerValidHour >= 5);
    assert.ok(night.denominator !== null);
    assert.ok(night.denominator.coverageRatio > 0.75);
    assert.ok(night.denominator.coverageRatio < 0.9);
  });

  it("摘下设备、低灌注、降采样都列为具体不可判读区间", () => {
    const reasons = new Set(night.uninterpretableIntervals.map((i) => i.reason));
    assert.ok(reasons.has("data-gap"), "应有摘下设备的数据缺口");
    assert.ok(reasons.has("low-perfusion"), "应有低灌注区间");
    assert.ok(reasons.has("coarse-interval"), "应有降采样区间");
    for (const interval of night.uninterpretableIntervals) {
      assert.ok(interval.reasonText.length > 0);
      assert.ok(Date.parse(interval.fromWall) < Date.parse(interval.toWall));
    }
  });

  it("质量说明覆盖重戴、短暂清醒、时钟外推与漂移", () => {
    const notes = night.qualityNotes.join("\n");
    assert.match(notes, /重新佩戴/);
    assert.match(notes, /短暂清醒/);
    assert.match(notes, /外推/);
    assert.match(notes, /漂移/);
    assert.match(notes, /体动/);
  });

  it("给出转正式检查建议，且事件时间轴完整", () => {
    assert.equal(night.referral.recommended, true);
    assert.equal(night.events.length, 40);
    const artifacts = night.events.filter((event) => event.movementArtifact);
    assert.equal(artifacts.length, 2);
    for (const event of night.events) {
      assert.ok(Date.parse(event.startWall) < Date.parse(event.endWall));
      assert.ok(event.sourceBatchIds.length > 0);
      assert.ok(event.dropPct >= 3);
    }
  });

  it("指标可追溯到批次、分段与算法版本", () => {
    assert.ok(night.includedBatchIds.includes("spo2-a"));
    const indexProvenance = night.provenance.find((p) => p.metric === "eventsPerValidHour")!;
    assert.equal(indexProvenance.algorithmVersion, ALGORITHM_VERSION);
    assert.ok(indexProvenance.sourceBatchIds.length > 0);
    assert.ok(indexProvenance.sourceSegmentIds.length > 0);
  });

  it("报告全流程：草稿 → 签署 → 技师排除后重新生成，签署版保持原样", () => {
    const store = new ReportStore();
    const v1 = store.createDraft(composeReportBase(night, META));
    assert.equal(v1.state, "draft");
    assert.equal(v1.disclaimer, SCREENING_DISCLAIMER);

    const signed = store.sign(v1.reportId, "2026-09-16T10:00:00+08:00");
    const signedSnapshot = JSON.stringify(signed);

    // 技师排除第一件体动伪差事件所在的区间（前后各留 1 秒余量）
    const artifact = night.events.find((event) => event.movementArtifact)!;
    const exclusion = {
      from: new Date(Date.parse(artifact.startWall) - 1000).toISOString(),
      to: new Date(Date.parse(artifact.endWall) + 1000).toISOString(),
      reason: "体动伪差，技师排除",
    };
    const regenerated = analyzeStream(stream, { exclusions: [exclusion] }).nights[0]!;
    const v2 = store.createDraft(composeReportBase(regenerated, META));

    assert.equal(v2.version, 2);
    assert.equal(v2.state, "draft");
    assert.equal(v2.eventTimeline.length, 39);
    assert.equal(v2.excludedRanges.length, 1);
    assert.ok(
      v2.uninterpretableIntervals.some((i) => i.reason === "technician-exclusion"),
    );

    // 已签署版本保持原样
    const v1After = store.get(v1.reportId)!;
    assert.equal(JSON.stringify(v1After), signedSnapshot);
    assert.equal(v1After.state, "signed");
    assert.deepEqual(
      store.listForNight("2026-09-15").map((r) => r.state),
      ["signed", "draft"],
    );
  });
});

describe("证据边界（诚实性）", () => {
  it("只有 4 秒低灌注数据时：不给指数，只给不可判读说明", () => {
    const minimal = parseOvernightStream({
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
      batches: [
        {
          batchId: "spo2-a",
          channel: "spo2",
          startedAtMonotonicMillis: 1000,
          intervalMillis: 1000,
          values: [97, 96, null, 91],
          qualityFlags: ["low-perfusion"],
        },
      ],
    });
    const night = analyzeStream(minimal).nights[0]!;
    assert.equal(night.interpretable, false);
    assert.equal(night.index, null);
    assert.ok(night.interpretabilityReasons.length > 0);
    assert.ok(night.uninterpretableIntervals.length > 0);
    assert.ok(night.qualityNotes.some((note) => note.includes("脉搏波")));
  });

  it("非法数据流被拒绝并给出中文原因", () => {
    assert.throws(() => parseOvernightStream({}), /subjectId/);
    assert.throws(
      () =>
        parseOvernightStream({
          subjectId: "s",
          timezone: "Asia/Shanghai",
          anchors: [],
          batches: [],
        }),
      /锚点/,
    );
    assert.throws(
      () =>
        parseOvernightStream({
          subjectId: "s",
          timezone: "Not/AZone",
          anchors: [{ monotonicMillis: 0, wallTime: "2026-09-15T22:00:00+08:00", uncertaintyMillis: 0 }],
          batches: [],
        }),
      /时区/,
    );
  });
});
