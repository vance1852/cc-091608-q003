/**
 * 质量门控：决定一个夜次是否“足以判读”。
 *
 * 核心原则：低灌注、采样间隔过长或有效覆盖不足时，绝不输出看似精确的
 * 整夜指数；此时 interpretable=false、index=null，并给出具体的
 * 不可判读区间与原因，供技师改善佩戴后复测。
 */

import type { SleepChannel } from "./contracts.js";
import type { TimedSample } from "./series.js";
import { isIndexable } from "./series.js";

export interface QualityPolicy {
  /** 相邻样本超过该间隔视为分段断裂（毫秒）。 */
  maxJoinGapMillis: number;
  /** 连续 null 超过该时长记为信号丢失（毫秒）。 */
  minSignalLossMillis: number;
  /** 各通道允许的最大采样间隔（毫秒）。 */
  maxIntervalMillis: Record<SleepChannel, number>;
  /** 有效覆盖率下限（有效血氧时长 / 监测窗口）。 */
  minCoverageRatio: number;
  /** 有效血氧时长下限（毫秒）。 */
  minValidDurationMillis: number;
  /** 监测窗口下限（毫秒），低于则根本谈不上“整夜”。 */
  minWindowMillis: number;
}

export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  maxJoinGapMillis: 120_000,
  minSignalLossMillis: 60_000,
  maxIntervalMillis: {
    spo2: 12_000,
    "pulse-wave": 12_000,
    actigraphy: 60_000,
  },
  minCoverageRatio: 0.7,
  minValidDurationMillis: 4 * 3_600_000,
  minWindowMillis: 3_600_000,
};

export interface ValidDenominator {
  /** 监测窗口（首个到末个血氧样本）。 */
  windowMillis: number;
  /** 可用于指数计算的有效血氧时长。 */
  validMillis: number;
  coverageRatio: number;
}

/** 计算有效分母：指数只允许建立在有效血氧时长之上。 */
export function computeDenominator(
  spo2Samples: TimedSample[],
  maxIntervalMillis: number,
): ValidDenominator | null {
  if (spo2Samples.length === 0) return null;
  const first = spo2Samples[0]!;
  const last = spo2Samples[spo2Samples.length - 1]!;
  const windowMillis = last.mono + last.interval - first.mono;
  let validMillis = 0;
  for (const sample of spo2Samples) {
    // 降采样（间隔过长）的样本同样不算有效：它们撑不起可靠的事件判定
    if (isIndexable(sample) && sample.interval <= maxIntervalMillis) {
      validMillis += sample.interval;
    }
  }
  return {
    windowMillis,
    validMillis,
    coverageRatio: windowMillis > 0 ? validMillis / windowMillis : 0,
  };
}

export interface InterpretabilityVerdict {
  interpretable: boolean;
  /** 不可判读（或部分不可判读）的具体原因说明。 */
  reasons: string[];
}

/** 依据质量策略判定夜次是否足以给出指数。 */
export function judgeInterpretability(
  denominator: ValidDenominator | null,
  policy: QualityPolicy,
): InterpretabilityVerdict {
  if (denominator === null) {
    return { interpretable: false, reasons: ["本夜次没有任何血氧数据"] };
  }
  const reasons: string[] = [];
  if (denominator.windowMillis < policy.minWindowMillis) {
    reasons.push(
      `监测窗口仅 ${formatMinutes(denominator.windowMillis)}，不足 ${formatMinutes(policy.minWindowMillis)}，无法代表整夜`,
    );
  }
  if (denominator.validMillis < policy.minValidDurationMillis) {
    reasons.push(
      `有效血氧时长仅 ${formatMinutes(denominator.validMillis)}，不足 ${formatMinutes(policy.minValidDurationMillis)}`,
    );
  }
  if (denominator.coverageRatio < policy.minCoverageRatio) {
    reasons.push(
      `有效覆盖率 ${(denominator.coverageRatio * 100).toFixed(1)}%，低于要求的 ${(policy.minCoverageRatio * 100).toFixed(0)}%`,
    );
  }
  return { interpretable: reasons.length === 0, reasons };
}

export function formatMinutes(millis: number): string {
  const minutes = millis / 60_000;
  return minutes >= 90 ? `${(minutes / 60).toFixed(1)} 小时` : `${Math.round(minutes)} 分钟`;
}
