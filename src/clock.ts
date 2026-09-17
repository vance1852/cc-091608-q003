import type { ClockAnchor } from "./contracts.ts";

/**
 * 设备单调时钟 → 墙面时钟的校正。
 *
 * 腕式设备只保证单调时钟不回拨；手机/网关侧墙面时钟可能漂移。
 * 同步锚点把某个单调时刻钉到墙面时刻，锚点之间按分段线性插值
 * （可吸收恒定速率漂移），锚点范围之外按最近一段的漂移率外推，
 * 并随外推距离线性放大不确定度。
 */

/** 外推时每毫秒单调时间附加的不确定度（100 ppm，保守取值）。 */
export const EXTRAPOLATION_UNCERTAINTY_PPM = 100e-6;

export interface CorrectedInstant {
  /** UTC 纪元毫秒，便于计算。 */
  epochMillis: number;
  /** 带锚点时区偏移的 ISO 墙面时间，秒级精度。 */
  wallIso: string;
  /** 校正后仍残余的不确定度（毫秒）。 */
  uncertaintyMillis: number;
  /** 是否落在锚点覆盖范围之外（外推）。 */
  extrapolated: boolean;
  /** 格式化所用的时区偏移（分钟），取自最近锚点。 */
  offsetMinutes: number;
}

interface ParsedAnchor {
  monotonicMillis: number;
  epochMillis: number;
  offsetMinutes: number;
  uncertaintyMillis: number;
}

const OFFSET_PATTERN = /([+-])(\d{2}):(\d{2})$/;

export function parseOffsetMinutes(wallIso: string): number {
  const match = OFFSET_PATTERN.exec(wallIso);
  if (!match) {
    throw new Error(`wallTime 缺少 ±hh:mm 时区偏移: ${wallIso}`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes);
}

/** 把 UTC 纪元毫秒格式化为带固定偏移的 ISO 字符串（四舍五入到秒）。 */
export function formatIsoWithOffset(epochMillis: number, offsetMinutes: number): string {
  const shifted = new Date(Math.round(epochMillis / 1000) * 1000 + offsetMinutes * 60_000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export class DeviceClock {
  private readonly anchors: ParsedAnchor[];

  constructor(anchors: ClockAnchor[]) {
    if (anchors.length === 0) {
      throw new Error("至少需要一个同步锚点才能校正设备时钟");
    }
    const parsed = anchors.map((a) => {
      const epochMillis = Date.parse(a.wallTime);
      if (!Number.isFinite(epochMillis)) {
        throw new Error(`锚点 wallTime 无法解析: ${a.wallTime}`);
      }
      return {
        monotonicMillis: a.monotonicMillis,
        epochMillis,
        offsetMinutes: parseOffsetMinutes(a.wallTime),
        uncertaintyMillis: a.uncertaintyMillis,
      };
    });
    parsed.sort((x, y) => x.monotonicMillis - y.monotonicMillis);
    for (let i = 1; i < parsed.length; i += 1) {
      const prev = parsed[i - 1]!;
      const curr = parsed[i]!;
      if (curr.monotonicMillis <= prev.monotonicMillis) {
        throw new Error("锚点 monotonicMillis 必须严格递增");
      }
      if (curr.epochMillis <= prev.epochMillis) {
        throw new Error("锚点 wallTime 必须随单调时钟递增（墙面时钟回拨无法校正）");
      }
    }
    this.anchors = parsed;
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  /** 相邻锚点间观测到的漂移率（墙面毫秒 / 单调毫秒），仅用于报告说明。 */
  observedDriftPpm(): number[] {
    const rates: number[] = [];
    for (let i = 1; i < this.anchors.length; i += 1) {
      const a = this.anchors[i - 1]!;
      const b = this.anchors[i]!;
      const rate = (b.epochMillis - a.epochMillis) / (b.monotonicMillis - a.monotonicMillis);
      rates.push((rate - 1) * 1e6);
    }
    return rates;
  }

  private nearestAnchor(monotonicMillis: number): ParsedAnchor {
    let best = this.anchors[0]!;
    let bestDist = Math.abs(monotonicMillis - best.monotonicMillis);
    for (const a of this.anchors) {
      const d = Math.abs(monotonicMillis - a.monotonicMillis);
      if (d < bestDist) {
        best = a;
        bestDist = d;
      }
    }
    return best;
  }

  toWall(monotonicMillis: number): CorrectedInstant {
    const first = this.anchors[0]!;
    const last = this.anchors[this.anchors.length - 1]!;

    let lo: ParsedAnchor;
    let hi: ParsedAnchor;
    let extrapolated = false;

    if (monotonicMillis < first.monotonicMillis) {
      lo = first;
      hi = this.anchors[1] ?? first;
      extrapolated = true;
    } else if (monotonicMillis > last.monotonicMillis) {
      const n = this.anchors.length;
      lo = n >= 2 ? this.anchors[n - 2]! : first;
      hi = last;
      extrapolated = true;
    } else {
      lo = first;
      hi = last;
      for (let i = 1; i < this.anchors.length; i += 1) {
        const candidate = this.anchors[i]!;
        if (candidate.monotonicMillis >= monotonicMillis) {
          lo = this.anchors[i - 1]!;
          hi = candidate;
          break;
        }
      }
    }

    const span = hi.monotonicMillis - lo.monotonicMillis;
    const rate = span > 0 ? (hi.epochMillis - lo.epochMillis) / span : 1;
    const t = span > 0 ? (monotonicMillis - lo.monotonicMillis) / span : 0;
    const clampedT = extrapolated ? t : Math.min(1, Math.max(0, t));

    const epochMillis = lo.epochMillis + (monotonicMillis - lo.monotonicMillis) * rate;
    let uncertaintyMillis =
      span > 0
        ? lo.uncertaintyMillis + (hi.uncertaintyMillis - lo.uncertaintyMillis) * clampedT
        : lo.uncertaintyMillis;
    if (extrapolated) {
      const beyond =
        monotonicMillis < first.monotonicMillis
          ? first.monotonicMillis - monotonicMillis
          : monotonicMillis - last.monotonicMillis;
      uncertaintyMillis += beyond * EXTRAPOLATION_UNCERTAINTY_PPM;
    }

    const offsetMinutes = this.nearestAnchor(monotonicMillis).offsetMinutes;
    return {
      epochMillis,
      wallIso: formatIsoWithOffset(epochMillis, offsetMinutes),
      uncertaintyMillis,
      extrapolated,
      offsetMinutes,
    };
  }
}
