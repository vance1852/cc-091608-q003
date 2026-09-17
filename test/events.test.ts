import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectCandidateEvents } from "../src/events.js";
import { makeSample, spo2SeriesWithEvents } from "./helpers.js";

describe("候选事件识别", () => {
  it("识别两次明显的血氧下降，记录谷值与时长", () => {
    const spo2 = spo2SeriesWithEvents(900, 96, [
      [200, 30, 89],
      [600, 20, 90],
    ]);
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 2);
    assert.equal(events[0]!.nadirSpo2, 89);
    assert.equal(events[0]!.dropPct, 7);
    assert.equal(events[0]!.durationMillis, 30_000);
    assert.equal(events[1]!.nadirSpo2, 90);
    assert.ok(events[0]!.sourceBatchIds.length > 0);
  });

  it("短于最短时长的下降不计为事件", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[100, 6, 88]]);
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 0);
  });

  it("下降不足 3 个百分点不计为事件", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[100, 60, 94]]);
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 0);
  });

  it("联合脉搏波：脉率上升则 pulseResponse 为真，无脉搏数据则为 null", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]]);
    const pulse = spo2.map((sample) =>
      makeSample(
        sample.mono,
        sample.mono >= 200_000 && sample.mono <= 280_000 ? 74 : 60,
        { batchId: "p1" },
      ),
    );
    const withPulse = detectCandidateEvents(spo2, pulse, [], [], "night-1");
    assert.equal(withPulse[0]!.pulseResponse, true);
    assert.equal(withPulse[0]!.confidence, "high");

    const noPulse = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(noPulse[0]!.pulseResponse, null);
    assert.equal(noPulse[0]!.confidence, "medium");
  });

  it("联合体动：事件期间明显体动标记为疑似伪差", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]]);
    const actigraphy = spo2.map((sample) =>
      makeSample(sample.mono, sample.mono >= 200_000 && sample.mono < 230_000 ? 90 : 2, {
        batchId: "a1",
        interval: 30_000,
      }),
    );
    const events = detectCandidateEvents(spo2, [], actigraphy, [], "night-1");
    assert.equal(events[0]!.movementArtifact, true);
    assert.equal(events[0]!.confidence, "low");
  });

  it("低灌注批次的样本不参与事件检测", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]]).map((sample) =>
      sample.mono >= 200_000 && sample.mono < 230_000
        ? { ...sample, batchFlags: ["low-perfusion"] }
        : sample,
    );
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 0);
  });

  it("降采样（间隔过长）的样本不参与事件检测", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]], 30_000);
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 0);
  });

  it("触及不可判读区间的事件标记为 partial", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]]);
    const events = detectCandidateEvents(
      spo2,
      [],
      [],
      [{ fromMono: 210_000, toMono: 220_000, reason: "low-perfusion" }],
      "night-1",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.partial, true);
  });

  it("技师排除的样本不参与事件检测", () => {
    const spo2 = spo2SeriesWithEvents(600, 96, [[200, 30, 88]]).map((sample) =>
      sample.mono >= 200_000 && sample.mono < 230_000
        ? { ...sample, excluded: true }
        : sample,
    );
    const events = detectCandidateEvents(spo2, [], [], [], "night-1");
    assert.equal(events.length, 0);
  });
});
