import type {
  Candle,
  PhaseSegment,
  StructurePoint,
  WyckoffPhaseType,
} from "./types";
import { sma, atr, volumeAverage, rollingHigh, rollingLow } from "./indicators";

/**
 * Wyckoff perception engine.
 *
 * Deterministic, rule-based detection of the four Wyckoff phases and the key
 * structural events (Spring, SOS, LPS, UTAD, SOW). Designed to produce sensible
 * output on real daily crypto data without relying on any external LLM.
 */

const MA_FAST = 20;
const MA_SLOW = 50;
const RANGE_WIN = 20; // window used to describe the current trading range
const VOL_WIN = 20;

export interface WyckoffContext {
  maFast: number[];
  maSlow: number[];
  atr: number[];
  volAvg: number[];
}

export function computeContext(candles: Candle[]): WyckoffContext {
  const closes = candles.map((c) => c.close);
  return {
    maFast: sma(closes, MA_FAST),
    maSlow: sma(closes, MA_SLOW),
    atr: atr(candles, 14),
    volAvg: volumeAverage(candles, VOL_WIN),
  };
}

/**
 * Classify each bar into a Wyckoff phase using trend + volatility heuristics:
 * - Markup:   fast MA > slow MA, price making higher highs, MA slope up
 * - Markdown: fast MA < slow MA, price making lower lows, MA slope down
 * - Accumulation: low slope / sideways after a decline, contracted range near lows
 * - Distribution: low slope / sideways after an advance, contracted range near highs
 */
function classifyBar(
  candles: Candle[],
  i: number,
  ctx: WyckoffContext
): WyckoffPhaseType {
  if (i < MA_SLOW) return "Undefined";

  const c = candles[i];
  const fast = ctx.maFast[i];
  const slow = ctx.maSlow[i];
  const slopeWin = 10;
  const fastPrev = ctx.maFast[i - slopeWin];
  if (Number.isNaN(fast) || Number.isNaN(slow) || Number.isNaN(fastPrev)) {
    return "Undefined";
  }

  const slope = (fast - fastPrev) / fastPrev; // normalized fast-MA slope
  const rangeHigh = rollingHigh(candles, i, RANGE_WIN);
  const rangeLow = rollingLow(candles, i, RANGE_WIN);
  const rangeSize = (rangeHigh - rangeLow) / rangeLow;
  const pos = (c.close - rangeLow) / Math.max(rangeHigh - rangeLow, 1e-9); // 0..1 within range

  const TREND_SLOPE = 0.03; // 3% MA move over slopeWin bars => trending
  const FLAT_SLOPE = 0.02;
  const TIGHT_RANGE = 0.18; // <18% range over window => consolidation

  // Strong trends first
  if (fast > slow && slope > TREND_SLOPE) return "Markup";
  if (fast < slow && slope < -TREND_SLOPE) return "Markdown";

  // Sideways / consolidation: decide accumulation vs distribution by context
  const isFlat = Math.abs(slope) < FLAT_SLOPE || rangeSize < TIGHT_RANGE;
  if (isFlat) {
    // Look back ~30 bars to see whether we arrived here after a decline or advance
    const lookback = 30;
    const past = Math.max(0, i - lookback);
    const priorMove = (c.close - candles[past].close) / candles[past].close;
    if (priorMove < -0.05 || pos < 0.5) return "Accumulation";
    if (priorMove > 0.05 || pos >= 0.5) return "Distribution";
    return fast >= slow ? "Distribution" : "Accumulation";
  }

  // Mild trend fallback
  if (fast >= slow) return "Markup";
  return "Markdown";
}

