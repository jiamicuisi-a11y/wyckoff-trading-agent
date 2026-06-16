import type { MatrixRow, RiskConfig } from "./types";
import { fetchCandles } from "./bitget";
import { analyzeWyckoff } from "./wyckoff";
import { generateSignals, DEFAULT_RISK } from "./strategy";
import { generateAnomalySignals, DEFAULT_ANOMALY } from "./anomaly";
import { runBacktest } from "./backtest";
import { SUPPORTED_SYMBOLS } from "./symbols";

/**
 * 多币种 × 多周期回测矩阵。
 *
 * 同一套确定性威科夫规则跨多个主流币种与周期运行，证明策略不是对单一币种过拟合。
 * Bitget 公开 API 有限流，请求串行发出并在每次之间留间隔。10+ 币种跑多周期会比较慢，
 * 因此默认只跑日线那一档（DEFAULT_GRANS = ["1day"]）以控制耗时；前端/接口可显式传入更多周期。
 */

const DEFAULT_SYMBOLS = [...SUPPORTED_SYMBOLS];
const DEFAULT_GRANS = ["1day"]; // 默认只跑日线，减少多币种矩阵耗时与限流风险

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBacktestMatrix(
  symbols: string[] = DEFAULT_SYMBOLS,
  granularities: string[] = DEFAULT_GRANS,
  limit = 300,
  risk: RiskConfig = DEFAULT_RISK,
  strategy = "wyckoff"
): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];

  for (const symbol of symbols) {
    for (const granularity of granularities) {
      try {
        const candles = await fetchCandles(symbol, granularity, limit);
        if (candles.length < 60) {
          rows.push(emptyRow(symbol, granularity, "K线数据不足"));
        } else {
          let signals;
          if (strategy === "anomaly") {
            signals = generateAnomalySignals(
              candles,
              granularity,
              DEFAULT_ANOMALY,
              risk
            ).signals;
          } else {
            const wyckoff = analyzeWyckoff(candles, granularity);
            signals = generateSignals(
              candles,
              wyckoff.structurePoints,
              risk,
              granularity
            );
          }
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
      // 适度限速，尊重 Bitget 限流（10+ 币种串行，间隔放大一些）
      await sleep(300);
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
