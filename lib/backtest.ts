import type {
  Candle,
  TradeSignal,
  ClosedTrade,
  EquityPoint,
  BacktestResult,
  RiskConfig,
} from "./types";
import { DEFAULT_RISK } from "./strategy";

/**
 * Event-driven backtest engine.
 *
 * Walks the candle series bar by bar. When a signal fires and no position is
 * open (maxConcurrentPositions = 1), it opens a position. On each subsequent
 * bar it checks intrabar whether stop or target was hit and closes the trade,
 * realising PnL onto the equity curve. A Buy & Hold benchmark is tracked in
 * parallel for comparison.
 */
export function runBacktest(
  candles: Candle[],
  signals: TradeSignal[],
  risk: RiskConfig = DEFAULT_RISK
): BacktestResult {
  const signalByIndex = new Map<number, TradeSignal>();
  for (const s of signals) {
    // keep the first signal at a given bar
    if (!signalByIndex.has(s.index)) signalByIndex.set(s.index, s);
  }

  let equity = 1; // normalized equity, start at 1.0
  const trades: ClosedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const periodReturns: number[] = [];

  interface OpenPos {
    signal: TradeSignal;
    entryIndex: number;
  }
  let open: OpenPos | null = null;

  const firstClose = candles[0].close;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevEquity = equity;

    // Manage open position: check stop/target intrabar (stop checked first = conservative)
    if (open) {
      const sig = open.signal;
      let exitPrice: number | null = null;
      let outcome: "win" | "loss" | null = null;

      if (sig.direction === "long") {
        if (c.low <= sig.stop) {
          exitPrice = sig.stop;
          outcome = "loss";
        } else if (c.high >= sig.target) {
          exitPrice = sig.target;
          outcome = "win";
        }
      } else {
        if (c.high >= sig.stop) {
          exitPrice = sig.stop;
          outcome = "loss";
        } else if (c.low <= sig.target) {
          exitPrice = sig.target;
          outcome = "win";
        }
      }

      if (exitPrice !== null && outcome !== null) {
        const dir = sig.direction === "long" ? 1 : -1;
        const priceRet = (dir * (exitPrice - sig.entry)) / sig.entry;
        const tradeRet = priceRet * sig.positionPct; // scaled by position size
        equity *= 1 + tradeRet;
        const riskDist = Math.abs(sig.entry - sig.stop);
        const rMultiple = riskDist > 0 ? (dir * (exitPrice - sig.entry)) / riskDist : 0;
        trades.push({
          direction: sig.direction,
          entryIndex: open.entryIndex,
          entryTime: candles[open.entryIndex].time,
          entryPrice: sig.entry,
          exitIndex: i,
          exitTime: c.time,
          exitPrice,
          stop: sig.stop,
          target: sig.target,
          outcome,
          pnlPct: round(tradeRet * 100),
          rMultiple: round(rMultiple),
          reason: sig.reason,
        });
        open = null;
      }
    }

    // Open a new position from a signal on this bar (if flat)
    if (!open) {
      const sig = signalByIndex.get(i);
      if (sig) {
        open = { signal: sig, entryIndex: i };
      }
    }

    const benchmark = c.close / firstClose;
    equityCurve.push({ time: c.time, equity: round4(equity), benchmark: round4(benchmark) });
    periodReturns.push(prevEquity > 0 ? equity / prevEquity - 1 : 0);
  }

  // Force-close any position still open at the last bar (mark to close)
  if (open) {
    const sig = open.signal;
    const last = candles[candles.length - 1];
    const dir = sig.direction === "long" ? 1 : -1;
    const priceRet = (dir * (last.close - sig.entry)) / sig.entry;
    const tradeRet = priceRet * sig.positionPct;
    equity *= 1 + tradeRet;
    const riskDist = Math.abs(sig.entry - sig.stop);
    const rMultiple = riskDist > 0 ? (dir * (last.close - sig.entry)) / riskDist : 0;
    trades.push({
      direction: sig.direction,
      entryIndex: open.entryIndex,
      entryTime: candles[open.entryIndex].time,
      entryPrice: sig.entry,
      exitIndex: candles.length - 1,
      exitTime: last.time,
      exitPrice: last.close,
      stop: sig.stop,
      target: sig.target,
      outcome: tradeRet >= 0 ? "win" : "loss",
      pnlPct: round(tradeRet * 100),
      rMultiple: round(rMultiple),
      reason: sig.reason + "（回测末尾强制平仓）",
    });
    const lastPt = equityCurve[equityCurve.length - 1];
    if (lastPt) lastPt.equity = round4(equity);
  }

  return summarize(candles, trades, equityCurve, periodReturns, equity);
}

function summarize(
  candles: Candle[],
  trades: ClosedTrade[],
  equityCurve: EquityPoint[],
  periodReturns: number[],
  finalEquity: number
): BacktestResult {
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const losses = trades.filter((t) => t.pnlPct <= 0).length;
  const grossWin = trades
    .filter((t) => t.pnlPct > 0)
    .reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0)
  );

  // Max drawdown on the equity curve
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  // Simplified Sharpe: mean/std of per-bar returns * sqrt(annualization)
  const mean =
    periodReturns.reduce((a, b) => a + b, 0) / Math.max(periodReturns.length, 1);
  const variance =
    periodReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    Math.max(periodReturns.length - 1, 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  const buyHold =
    (candles[candles.length - 1].close - candles[0].close) / candles[0].close;

  return {
    totalReturnPct: round((finalEquity - 1) * 100),
    buyHoldReturnPct: round(buyHold * 100),
    winRate: trades.length ? round((wins / trades.length) * 100) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? 99 : 0,
    maxDrawdownPct: round(maxDd * 100),
    sharpe: round(sharpe),
    tradeCount: trades.length,
    wins,
    losses,
    trades,
    equityCurve,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
