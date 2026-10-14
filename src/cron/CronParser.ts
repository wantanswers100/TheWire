// CronParser — 5-field cron expression evaluator (no external dependencies)
// Fields: minute hour day-of-month month day-of-week
// Supports: * (any), N (exact), N-M (range), */N (step), N,M,... (list)

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.includes("/")) {
      const [rangeStr, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step < 1) throw new Error(`Invalid step in cron field: ${part}`);
      const [rangeMin, rangeMax] =
        rangeStr === "*"
          ? [min, max]
          : rangeStr!.includes("-")
          ? rangeStr!.split("-").map(Number) as [number, number]
          : [parseInt(rangeStr!, 10), max];
      for (let i = rangeMin; i <= rangeMax; i += step) values.push(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number) as [number, number];
      for (let i = lo; i <= hi; i++) values.push(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid cron field value: ${part}`);
      values.push(n);
    }
  }

  const unique = [...new Set(values)].filter(v => v >= min && v <= max).sort((a, b) => a - b);
  if (unique.length === 0) throw new Error(`No valid values in cron field: ${field} (range ${min}-${max})`);
  return unique;
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domIsWild: boolean;   // true when DOM field was "*" — used for POSIX OR semantics
  dowIsWild: boolean;   // true when DOW field was "*" — used for POSIX OR semantics
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }
  return {
    minutes:     parseField(fields[0]!, 0, 59),
    hours:       parseField(fields[1]!, 0, 23),
    daysOfMonth: parseField(fields[2]!, 1, 31),
    months:      parseField(fields[3]!, 1, 12),
    daysOfWeek:  parseField(fields[4]!, 0, 6),
    domIsWild:   fields[2]!.trim() === "*",
    dowIsWild:   fields[4]!.trim() === "*",
  };
}

// Compute next run time in Unix ms after `after` (defaults to now)
export function nextRunAfter(expr: string, after: number = Date.now()): number {
  const cron = parseCronExpression(expr);
  // Start 1 minute after `after`, truncated to the minute
  let candidate = new Date(after + 60_000);
  candidate.setSeconds(0, 0);

  const MAX_ITERATIONS = 366 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const month = candidate.getMonth() + 1; // 1-12
    const dom   = candidate.getDate();       // 1-31
    const dow   = candidate.getDay();        // 0-6
    const hour  = candidate.getHours();
    const min   = candidate.getMinutes();

    if (!cron.months.includes(month)) {
      candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    // POSIX: when both DOM and DOW are non-wildcard, fire if either matches (OR).
    // When one is wildcard, both must match (AND) — effectively the non-wildcard alone decides.
    const domMatch = cron.daysOfMonth.includes(dom);
    const dowMatch = cron.daysOfWeek.includes(dow);
    const dayPass = (cron.domIsWild || cron.dowIsWild)
      ? (domMatch && dowMatch)
      : (domMatch || dowMatch);
    if (!dayPass) {
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), dom + 1, 0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.includes(hour)) {
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), dom, hour + 1, 0, 0, 0);
      continue;
    }
    if (cron.minutes.includes(min)) {
      return candidate.getTime();
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }

  throw new Error(`Could not compute next run for cron expression: "${expr}"`);
}
