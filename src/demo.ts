/**
 * 端到端演示：技师早晨导入居家腕式筛查数据的完整工作流。
 *
 *   node --experimental-strip-types src/demo.ts
 *
 * 流程：导入主文件 → 时钟校正 → 夜次/分段 → 生成草稿 v1 →
 * 技师排除体动片段 → 重新生成 v2 → 签署 v2 → 补传到达 →
 * 生成 v3 草稿（签署版 v2 保持原样）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadStreamFile } from "./ingest.ts";
import { DeviceClock } from "./clock.ts";
import { ReportStore } from "./report.ts";
import { renderPhysicianView } from "./view.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function banner(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

// 固定“当前时间”，让演示输出可复现。
let tick = 0;
const now = () => new Date(Date.parse("2026-09-16T08:30:00+08:00") + tick++ * 60_000);

const store = new ReportStore({ now });

banner("1. 导入居家采集流（含时钟漂移、半夜摘戴、低灌注、断连缺口）");
const stream = await loadStreamFile(join(fixtures, "overnight-stream.json"));
store.addStream(stream);
const clock = new DeviceClock(stream.anchors);
console.log(`受试者 ${stream.subjectId}，批次 ${stream.batches.length} 个，锚点 ${clock.anchorCount} 个`);
console.log(`观测漂移率: ${clock.observedDriftPpm().map((p) => p.toFixed(1)).join(", ")} ppm`);
const probe = clock.toWall(21601000);
console.log(
  `校正示例: 单调时刻 21601000 → ${probe.wallIso}（不确定度 ±${probe.uncertaintyMillis.toFixed(0)}ms）`,
);
console.log(`夜次: ${store.listNights().join(", ")}`);

const nightId = store.listNights()[0]!;

banner("2. 生成草稿 v1（医师视图）");
const v1 = store.generateReport(nightId);
console.log(renderPhysicianView(v1));

banner("3. 技师排除体动干扰片段 01:45~01:52，重新生成 v2");
const v2 = store.generateReport(nightId, {
  excludedRanges: [
    { from: "2026-09-16T01:45:00+08:00", to: "2026-09-16T01:52:00+08:00", reason: "体动干扰，技师确认伪差" },
  ],
});
console.log(
  `v1 候选事件 ${v1.payload.events.length} 个 → v2 候选事件 ${v2.payload.events.length} 个；` +
    `v2 有效分母 ${v2.payload.metrics.validMinutes} 分钟`,
);
console.log(`v2 排除段: ${JSON.stringify(v2.excludedRanges)}`);

banner("4. 医师签署 v2（签署版冻结）");
const signedV2 = store.sign(v2.reportId);
console.log(`已签署: ${signedV2.reportId}，signedAt=${signedV2.signedAt}，冻结=${Object.isFrozen(signedV2)}`);
try {
  store.sign(v2.reportId);
} catch (err) {
  console.log(`再次签署被拒绝: ${(err as Error).message}`);
}
try {
  store.sign(v1.reportId);
} catch (err) {
  console.log(`签署旧草稿被拒绝: ${(err as Error).message}`);
}

banner("5. 补传到达（03:30~03:44 断连窗口），只形成新草稿 v3");
const late = await loadStreamFile(join(fixtures, "late-arrival.json"));
store.addStream(late);
const v3 = store.generateReport(nightId);
console.log(`v3 状态=${v3.state}，supersedes=${v3.supersedesReportId}，沿用排除段=${v3.excludedRanges.length} 条`);
console.log(
  `v2(签署版) 候选事件 ${signedV2.payload.events.length} 个，不可判读区间 ${signedV2.payload.uninterpretable.length} 段 —— 保持原样`,
);
console.log(
  `v3(新草稿) 候选事件 ${v3.payload.events.length} 个，不可判读区间 ${v3.payload.uninterpretable.length} 段`,
);
const newEvent = v3.payload.events.find((e) => !signedV2.payload.events.some((o) => o.startedAt === e.startedAt));
if (newEvent) {
  console.log(
    `补传带来的新候选事件: ${newEvent.startedAt} ~ ${newEvent.endedAt}，nadir ${newEvent.nadirSpo2}%（批次 ${newEvent.sourceBatchIds.join(",")}）`,
  );
}
const stillGap = signedV2.payload.uninterpretable.some((iv) => iv.reason === "no-data");
console.log(`签署版 v2 仍记录断连缺口（no-data）: ${stillGap}；v3 中该缺口已由补传填补`);

banner("6. v3 医师视图（补传后）");
console.log(renderPhysicianView(v3));

banner("7. 版本历史");
for (const r of store.history(nightId)) {
  console.log(
    `  ${r.reportId}  v${r.version}  ${r.state}${r.signedAt ? ` (${r.signedAt})` : ""}  ` +
      `事件 ${r.payload.events.length}  ODI3=${r.payload.metrics.odi3.status === "ok" ? r.payload.metrics.odi3.value : "不可判读"}`,
  );
}
