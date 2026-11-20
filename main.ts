// gta6-trophy-rarity-forecast-01: forecast every GTA VI PlayStation 5 trophy's
// earn rate on Exophase at the case's target, as five quantiles per trophy.
// Node 22, standard library only, no network.
//
// The forecast is built at runtime from the case's own history; nothing about
// any trophy is baked in. Three ideas carry it:
//
//   1. Earn rates move in logit space against log time. For each trophy the
//      logit of its rate is fitted by least squares against ln(1 + hours
//      since the game's release). Log time damps the extrapolation: a trophy
//      that climbed fast on launch night does not explode over the 4.5 days
//      to the target, and one that crept along stays slow. Early story
//      trophies saturate fast and rare ones grow slowly, and each trophy
//      gets its own slope from its own reads.
//   2. Stale reads are collapsed first. Exophase refreshes a game's counts
//      on its own schedule, so the house's recording holds long stretches
//      where every rate and the players-tracked count are byte-identical;
//      those stretches are one observation, not dozens, or they would pin
//      the fit flat. A read only counts when its players-tracked count or
//      the trophy's rate moved.
//   3. Slopes are shrunk toward their tier. A trophy's own slope is noisy
//      when its history is short or its counts are tiny (a handful of
//      players), so it is pulled toward the median slope of its tier
//      (platinum, gold, silver, bronze), more so the fewer distinct reads
//      it has, and clamped so no trophy is forecast to fall or to explode.
//
// The spread is honest about a multi-day extrapolation: the fit's residual
// noise, the slope's standard error stretched out to the target, and a
// random-walk term that grows with the horizon. When a case's history
// carries no trend at all (every read identical, as on launch night), the
// program falls back to a wide band around a diluted rate: the next refresh
// of Exophase's counts pulls rates down as new players join, so the median
// sits below the last read instead of on it.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The game's release, the origin of the log-time axis. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** The most the fitted slope may say a trophy grows, logit units per log-hour. */
const SLOPE_MAX = 3;
/** How many distinct reads a slope needs before it mostly trusts itself. */
const SHRINK_K = 4;
/** The random-walk spread, logit units per square-root day. */
const RW_SIGMA = 0.35;
/** The spread's floor and ceiling, logit units. */
const SPREAD_MIN = 0.5;
const SPREAD_MAX = 2.5;
/** A rate this close to 100% is forecast as staying there, with a wide band down. */
const NEAR_FULL = 99.5;
/** Where the no-trend fallback puts the median, as a share of the last rate. */
const FLAT_DILUTION = 0.45;
/** The no-trend fallback's spread, logit units, before the random-walk term. */
const FLAT_SPREAD = 0.9;

