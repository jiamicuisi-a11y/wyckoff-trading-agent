import type {
  Candle,
  StructurePoint,
  TradeSignal,
  RiskConfig,
} from "./types";
import { computeContext } from "./wyckoff";

/**
 * Decision + execution layer.
 *
 * Turns Wyckoff structural events into concrete, backtestable trade signals,
 * with structure-based stops and a fixed-fractional-risk position model.
 */

export const DEFAULT_RISK: RiskConfig = {
  riskPerTradePct: 1.5, // risk 1.5% of equity per trade
  maxConcurrentPositions: 1,
  feePct: 0.0006, // taker fee 0.06% per side
  slippagePct: 0.0002, // slippage 0.02% per side
};

/**
 * Build trade signals from structure points.
 *
 * - Spring / LPS / SOS  -> long entry (close of the signal bar)
 * - UTAD / SOW          -> short entry
 *
 * Stop is placed beyond the structural invalidation level (with an ATR buffer);
 * target uses a fixed R multiple. Position size derives from the configured
 * risk-per-trade and the stop distance (fixed fractional risk model).
 */
export function generateSignals(
  candles: Candle[],
  structures: StructurePoint[],
  risk: RiskConfig = DEFAULT_RISK,
  granularity = "1day"
): TradeSignal[] {
  const ctx = computeContext(candles, granularity);
  const signals: TradeSignal[] = [];
  const TARGET_R = 2.5; // reward:risk target

  for (const s of structures) {
    const i = s.index;
    const c = candles[i];
    const a = ctx.atr[i];
    const atrBuf = Number.isNaN(a) ? c.close * 0.01 : a * 0.5;

    // No look-ahead: a Wyckoff structure is only confirmed on its bar's close,
    // so the earliest realistic fill is the NEXT bar's open. If the structure
    // is the last bar (no next bar), we cannot trade it -> drop the signal.
    const entryIdx = i + 1;
    if (entryIdx >= candles.length) continue;
    const entryBar = candles[entryIdx];
    const entry = entryBar.open;

    if (s.bias === "bullish") {
      // stop below the structural low (spring low / pullback low) minus buffer
      const stop = Math.min(s.price, c.low) - atrBuf;
      const riskDist = entry - stop;
      if (riskDist <= 0) continue;
      const target = entry + riskDist * TARGET_R;
      const positionPct = positionSize(riskDist, entry, risk.riskPerTradePct);
      signals.push({
        index: entryIdx,
        time: entryBar.time,
        direction: "long",
        entry,
        stop,
        target,
        positionPct,
        riskReward: round((target - entry) / riskDist),
        reason: `${s.type} 触发做多：${s.explanation}`,
        sourceStructure: s.type,
      });
    } else {
      // stop above the structural high (utad high / breakdown) plus buffer
      const stop = Math.max(s.price, c.high) + atrBuf;
      const riskDist = stop - entry;
      if (riskDist <= 0) continue;
      const target = entry - riskDist * TARGET_R;
      const positionPct = positionSize(riskDist, entry, risk.riskPerTradePct);
      signals.push({
        index: entryIdx,
        time: entryBar.time,
        direction: "short",
        entry,
        stop,
        target,
        positionPct,
        riskReward: round((entry - target) / riskDist),
        reason: `${s.type} 触发做空：${s.explanation}`,
        sourceStructure: s.type,
      });
    }
  }

  return signals;
}

/**
 * Fixed fractional risk position sizing.
 * notionalFraction = riskPct / (stopDistance / entry)
 * Capped at 100% of equity (no leverage in this simulation).
 */
function positionSize(
  riskDist: number,
  entry: number,
  riskPerTradePct: number
): number {
  const stopPct = riskDist / entry; // fractional move to stop
  if (stopPct <= 0) return 0;
  const frac = riskPerTradePct / 100 / stopPct;
  return round(Math.min(frac, 1));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
