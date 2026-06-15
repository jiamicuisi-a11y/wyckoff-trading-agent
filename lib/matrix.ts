import type { MatrixRow, RiskConfig } from "./types";
import { fetchCandles } from "./bitget";
import { analyzeWyckoff } from "./wyckoff";
import { generateSignals, DEFAULT_RISK } from "./strategy";
import { runBacktest } from "./backtest";

/**
 * Multi-symbol x multi-timeframe backtest matrix.
 *
 * Runs the same deterministic Wyckoff strategy across several markets and
 * timeframes to demonstrate the edge is not over-fit to a single series.
 * Bitget public API is rate-limited, so requests are issued serially with a
 * small delay between them.
 */

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const DEFAULT_GRANS = ["1day", "4h"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBacktestMatrix(
  symbols: string[] = DEFAULT_SYMBOLS,
  granularities: string[] = DEFAULT_GRANS,
  limit = 300,
  risk: RiskConfig = DEFAULT_RISK
): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];

  for (const symbol of symbols) {
    for (const granularity of granularities) {
      try {
        const candles = await fetchCandles(symbol, granularity, limit);
        if (candles.length < 60) {
          rows.push(emptyRow(symbol, granularity, "K线数据不足"));
        } else {
          const wyckoff = analyzeWyckoff(candles);
          const signals = generateSignals(candles, wyckoff.structurePoints, risk);
          const bt = runBacktest(candles, signals, risk);
          rows.push({
            symbol,
            granularity,
            totalReturnPct: bt.totalReturnPct,
            buyHoldReturnPct: bt.buyHoldReturnPct,
            winRate: bt.winRate,
            profitFactor: bt.profitFactor,
            maxDrawdownPct: bt.maxDrawdownPct,
            sharpe: bt.sharpe,
            tradeCount: bt.tradeCount,
          });
        }
      } catch (err: any) {
        rows.push(emptyRow(symbol, granularity, err?.message || "拉取失败"));
      }
      // gentle pacing to respect Bitget rate limits
      await sleep(250);
    }
  }

  return rows;
}

function emptyRow(symbol: string, granularity: string, error: string): MatrixRow {
  return {
    symbol,
    granularity,
    totalReturnPct: 0,
    buyHoldReturnPct: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    sharpe: 0,
    tradeCount: 0,
    error,
  };
}