/** Smooth raw per-bar labels into contiguous segments, removing tiny noise runs. */
export function detectPhases(
  candles: Candle[],
  ctx: WyckoffContext
): PhaseSegment[] {
  const raw: WyckoffPhaseType[] = candles.map((_, i) =>
    classifyBar(candles, i, ctx)
  );

  // Majority smoothing with a small window to reduce flicker
  const smoothed: WyckoffPhaseType[] = raw.slice();
  const sw = 3;
  for (let i = 0; i < raw.length; i++) {
    const counts: Record<string, number> = {};
    for (let k = Math.max(0, i - sw); k <= Math.min(raw.length - 1, i + sw); k++) {
      counts[raw[k]] = (counts[raw[k]] || 0) + 1;
    }
    let best = raw[i];
    let bestN = -1;
    for (const [p, n] of Object.entries(counts)) {
      if (n > bestN) {
        bestN = n;
        best = p as WyckoffPhaseType;
      }
    }
    smoothed[i] = best;
  }

  // Build segments
  const segments: PhaseSegment[] = [];
  let start = 0;
  for (let i = 1; i <= smoothed.length; i++) {
    if (i === smoothed.length || smoothed[i] !== smoothed[start]) {
      const phase = smoothed[start];
      segments.push({
        phase,
        startIndex: start,
        endIndex: i - 1,
        startTime: candles[start].time,
        endTime: candles[i - 1].time,
        note: phaseNote(phase),
      });
      start = i;
    }
  }

  // Merge segments shorter than 3 bars into the previous segment
  const merged: PhaseSegment[] = [];
  for (const seg of segments) {
    const len = seg.endIndex - seg.startIndex + 1;
    if (merged.length > 0 && len < 3) {
      const prev = merged[merged.length - 1];
      prev.endIndex = seg.endIndex;
      prev.endTime = seg.endTime;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

function phaseNote(phase: WyckoffPhaseType): string {
  switch (phase) {
    case "Accumulation":
      return "吸筹：价格在低位区间震荡，主力低吸，波动收敛、缩量后伺机放量。";
    case "Markup":
      return "拉升：均线多头排列，价格持续创新高，趋势向上。";
    case "Distribution":
      return "派发：价格在高位区间震荡，主力派货，上涨乏力。";
    case "Markdown":
      return "下跌：均线空头排列，价格持续创新低，趋势向下。";
    default:
      return "数据不足或形态不明确。";
  }
}

/**
 * Detect Wyckoff structural events on top of the phase map.
 * Each event is anchored to a bar index with a price and a bullish/bearish bias.
 */
export function detectStructures(
  candles: Candle[],
  ctx: WyckoffContext,
  phases: PhaseSegment[]
): StructurePoint[] {
  const points: StructurePoint[] = [];
  const phaseAt = (i: number): WyckoffPhaseType => {
    for (const s of phases) if (i >= s.startIndex && i <= s.endIndex) return s.phase;
    return "Undefined";
  };

  for (let i = MA_SLOW; i < candles.length; i++) {
    const c = candles[i];
    const prevLow = rollingLow(candles, i, RANGE_WIN, true);
    const prevHigh = rollingHigh(candles, i, RANGE_WIN, true);
    const vol = c.volume;
    const vAvg = ctx.volAvg[i];
    const highVol = !Number.isNaN(vAvg) && vol > vAvg * 1.4;
    const phase = phaseAt(i);
    const nearAccum = phase === "Accumulation" || phase === "Markup";
    const nearDist = phase === "Distribution" || phase === "Markdown";

    // Spring: intrabar break below prior support low, but close back inside range.
    if (
      c.low < prevLow &&
      c.close > prevLow &&
      (phase === "Accumulation" || phaseAt(i - 1) === "Accumulation")
    ) {
      points.push({
        type: "Spring",
        index: i,
        time: c.time,
        price: c.low,
        bias: "bullish",
        explanation:
          "弹簧：盘中跌破前期支撑后快速收回区间内，假突破洗盘，吸筹末端的看多信号。",
      });
      continue;
    }

    // UTAD: intrabar break above prior resistance high, but close back inside range.
    if (
      c.high > prevHigh &&
      c.close < prevHigh &&
      (phase === "Distribution" || phaseAt(i - 1) === "Distribution")
    ) {
      points.push({
        type: "UTAD",
        index: i,
        time: c.time,
        price: c.high,
        bias: "bearish",
        explanation:
          "UTAD：盘中突破前期高点后快速跌回区间内，假突破诱多，派发末端的看空信号。",
      });
      continue;
    }

    // SOS: strong close above the prior range high on expanded volume (accumulation breakout).
    if (c.close > prevHigh && highVol && nearAccum) {
      points.push({
        type: "SOS",
        index: i,
        time: c.time,
        price: c.close,
        bias: "bullish",
        explanation: "SOS 强势信号：放量突破吸筹区间上沿，需求占优。",
      });
      continue;
    }

    // SOW: weak close below the prior range low on expanded volume (distribution breakdown).
    if (c.close < prevLow && highVol && nearDist) {
      points.push({
        type: "SOW",
        index: i,
        time: c.time,
        price: c.close,
        bias: "bearish",
        explanation: "SOW 弱势信号：放量跌破派发区间下沿，供给占优。",
      });
      continue;
    }

    // LPS: after a recent SOS, a pullback that holds above the breakout area.
    const recentSOS = points
      .slice()
      .reverse()
      .find((p) => p.type === "SOS" && i - p.index > 0 && i - p.index <= 12);
    if (
      recentSOS &&
      c.low <= recentSOS.price &&
      c.close > recentSOS.price * 0.985 &&
      c.close > c.open &&
      nearAccum
    ) {
      const already = points.some((p) => p.type === "LPS" && i - p.index < 5);
      if (!already) {
        points.push({
          type: "LPS",
          index: i,
          time: c.time,
          price: c.low,
          bias: "bullish",
          explanation:
            "LPS 最后支撑点：突破后回踩不破前高/支撑，多头确认，趋势延续。",
        });
        continue;
      }
    }
  }

  return points;
}

export interface WyckoffAnalysis {
  phases: PhaseSegment[];
  structurePoints: StructurePoint[];
  currentPhase: WyckoffPhaseType;
}

export function analyzeWyckoff(candles: Candle[]): WyckoffAnalysis {
  const ctx = computeContext(candles);
  const phases = detectPhases(candles, ctx);
  const structurePoints = detectStructures(candles, ctx, phases);
  const currentPhase =
    phases.length > 0 ? phases[phases.length - 1].phase : "Undefined";
  return { phases, structurePoints, currentPhase };
}
