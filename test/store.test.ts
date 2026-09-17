import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeStream } from "../src/analysis.js";
import { composeReportBase } from "../src/report.js";
import { ReportStore } from "../src/store.js";
import { makeAnchor, makeBatch, makeStream } from "./helpers.js";

const HOUR = 3_600_000;

function fixtureLikeStream() {
  return makeStream({
    anchors: [
      makeAnchor(0, "2026-09-15T22:00:00+08:00"),
      makeAnchor(9 * HOUR, "2026-09-16T07:00:00+08:00"),
    ],
    batches: [
      makeBatch({
        batchId: "s1",
        startedAtMonotonicMillis: 0,
        intervalMillis: 4000,
        values: Array.from({ length: 7200 }, (_, i) => {
          const sec = (i * 4) % 3600;
          return sec >= 600 && sec < 630 ? 88 : 96; // 每小时一次下降
        }),
      }),
    ],
  });
}

const META = {
  subjectId: "test-subject",
  timeZone: "Asia/Shanghai",
  generatedAt: "2026-09-16T09:00:00+08:00",
};

describe("报告版本存储", () => {
  it("草稿 → 签署 → 重新生成：签署版本保持原样，只新增草稿", () => {
    const stream = fixtureLikeStream();
    const store = new ReportStore();

    const night1 = analyzeStream(stream).nights[0]!;
    const v1 = store.createDraft(composeReportBase(night1, META));
    assert.equal(v1.reportId, "2026-09-15-v1");
    assert.equal(v1.version, 1);
    assert.equal(v1.state, "draft");
    assert.equal(v1.eventTimeline.length, 8);

    const signed = store.sign(v1.reportId, "2026-09-16T10:00:00+08:00");
    assert.equal(signed.state, "signed");
    assert.equal(signed.signedAt, "2026-09-16T10:00:00+08:00");
    const signedSnapshot = JSON.stringify(store.get(v1.reportId));

    // 技师排除一段后重新生成：产生 v2 草稿，v1 不动
    const exclusion = {
      from: "2026-09-15T22:09:50+08:00",
      to: "2026-09-15T22:10:40+08:00",
      reason: "体动伪差，技师排除",
    };
    const night2 = analyzeStream(stream, { exclusions: [exclusion] }).nights[0]!;
    const v2 = store.createDraft(composeReportBase(night2, META));
    assert.equal(v2.reportId, "2026-09-15-v2");
    assert.equal(v2.state, "draft");
    assert.equal(v2.eventTimeline.length, 7); // 被排除的事件不再出现
    assert.deepEqual(v2.excludedRanges, [exclusion]);

    const v1After = store.get(v1.reportId)!;
    assert.equal(JSON.stringify(v1After), signedSnapshot);
    assert.equal(v1After.state, "signed");
    assert.equal(store.listForNight("2026-09-15").length, 2);
  });

  it("重复签署与签署不存在的报告都会报错", () => {
    const store = new ReportStore();
    const night = analyzeStream(fixtureLikeStream()).nights[0]!;
    const draft = store.createDraft(composeReportBase(night, META));
    store.sign(draft.reportId, "2026-09-16T10:00:00+08:00");
    assert.throws(() => store.sign(draft.reportId, "2026-09-16T11:00:00+08:00"), /已签署/);
    assert.throws(() => store.sign("no-such-report", "2026-09-16T11:00:00+08:00"), /不存在/);
  });

  it("报告对象被冻结，签署后无法篡改", () => {
    const store = new ReportStore();
    const night = analyzeStream(fixtureLikeStream()).nights[0]!;
    const draft = store.createDraft(composeReportBase(night, META));
    const signed = store.sign(draft.reportId, "2026-09-16T10:00:00+08:00");
    assert.throws(() => {
      (signed as { state: string }).state = "draft";
    }, TypeError);
  });

  it("每个指标都能追溯到批次与算法版本", () => {
    const store = new ReportStore();
    const night = analyzeStream(fixtureLikeStream()).nights[0]!;
    const report = store.createDraft(composeReportBase(night, META));
    for (const entry of report.provenance) {
      assert.equal(entry.algorithmVersion, report.algorithmVersion);
    }
    const indexProvenance = report.provenance.find((p) => p.metric === "eventsPerValidHour")!;
    assert.deepEqual(indexProvenance.sourceBatchIds, ["s1"]);
    assert.ok(indexProvenance.sourceSegmentIds.length > 0);
    assert.ok(report.eventTimeline.every((event) => event.sourceBatchIds.includes("s1")));
  });
});
