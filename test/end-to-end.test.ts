import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadStreamFile } from "../src/ingest.ts";
import { ReportStore } from "../src/report.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const NIGHT = "night-2026-09-15";

async function storeWithMain() {
  const store = new ReportStore({
    now: () => new Date("2026-09-16T09:00:00+08:00"),
  });
  store.addStream(await loadStreamFile(join(fixtures, "overnight-stream.json")));
  return store;
}

test("夹具夜次：不可判读区间覆盖低灌注/摘下/断连/过疏采样", async () => {
  const store = await storeWithMain();
  const report = store.generateReport(NIGHT);
  const reasons = report.payload.uninterpretable.map((i) => i.reason);
  assert.ok(reasons.some((r) => r.includes("low-perfusion")), "应有低灌注区间");
  assert.ok(reasons.some((r) => r === "off-wrist"), "应有摘下区间");
  assert.ok(reasons.some((r) => r === "no-data"), "应有断连缺口");
  assert.ok(reasons.some((r) => r.includes("sampling-too-coarse")), "应有过疏采样区间");
});

test("夹具夜次：事件不落在不可判读区间内，指标可判读且带分母", async () => {
  const store = await storeWithMain();
  const report = store.generateReport(NIGHT);
  const { events, uninterpretable } = report.payload;
  assert.ok(events.length >= 30, `候选事件应不少于 30，实际 ${events.length}`);
  for (const e of events) {
    const start = Date.parse(e.startedAt);
    const inBad = uninterpretable.some(
      (iv) => start >= iv.fromEpoch && start < iv.toEpoch,
    );
    assert.ok(!inBad, `事件 ${e.eventId} 不应起于不可判读区间`);
    // 低灌注窗口 05:00~05:20 与过疏窗口 06:00~06:30 内不得有事件
  }
  const odi3 = report.payload.metrics.odi3;
  assert.equal(odi3.status, "ok");
  if (odi3.status === "ok") {
    assert.ok(odi3.value >= 3 && odi3.value <= 8, `ODI3=${odi3.value}`);
    assert.ok(odi3.provenance.validDenominatorMinutes > 400);
    assert.ok(odi3.provenance.batchIds.length > 0);
  }
  // 有效分母明显小于佩戴时长（存在不可判读区间）
  const m = report.payload.metrics;
  assert.ok(m.validMinutes < m.wearMinutes);
  assert.ok(m.coverageRatio > 0.8 && m.coverageRatio < 1);
});

test("夹具全流程：排除→签署→补传，签署版保持原样", async () => {
  const store = await storeWithMain();
  store.generateReport(NIGHT);
  const v2 = store.generateReport(NIGHT, {
    excludedRanges: [
      {
        from: "2026-09-16T01:45:00+08:00",
        to: "2026-09-16T01:52:00+08:00",
        reason: "体动干扰，技师确认伪差",
      },
    ],
  });
  const signed = store.sign(v2.reportId);
  const signedEvents = signed.payload.events.length;
  const signedUninterpretable = signed.payload.uninterpretable.length;

  store.addStream(await loadStreamFile(join(fixtures, "late-arrival.json")));
  const v3 = store.generateReport(NIGHT);
  assert.equal(v3.state, "draft");
  assert.equal(v3.version, 3);
  // 补传填补了断连缺口：v3 少一段 no-data，多一个 03:37 事件
  assert.ok(v3.payload.events.length > signedEvents);
  assert.ok(
    v3.payload.events.some((e) => e.startedAt.startsWith("2026-09-16T03:37")),
    "补传后应出现 03:37 的候选事件",
  );
  assert.ok(v3.payload.uninterpretable.length < signedUninterpretable + 1);
  // 签署版原样、冻结
  const signedNow = store.getReport(signed.reportId)!;
  assert.equal(signedNow.payload.events.length, signedEvents);
  assert.ok(signedNow.payload.uninterpretable.some((i) => i.reason === "no-data"));
  assert.ok(Object.isFrozen(signedNow));
});
