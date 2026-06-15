import type {
  Candle,
  TradeSignal,
  ClosedTrade,
  EquityPoint,
  BacktestResult,
  RiskConfig,
  ExitReason,
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

  // Per-side transaction cost (taker fee + slippage), applied on both entry and exit.
  const costPerSide =
    (risk.feePct ?? 0.0006) + (risk.slippagePct ?? 0.0002); // default ~0.08%/side

  let equity = 1; // normalized equity, start at 1.0
  const trades: ClosedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const periodReturns: number[] = [];

  interface OpenPos {
    signal: TradeSignal;
    entryIndex: number;
    trailStop: number; // ratcheting stop for structure-failure exit
    extreme: number; // best favorable close seen since entry
  }
  let open: OpenPos | null = null;

  const firstClose = candles[0].close;

  // Net trade return on equity, including round-trip cost, scaled by position size.
  const netTradeRet = (
    sig: TradeSignal,
    exitPrice: number
  ): number => {
    const dir = sig.direction === "long" ? 1 : -1;
    const priceRet = (dir * (exitPrice - sig.entry)) / sig.entry;
    const gross = priceRet * sig.positionPct;
    const cost = sig.positionPct * costPerSide * 2; // entry + exit
    return gross - cost;
  };

  const pushTrade = (
    sig: TradeSignal,
    entryIndex: number,
    exitIndex: number,
    exitTime: number,
    exitPrice: number,
    exitReason: ExitReason
  ) => {
    const dir = sig.direction === "long" ? 1 : -1;
    const tradeRet = netTradeRet(sig, exitPrice);
    equity *= 1 + tradeRet;
    const riskDist = Math.abs(sig.entry - sig.stop);
    const rMultiple = riskDist > 0 ? (dir * (exitPrice - sig.entry)) / riskDist : 0;
    trades.push({
      direction: sig.direction,
      entryIndex,
      entryTime: candles[entryIndex].time,
      entryPrice: sig.entry,
      exitIndex,
      exitTime,
      exitPrice,
      stop: sig.stop,
      target: sig.target,
      outcome: tradeRet >= 0 ? "win" : "loss",
      pnlPct: round(tradeRet * 100),
      rMultiple: round(rMultiple),
      reason: sig.reason,
      exitReason,
    });
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevEquity = equity;

    // Manage open position: check hard stop/target intrabar (stop first = conservative),
    // then a ratcheting trailing stop on close (structure-failure / give-back exit).
    if (open) {
      const sig = open.signal;
      const riskDist = Math.abs(sig.entry - sig.stop);
      let exitPrice: number | null = null;
      let exitReason: ExitReason | null = null;

      if (sig.direction === "long") {
        if (c.low <= sig.stop) {
          exitPrice = sig.stop;
          exitReason = "止损";
        } else if (c.high >= sig.target) {
          exitPrice = sig.target;
          exitReason = "止盈";
        } else {
          // ratchet the trailing stop up as price makes higher closes
          open.extreme = Math.max(open.extreme, c.close);
          const candidate = open.extreme - riskDist; // trail one R behind the high
          if (candidate > open.trailStop) open.trailStop = candidate;
          // structure failure: only fires once the trail has locked in profit
          // (i.e. ratcheted strictly above the original stop) and close breaks it
          if (open.trailStop > sig.stop && c.close < open.trailStop) {
            exitPrice = c.close;
            exitReason = "结构失效";
          }
        }
      } else {
        if (c.high >= sig.stop) {
          exitPrice = sig.stop;
          exitReason = "止损";
        } else if (c.low <= sig.target) {
          exitPrice = sig.target;
          exitReason = "止盈";
        } else {
          open.extreme = Math.min(open.extreme, c.close);
          const candidate = open.extreme + riskDist;
          if (candidate < open.trailStop) open.trailStop = candidate;
          if (open.trailStop < sig.stop && c.close > open.trailStop) {
            exitPrice = c.close;
            exitReason = "结构失效";
          }
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        pushTrade(sig, open.entryIndex, i, c.time, exitPrice, exitReason);
        open = null;
      }
    }

    // Open a new position from a signal on this bar (if flat)
    if (!open) {
      const sig = signalByIndex.get(i);
      if (sig) {
        open = {
          signal: sig,
          entryIndex: i,
          trailStop: sig.stop,
          extreme: sig.entry,
        };
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
    pushTrade(sig, open.entryIndex, candles.length - 1, last.time, last.close, "末尾平仓");
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
