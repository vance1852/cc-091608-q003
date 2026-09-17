/**
 * 设备单调时钟 → 挂钟时间的校正模型。
 *
 * 腕式设备给的是单调递增的设备时钟（monotonicMillis），手机端在同步时
 * 记录锚点（单调时钟 ↔ 挂钟时间）。两个锚点之间用分段线性插值吸收
 * 手机时钟漂移；锚点区间之外允许外推，但不确定性随距离增长并显式标记，
 * 让下游可以诚实地标注“此段时钟为外推”。
 */

import type { ClockAnchor } from "./contracts.js";
import { formatWallTime } from "./timezone.js";

/** 锚点区间之外，每外推一小时增加的不确定度（毫秒）。 */
export const EXTRAPOLATION_UNCERTAINTY_PER_HOUR_MILLIS = 50;

interface AnchorPoint {
  mono: number;
  epoch: number;
  uncertainty: number;
}

export interface CorrectedInstant {
  /** 校正后的纪元毫秒。 */
  epochMillis: number;
  /** 带时区偏移的 ISO 8601 挂钟时间。 */
  wallTime: string;
  /** 该时刻的不确定度（毫秒）。 */
  uncertaintyMillis: number;
  /** 是否位于锚点区间之外（外推段）。 */
  extrapolated: boolean;
}

export class DeviceClock {
  private readonly points: AnchorPoint[];
  private readonly timeZone: string;
  /** 首末锚点推算的漂移率（ppm）；锚点不足两个时为 null。 */
  readonly driftPpm: number | null;

  constructor(anchors: ClockAnchor[], timeZone: string) {
    if (anchors.length === 0) {
      throw new Error("至少需要一个同步锚点才能校正设备时钟");
    }
    this.timeZone = timeZone;
    const sorted = [...anchors].sort((a, b) => a.monotonicMillis - b.monotonicMillis);
    this.points = sorted.map((anchor) => {
      const epoch = Date.parse(anchor.wallTime);
      if (Number.isNaN(epoch)) {
        throw new Error(`同步锚点的 wallTime 无法解析: ${anchor.wallTime}`);
      }
      return {
        mono: anchor.monotonicMillis,
        epoch,
        uncertainty: Math.max(0, anchor.uncertaintyMillis),
      };
    });
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    this.driftPpm =
      this.points.length >= 2 && last.mono > first.mono
        ? ((last.epoch - first.epoch - (last.mono - first.mono)) /
            (last.mono - first.mono)) *
          1e6
        : null;
  }

  /** 单调时钟 → 校正后的挂钟时刻。 */
  correct(monotonicMillis: number): CorrectedInstant {
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    let epoch: number;
    let uncertainty: number;
    let extrapolated: boolean;

    if (monotonicMillis <= first.mono) {
      epoch = first.epoch + (monotonicMillis - first.mono) * this.slopeNear(0);
      uncertainty = first.uncertainty + this.extrapolationGrowth(first.mono - monotonicMillis);
      extrapolated = monotonicMillis < first.mono;
    } else if (monotonicMillis >= last.mono) {
      epoch = last.epoch + (monotonicMillis - last.mono) * this.slopeNear(this.points.length - 1);
      uncertainty = last.uncertainty + this.extrapolationGrowth(monotonicMillis - last.mono);
      extrapolated = monotonicMillis > last.mono;
    } else {
      let index = 0;
      while (index < this.points.length - 1 && this.points[index + 1]!.mono < monotonicMillis) {
        index += 1;
      }
      const a = this.points[index]!;
      const b = this.points[index + 1]!;
      const ratio = (monotonicMillis - a.mono) / (b.mono - a.mono);
      epoch = a.epoch + (monotonicMillis - a.mono) * ((b.epoch - a.epoch) / (b.mono - a.mono));
      uncertainty = a.uncertainty + (b.uncertainty - a.uncertainty) * ratio;
      extrapolated = false;
    }

    return {
      epochMillis: epoch,
      wallTime: formatWallTime(epoch, this.timeZone),
      uncertaintyMillis: uncertainty,
      extrapolated,
    };
  }

  /** 挂钟纪元毫秒 → 单调时钟（correct 的逆映射，用于把技师排除段换算回设备时钟）。 */
  invert(epochMillis: number): number {
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    if (epochMillis <= first.epoch) {
      return first.mono + (epochMillis - first.epoch) / this.slopeNear(0);
    }
    if (epochMillis >= last.epoch) {
      return last.mono + (epochMillis - last.epoch) / this.slopeNear(this.points.length - 1);
    }
    let index = 0;
    while (index < this.points.length - 1 && this.points[index + 1]!.epoch < epochMillis) {
      index += 1;
    }
    const a = this.points[index]!;
    const b = this.points[index + 1]!;
    const slope = (b.epoch - a.epoch) / (b.mono - a.mono);
    return a.mono + (epochMillis - a.epoch) / slope;
  }

  /** 末个锚点的单调时钟位置，用于判断数据是否超出锚点区间。 */
  get lastAnchorMonotonicMillis(): number {
    return this.points[this.points.length - 1]!.mono;
  }

  private slopeNear(index: number): number {
    if (this.points.length < 2) return 1;
    const clamped = Math.min(Math.max(index, 0), this.points.length - 2);
    const a = this.points[clamped]!;
    const b = this.points[clamped + 1]!;
    return (b.epoch - a.epoch) / (b.mono - a.mono);
  }

  private extrapolationGrowth(distanceMono: number): number {
    return (
      (Math.max(0, distanceMono) / 3_600_000) * EXTRAPOLATION_UNCERTAINTY_PER_HOUR_MILLIS
    );
  }
}