interface Trophy {
  id: number;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

interface Point {
  x: number;
  y: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logit = (pct: number): number => {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
};
const logistic = (y: number): number => 100 / (1 + Math.exp(-y));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** The median of numbers (the middle value, or the mean of the two middle ones). */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** ln(1 + hours since the game's release) at a read's timestamp. */
const xOf = (ms: number): number => Math.log1p(Math.max(0, (ms - RELEASE_MS) / 3_600_000));

/**
 * A trophy's distinct observations: one point per read whose players-tracked
 * count or rate moved since the previous kept read, so a frozen stretch of
 * the page counts once. Returns the points and the trophy's last seen rate.
 */
const observations = (c: Case, i: number): { points: Point[]; lastRate: number | null } => {
  const points: Point[] = [];
  let lastRate: number | null = null;
  let prevKey = '';
  for (const read of c.history) {
    const rate = read.rates[i];
    if (rate === null || rate === undefined) continue;
    lastRate = rate;
    const key = `${read.players_tracked}|${rate}`;
    if (key === prevKey) continue;
    prevKey = key;
    points.push({ x: xOf(Date.parse(read.at)), y: logit(rate) });
  }
  return { points, lastRate };
};

interface LineFit {
  /** Slope of logit(rate) against log time. */
  b: number;
  /** Intercept, refitted after shrinkage (see forecastOne). */
  a: number;
  /** Distinct observations behind the fit. */
  n: number;
  /** Residual spread around the line, logit units. */
  sRes: number;
  /** Mean log time of the observations. */
  xBar: number;
  /** Sum of squared log-time deviations. */
  sxx: number;
}

/** Least squares of y on x, or null when there are too few distinct points. */
const fitLine = (points: Point[]): LineFit | null => {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const xBar = sx / n;
  const yBar = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - xBar) * (p.x - xBar);
    sxy += (p.x - xBar) * (p.y - yBar);
  }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  const a = yBar - b * xBar;
  let sse = 0;
  for (const p of points) {
    const r = p.y - (a + b * p.x);
    sse += r * r;
  }
  const sRes = Math.sqrt(sse / Math.max(1, n - 2));
  return { a, b, n, sRes, xBar, sxx };
};

/**
 * One trophy's five quantiles at the target. `tierSlope` is the median fitted
 * slope of the trophy's tier (the global median when the tier has too few
 * fits of its own); `xTarget` is the target's log time; `days` the horizon
 * in days.
 */
const forecastOne = (
  points: Point[],
  fit: LineFit | null,
  lastRate: number | null,
  tierSlope: number,
  xTarget: number,
  days: number,
): number[] => {
  const rw = RW_SIGMA * Math.sqrt(days);
  // A trophy (nearly) everyone holds stays (nearly) held: forecast it at
  // 99.9% with a band that reaches down, not a logit fit pinned at 99.99.
  if (lastRate !== null && lastRate >= NEAR_FULL) {
    const s = 1.2;
    return Z.map((z) => round4(clamp(logistic(logit(99.9) + z * s), 0.01, 100)));
  }
  if (fit === null || lastRate === null) {
    // No trend to fit: the page has not moved yet. The next refresh dilutes
    // the rates as new players join, so sit below the last read, widely.
    const med = lastRate === null ? 1 : clamp(lastRate * FLAT_DILUTION, 0.01, 99.99);
    const s = Math.sqrt(FLAT_SPREAD * FLAT_SPREAD + rw * rw);
    return Z.map((z) => round4(clamp(logistic(logit(med) + z * s), 0.01, 100)));
  }
  // Shrink the slope toward the tier's, then refit the level to that slope.
  const w = fit.n / (fit.n + SHRINK_K);
  const bStar = clamp(w * fit.b + (1 - w) * tierSlope, 0, SLOPE_MAX);
  let sy = 0;
  for (const p of points) sy += p.y - bStar * p.x;
  const aStar = sy / points.length;
  const yMed = aStar + bStar * xTarget;
  // Spread: the fit's own noise, the slope's error stretched to the target,
  // and the horizon's random walk, with a floor for what no fit can see.
  const sRes = Math.max(fit.sRes, 0.1);
  const seSlope = sRes / Math.sqrt(fit.sxx);
  const sSlope = Math.min(seSlope * Math.max(0, xTarget - fit.xBar), 1.5);
  const s = clamp(Math.sqrt(sRes * sRes + sSlope * sSlope + rw * rw + 0.15 * 0.15), SPREAD_MIN, SPREAD_MAX);
  return Z.map((z) => round4(clamp(logistic(yMed + z * s), 0.01, 100)));
};

/** Forecast every trophy of one case. */
const forecastCase = (c: Case): { id: number; q: number[] }[] => {
  const xTarget = xOf(Date.parse(c.target));
  const days = c.horizon_minutes / 1440;
  const obs = c.trophies.map((_, i) => observations(c, i));
  const fits = obs.map((o) => fitLine(o.points));
  // Each tier's median fitted slope; tiers with too few fits borrow the global one.
  const allSlopes = fits.filter((f): f is LineFit => f !== null).map((f) => f.b);
  const globalSlope = allSlopes.length > 0 ? median(allSlopes) : 0;
  const tierSlopes = new Map<string, number>();
  for (const tier of new Set(c.trophies.map((t) => t.tier))) {
    const slopes = fits
      .filter((f, i): f is LineFit => f !== null && c.trophies[i].tier === tier)
      .map((f) => f.b);
    tierSlopes.set(tier, slopes.length >= 3 ? median(slopes) : globalSlope);
  }
  return c.trophies.map((t, i) => ({
    id: t.id,
    q: forecastOne(obs[i].points, fits[i], obs[i].lastRate, tierSlopes.get(t.tier) ?? globalSlope, xTarget, days),
  }));
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
