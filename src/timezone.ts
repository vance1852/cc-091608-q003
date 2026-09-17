/**
 * 时区感知的本地时间工具。
 *
 * 夜次按“正午 → 次日正午”划分，跨午夜的睡眠自然归入前一晚；
 * 挂钟时间的格式化与偏移计算只依赖 Intl，不引入外部时区数据库。
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  formatterCache.set(timeZone, created);
  return created;
}

export interface LocalDateTimeParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  millisecond: number;
}

/** 把纪元毫秒投影为指定时区下的本地时间字段。 */
export function localParts(epochMillis: number, timeZone: string): LocalDateTimeParts {
  // 先舍入到整毫秒：时钟校正可能产生亚毫秒小数，而 Intl 只保留到毫秒，
  // 不先舍入会让偏移推算出现 ±1 毫秒的抖动
  const rounded = Math.round(epochMillis);
  const parts = formatter(timeZone).formatToParts(new Date(rounded));
  const values = new Map<string, number>();
  for (const part of parts) {
    if (part.type !== "literal" && part.type !== "dayPeriod") {
      values.set(part.type, Number(part.value));
    }
  }
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: (values.get("hour") ?? 0) % 24,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
    millisecond: values.get("fractionalSecond") ?? 0,
  };
}

/** 指定时刻下时区相对 UTC 的偏移（毫秒，含夏令时）。 */
export function offsetMillisAt(epochMillis: number, timeZone: string): number {
  const rounded = Math.round(epochMillis);
  const p = localParts(rounded, timeZone);
  const interpretedAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
    p.millisecond,
  );
  return interpretedAsUtc - rounded;
}

/** 把指定时区下的本地时间换算回纪元毫秒（对偏移做一次迭代修正）。 */
export function zonedLocalToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = offsetMillisAt(guess, timeZone);
  const candidate = guess - firstOffset;
  const secondOffset = offsetMillisAt(candidate, timeZone);
  return firstOffset === secondOffset ? candidate : guess - secondOffset;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 格式化为带时区偏移的 ISO 8601 字符串，例如 2026-09-16T04:45:04+08:00。 */
export function formatWallTime(epochMillis: number, timeZone: string): string {
  const p = localParts(epochMillis, timeZone);
  const offset = offsetMillisAt(epochMillis, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const offsetHours = pad2(Math.floor(abs / 3_600_000));
  const offsetMinutes = pad2(Math.floor((abs % 3_600_000) / 60_000));
  const base =
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}` +
    `T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  const fraction =
    p.millisecond === 0 ? "" : `.${String(p.millisecond).padStart(3, "0")}`;
  return `${base}${fraction}${sign}${offsetHours}:${offsetMinutes}`;
}

function previousCalendarDate(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const epoch = Date.UTC(year, month - 1, day) - 86_400_000;
  const date = new Date(epoch);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * 夜次标识：正午（含）到次日正午（不含）属于同一夜次，
 * 夜次以起始傍晚的本地日期命名，如 "2026-09-15"。
 * 因此跨午夜睡眠与凌晨觉醒都归入同一夜次。
 */
export function nightIdFor(epochMillis: number, timeZone: string): string {
  const p = localParts(epochMillis, timeZone);
  const date =
    p.hour >= 12
      ? { year: p.year, month: p.month, day: p.day }
      : previousCalendarDate(p.year, p.month, p.day);
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** 夜次 "YYYY-MM-DD" 对应的正午 → 次日正午纪元毫秒窗口。 */
export function nightWindowFor(
  nightId: string,
  timeZone: string,
): { fromEpoch: number; toEpoch: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nightId);
  if (!match) throw new Error(`非法夜次标识: ${nightId}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const fromEpoch = zonedLocalToEpoch(timeZone, year, month, day, 12, 0, 0);
  const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
  const toEpoch = zonedLocalToEpoch(
    timeZone,
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    12,
    0,
    0,
  );
  return { fromEpoch, toEpoch };
}
