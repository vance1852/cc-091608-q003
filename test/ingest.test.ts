import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStream, mergeStreams } from "../src/ingest.ts";
import { batch, streamFor } from "./helpers.ts";

test("合法流通过校验，批次省略 subjectId 时继承文件级", () => {
  const stream = validateStream({
    subjectId: "subj-1",
    timezone: "Asia/Shanghai",
    anchors: [{ monotonicMillis: 1000, wallTime: "2026-09-15T22:00:00+08:00", uncertaintyMillis: 100 }],
    batches: [
      {
        batchId: "spo2-a",
        channel: "spo2",
        startedAtMonotonicMillis: 1000,
        intervalMillis: 1000,
        values: [97, null, 91],
        qualityFlags: [],
      },
    ],
  });
  assert.equal(stream.batches[0]!.subjectId, "subj-1");
  assert.deepEqual(stream.batches[0]!.values, [97, null, 91]);
});

test("畸形输入被拒绝并带字段路径", () => {
  assert.throws(() => validateStream(null), /流文件应为 JSON 对象/);
  assert.throws(
    () =>
      validateStream({
        subjectId: "s",
        timezone: "Asia/Shanghai",
        anchors: [{ monotonicMillis: 1, wallTime: "2026-09-15T22:00:00+08:00", uncertaintyMillis: 1 }],
        batches: [
          {
            batchId: "b1",
            channel: "ecg",
            startedAtMonotonicMillis: 1,
            intervalMillis: 1000,
            values: [1],
            qualityFlags: [],
          },
        ],
      }),
    /未知通道/,
  );
  assert.throws(
    () =>
      validateStream({
        subjectId: "s",
        timezone: "Asia/Shanghai",
        anchors: [{ monotonicMillis: 1, wallTime: "2026-09-15T22:00:00+08:00", uncertaintyMillis: 1 }],
        batches: [
          {
            batchId: "b1",
            channel: "spo2",
            startedAtMonotonicMillis: 1,
            intervalMillis: 0,
            values: [1],
            qualityFlags: [],
          },
        ],
      }),
    /intervalMillis 必须为正/,
  );
  assert.throws(
    () =>
      validateStream({
        subjectId: "s",
        timezone: "Asia/Shanghai",
        anchors: [{ monotonicMillis: 1, wallTime: "2026-09-15T22:00:00+08:00", uncertaintyMillis: 1 }],
        batches: [
          {
            batchId: "b1",
            channel: "spo2",
            startedAtMonotonicMillis: 1,
            intervalMillis: 1000,
            values: [96, "bad"],
            qualityFlags: [],
          },
        ],
      }),
    /values\[1\]/,
  );
});

test("重复 batchId 与 subjectId 不一致被拒绝", () => {
  const b = batch("spo2", "dup", "2026-09-15T22:00:00+08:00", 1000, [96]);
  assert.throws(() => validateStream({ ...streamFor([b]), batches: [b, b] }), /batchId 重复/);
  const foreign = { ...batch("spo2", "f1", "2026-09-15T22:00:00+08:00", 1000, [96]), subjectId: "other" };
  assert.throws(() => validateStream(streamFor([foreign])), /subjectId/);
});

test("mergeStreams：相同批次去重，内容冲突报错，补传锚点合并", () => {
  const b1 = batch("spo2", "b1", "2026-09-15T22:00:00+08:00", 1000, [96, 96]);
  const base = streamFor([b1]);
  const b2 = batch("spo2", "b2", "2026-09-15T23:00:00+08:00", 1000, [95, 95]);
  const late = streamFor([b1, b2]); // 补传重复携带 b1
  const merged = mergeStreams(base, late);
  assert.equal(merged.batches.length, 2);
  assert.ok(merged.anchors.length >= 2);

  const conflict = batch("spo2", "b1", "2026-09-15T22:00:00+08:00", 1000, [90, 90]);
  assert.throws(() => mergeStreams(base, streamFor([conflict])), /内容不一致/);

  const other = { ...streamFor([b2]), subjectId: "someone-else" };
  assert.throws(() => mergeStreams(base, other), /subjectId/);
});
