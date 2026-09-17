#!/usr/bin/env node
/**
 * 命令行入口：读取居家监测数据流，生成初筛报告。
 *
 * 用法：
 *   node dist/src/cli.js [数据流.json] [--json] [--exclude "from,to,原因"]...
 *
 * 流程演示：先为每个夜次生成草稿 v1；随后签署首个夜次的 v1，
 * 再按技师排除区间重新生成 v2 草稿——已签署版本保持原样。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeStream, type NightAnalysis } from "./analysis.js";
import { parseOvernightStream } from "./ingest.js";
import { composeReportBase, summarizeReport } from "./report.js";
import { ReportStore } from "./store.js";
import type { ExclusionRangeWall } from "./series.js";

interface CliArgs {
  fixturePath: string;
  json: boolean;
  exclusions: ExclusionRangeWall[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturePath: "fixtures/overnight-stream.json",
    json: false,
    exclusions: [],
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--exclude") {
      const spec = argv[++index];
      if (spec === undefined) throw new Error("--exclude 需要 \"from,to,原因\" 参数");
      const [from, to, ...reasonParts] = spec.split(",");
      if (!from || !to || reasonParts.length === 0) {
        throw new Error(`--exclude 参数格式应为 "from,to,原因": ${spec}`);
      }
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        throw new Error(`--exclude 时间无法解析: ${spec}`);
      }
      args.exclusions.push({ from, to, reason: reasonParts.join(",") });
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) args.fixturePath = positional[0]!;
  return args;
}

/** 未显式指定排除区间时，自动挑一个体动伪差事件做演示。 */
function autoPickExclusion(night: NightAnalysis): ExclusionRangeWall[] {
  const artifact = night.events.find((event) => event.movementArtifact);
  if (artifact === undefined) return [];
  return [{ from: artifact.startWall, to: artifact.endWall, reason: "体动伪差，技师排除" }];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw: unknown = JSON.parse(readFileSync(resolve(args.fixturePath), "utf8"));
  const stream = parseOvernightStream(raw);
  const generatedAt = new Date().toISOString();
  const meta = { subjectId: stream.subjectId, timeZone: stream.timeZone, generatedAt };

  const store = new ReportStore();
  const firstPass = analyzeStream(stream);
  if (firstPass.nights.length === 0) {
    console.log("数据流中没有任何夜次。");
    return;
  }
  const drafts = firstPass.nights.map((night) =>
    store.createDraft(composeReportBase(night, meta)),
  );

  if (!args.json) {
    for (const draft of drafts) {
      console.log(summarizeReport(draft));
      console.log("");
    }
  }

  // 版本流：签署首夜 v1 → 技师排除片段 → 重新生成 v2 草稿
  const firstNight = firstPass.nights[0]!;
  const signed = store.sign(drafts[0]!.reportId, new Date().toISOString());
  const exclusions = args.exclusions.length > 0 ? args.exclusions : autoPickExclusion(firstNight);
  const regenerated = analyzeStream(stream, { exclusions }).nights.find(
    (night) => night.nightId === firstNight.nightId,
  )!;
  const secondDraft = store.createDraft(composeReportBase(regenerated, meta));

  if (args.json) {
    console.log(JSON.stringify(store.listForNight(firstNight.nightId), null, 2));
    return;
  }

  console.log("—— 报告版本流 ——");
  console.log(
    `已签署版本 ${signed.reportId}（signedAt=${signed.signedAt ?? "?"}）：` +
      `事件 ${signed.eventTimeline.length} 件，签署后保持原样`,
  );
  console.log(
    `重新生成 ${secondDraft.reportId}（草稿）：排除 ${secondDraft.excludedRanges.length} 个区间，` +
      `事件 ${secondDraft.eventTimeline.length} 件`,
  );
  for (const range of secondDraft.excludedRanges) {
    console.log(`  排除 ${range.from} → ${range.to}：${range.reason}`);
  }
  console.log(`夜次 ${firstNight.nightId} 现有版本：${store.listForNight(firstNight.nightId).map((r) => `${r.reportId}(${r.state})`).join("、")}`);
}

main();
