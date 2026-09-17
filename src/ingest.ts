import { readFile } from "node:fs/promises";
import type { ClockAnchor, SampleBatch, SleepChannel } from "./contracts.ts";

/**
 * 采集流文件的读取与校验。文件即设备/网关上传的原始批次，
 * 校验失败时抛出带字段路径的错误，绝不让畸形数据进入分析。
 */

export interface StreamFile {
  subjectId: string;
  timezone: string;
  anchors: ClockAnchor[];
  batches: SampleBatch[];
}

export class StreamValidationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = "StreamValidationError";
    this.path = path;
  }
}

const CHANNELS: ReadonlySet<string> = new Set<SleepChannel>(["spo2", "pulse-wave", "actigraphy"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new StreamValidationError(`应为非空字符串`, `${path}.${key}`);
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StreamValidationError(`应为有限数值`, `${path}.${key}`);
  }
  return value;
}

function parseAnchor(raw: unknown, path: string): ClockAnchor {
  if (!isRecord(raw)) throw new StreamValidationError("锚点应为对象", path);
  return {
    monotonicMillis: requireNumber(raw, "monotonicMillis", path),
    wallTime: requireString(raw, "wallTime", path),
    uncertaintyMillis: requireNumber(raw, "uncertaintyMillis", path),
  };
}

function parseBatch(raw: unknown, path: string, subjectId: string): SampleBatch {
  if (!isRecord(raw)) throw new StreamValidationError("批次应为对象", path);
  const channel = requireString(raw, "channel", path);
  if (!CHANNELS.has(channel)) {
    throw new StreamValidationError(`未知通道 "${channel}"`, `${path}.channel`);
  }
  const intervalMillis = requireNumber(raw, "intervalMillis", path);
  if (intervalMillis <= 0) {
    throw new StreamValidationError("intervalMillis 必须为正", `${path}.intervalMillis`);
  }
  const rawValues = raw["values"];
  if (!Array.isArray(rawValues)) {
    throw new StreamValidationError("values 应为数组", `${path}.values`);
  }
  const values: Array<number | null> = rawValues.map((v, i) => {
    if (v === null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    throw new StreamValidationError("采样值应为数值或 null", `${path}.values[${i}]`);
  });
  const rawFlags = raw["qualityFlags"];
  if (!Array.isArray(rawFlags) || rawFlags.some((f) => typeof f !== "string")) {
    throw new StreamValidationError("qualityFlags 应为字符串数组", `${path}.qualityFlags`);
  }
  // 批次级 subjectId 可省略，省略时继承文件级 subjectId。
  const batchSubject = typeof raw["subjectId"] === "string" ? raw["subjectId"] : subjectId;
  return {
    batchId: requireString(raw, "batchId", path),
    subjectId: batchSubject,
    channel: channel as SleepChannel,
    startedAtMonotonicMillis: requireNumber(raw, "startedAtMonotonicMillis", path),
    intervalMillis,
    values,
    qualityFlags: rawFlags as string[],
  };
}

export function validateStream(json: unknown): StreamFile {
  if (!isRecord(json)) throw new StreamValidationError("流文件应为 JSON 对象", "$");
  const subjectId = requireString(json, "subjectId", "$");
  const timezone = requireString(json, "timezone", "$");
  const rawAnchors = json["anchors"];
  if (!Array.isArray(rawAnchors) || rawAnchors.length === 0) {
    throw new StreamValidationError("anchors 应为非空数组", "$.anchors");
  }
  const anchors = rawAnchors.map((a, i) => parseAnchor(a, `$.anchors[${i}]`));
  const rawBatches = json["batches"];
  if (!Array.isArray(rawBatches)) {
    throw new StreamValidationError("batches 应为数组", "$.batches");
  }
  const batches = rawBatches.map((b, i) => parseBatch(b, `$.batches[${i}]`, subjectId));
  for (const b of batches) {
    if (b.subjectId !== subjectId) {
      throw new StreamValidationError(
        `批次 ${b.batchId} 的 subjectId (${b.subjectId}) 与文件 (${subjectId}) 不一致`,
        "$.batches",
      );
    }
  }
  const ids = new Set<string>();
  for (const b of batches) {
    if (ids.has(b.batchId)) {
      throw new StreamValidationError(`batchId 重复: ${b.batchId}`, "$.batches");
    }
    ids.add(b.batchId);
  }
  return { subjectId, timezone, anchors, batches };
}

export async function loadStreamFile(path: string): Promise<StreamFile> {
  const text = await readFile(path, "utf8");
  return validateStream(JSON.parse(text));
}

/**
 * 合并补传流：同一受试者、锚点按单调时刻去重合并、批次按 batchId 去重
 * （补传文件可能重复携带已上传批次）。绝不覆盖已有批次内容——
 * 若同一 batchId 内容不一致则报错，由技师人工处理。
 */
export function mergeStreams(base: StreamFile, late: StreamFile): StreamFile {
  if (base.subjectId !== late.subjectId) {
    throw new StreamValidationError(
      `补传 subjectId (${late.subjectId}) 与既有流 (${base.subjectId}) 不一致`,
      "$.subjectId",
    );
  }
  const anchorByMono = new Map<number, ClockAnchor>();
  for (const a of [...base.anchors, ...late.anchors]) {
    anchorByMono.set(a.monotonicMillis, a);
  }
  const batchById = new Map<string, SampleBatch>();
  for (const b of base.batches) batchById.set(b.batchId, b);
  for (const b of late.batches) {
    const existing = batchById.get(b.batchId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(b)) {
      throw new StreamValidationError(
        `补传批次 ${b.batchId} 与已有同 id 批次内容不一致`,
        "$.batches",
      );
    }
    batchById.set(b.batchId, b);
  }
  return {
    subjectId: base.subjectId,
    timezone: base.timezone,
    anchors: [...anchorByMono.values()].sort((x, y) => x.monotonicMillis - y.monotonicMillis),
    batches: [...batchById.values()],
  };
}
