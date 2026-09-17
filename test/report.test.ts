import { test } from "node:test";
import assert from "node:assert/strict";
import { ReportStore } from "../src/report.ts";
import { ALGORITHM_VERSION } from "../src/metrics.ts";
import { batch, streamFor, flat } from "./helpers.ts";

const NIGHT = "night-2026-09-15";

/** 4 小时夜：22:00–02:00，23:00 与 00:30 各一次 20s 低氧下降。 */
function mainStream() {
  const spo2Values: Array<number | null> = flat(96, 4 * 3600);
  for (let i = 3600; i < 3620; i += 1) spo2Values[i] = 91; // 23:00:00
  for (let i = 9000; i < 9020; i += 1) spo2Values[i] = 90; // 00:30:00
  const spo2 = batch("spo2", "spo2-1", "2026-09-15T22:00:00+08:00", 1000, spo2Values);
  const pulse = batch("pulse-wave", "pw-1", "2026-09-15T22:00:00+08:00", 1000, flat(60, 4 * 3600));
  const act = batch("actigraphy", "act-1", "2026-09-15T22:00:00+08:00", 30_000, flat(2, 480));
  return streamFor([spo2, pulse, act]);
}

/** 补传：02:00–02:30，含 02:10 一次下降。 */
function lateStream() {
  const spo2Values: Array<number | null> = flat(96, 1800);
  for (let i = 600; i < 620; i += 1) spo2Values[i] = 91;
  const spo2 = batch("spo2", "spo2-late-1", "2026-09-16T02:00:00+08:00", 1000, spo2Values);
  return streamFor([spo2]);
}

function makeStore() {
  let tick = 0;
  const store = new ReportStore({
    now: () => new Date(Date.parse("2026-09-16T09:00:00+08:00") + tick++ * 1000),
  });
  store.addStream(mainStream());
  return store;
}

test("首版报告为草稿，指标带算法版本与批次溯源", () => {
  const store = makeStore();
  const v1 = store.generateReport(NIGHT);
  assert.equal(v1.version, 1);
  assert.equal(v1.state, "draft");
  assert.equal(v1.payload.events.length, 2);
  const odi3 = v1.payload.metrics.odi3;
  assert.equal(odi3.status, "ok");
  if (odi3.status === "ok") {
    assert.ok(odi3.value > 0);
    assert.equal(odi3.provenance.algorithmVersion, ALGORITHM_VERSION);
    assert.ok(odi3.provenance.batchIds.includes("spo2-1"));
    assert.ok(odi3.provenance.validDenominatorMinutes >= 239);
  }
  assert.ok(v1.includedBatchIds.includes("spo2-1"));
  assert.equal(v1.algorithmVersion, ALGORITHM_VERSION);
});

test("技师排除片段后重新生成：新版本取代旧草稿", () => {
  const store = makeStore();
  const v1 = store.generateReport(NIGHT);
  const v2 = store.generateReport(NIGHT, {
    excludedRanges: [
      { from: "2026-09-15T22:55:00+08:00", to: "2026-09-15T23:05:00+08:00", reason: "体动伪差" },
    ],
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedesReportId, v1.reportId);
  assert.equal(v2.payload.events.length, 1);
  assert.equal(v2.excludedRanges.length, 1);
  assert.equal(v2.payload.metrics.odi3.provenance.excludedRanges.length, 1);
});

test("签署后冻结：重复签署、签署旧版本均报错", () => {
  const store = makeStore();
  const v1 = store.generateReport(NIGHT);
  const v2 = store.generateReport(NIGHT);
  const signed = store.sign(v2.reportId);
  assert.equal(signed.state, "signed");
  assert.ok(signed.signedAt);
  assert.ok(Object.isFrozen(signed));
  assert.ok(Object.isFrozen(signed.payload));
  assert.throws(() => store.sign(v2.reportId), /不可变更/);
  assert.throws(() => store.sign(v1.reportId), /已被更新版本取代/);
});

test("补传只形成新草稿，签署版保持原样", () => {
  const store = makeStore();
  store.generateReport(NIGHT);
  const v2 = store.generateReport(NIGHT, {
    excludedRanges: [
      { from: "2026-09-15T22:55:00+08:00", to: "2026-09-15T23:05:00+08:00", reason: "体动伪差" },
    ],
  });
  const signed = store.sign(v2.reportId);
  const signedEventCount = signed.payload.events.length;

  store.addStream(lateStream());
  const v3 = store.generateReport(NIGHT);
  assert.equal(v3.version, 3);
  assert.equal(v3.state, "draft");
  // 沿用签署版的排除段
  assert.equal(v3.excludedRanges.length, 1);
  // 补传事件进入新草稿
  assert.equal(v3.payload.events.length, signedEventCount + 1);
  assert.ok(v3.payload.events.some((e) => e.startedAt.startsWith("2026-09-16T02:1")));
  // 签署版原样
  const signedAgain = store.getReport(signed.reportId)!;
  assert.equal(signedAgain.payload.events.length, signedEventCount);
  assert.equal(signedAgain.state, "signed");
  assert.ok(Object.isFrozen(signedAgain));
  // 历史完整
  assert.equal(store.history(NIGHT).length, 3);
});

test("不存在的夜次报错", () => {
  const store = makeStore();
  assert.throws(() => store.generateReport("night-2099-01-01"), /未找到夜次/);
});
