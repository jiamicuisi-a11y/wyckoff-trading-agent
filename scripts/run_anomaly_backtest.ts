import { fetchCandles } from "../lib/bitget";
import { generateAnomalySignals, DEFAULT_ANOMALY } from "../lib/anomaly";
import { runBacktest } from "../lib/backtest";
import { DEFAULT_RISK } from "../lib/strategy";

/**
 * A档异动策略回测脚本。
 * 用法: npx tsx scripts/run_anomaly_backtest.ts [SYMBOL] [GRAN] [LIMIT]
 *       npx tsx scripts/run_anomaly_backtest.ts            // 跑多币种矩阵
 */

async function one(symbol: string, gran: string, limit: number) {
  const candles = await fetchCandles(symbol, gran, limit);
  const { signals, latestAlerts } = generateAnomalySignals(
    candles,
    gran,
    DEFAULT_ANOMALY,
    DEFAULT_RISK
  );
  const bt = runBacktest(candles, signals, DEFAULT_RISK);
  return { candles, signals, latestAlerts, bt };
}

async function main() {
  const [, , symArg, granArg, limArg] = process.argv;

  if (symArg) {
    const symbol = symArg.toUpperCase();
    const gran = granArg || "1day";
    const limit = Number(limArg || 300);
    const { signals, latestAlerts, bt } = await one(symbol, gran, limit);

    console.log(`\n=== A档异动回测 ${symbol} ${gran} ${limit}根 ===`);
    console.log(`信号数 ${signals.length}`);
    console.log(
      `交易 ${bt.tradeCount} 笔  胜 ${bt.wins} 负 ${bt.losses}  胜率 ${bt.winRate.toFixed(1)}%`
    );
    console.log(
      `总收益 ${bt.totalReturnPct.toFixed(2)}% vs B&H ${bt.buyHoldReturnPct.toFixed(2)}%`
    );
    console.log(
      `盈亏比 ${bt.profitFactor.toFixed(2)}  最大回撤 ${bt.maxDrawdownPct.toFixed(2)}%  Sharpe ${bt.sharpe.toFixed(2)}`
    );
    console.log(`\n最近异动标签（最多5条）:`);
    for (const a of latestAlerts) {
      console.log(`  idx${a.index} 分${a.score} [${a.label}]`);
    }
    console.log(`\n每笔交易方向/出场:`);
    for (const t of bt.trades) {
      console.log(
        `  ${t.direction} 进${t.entryPrice.toFixed(2)} 出${t.exitPrice.toFixed(2)} ${t.outcome} ${t.pnlPct.toFixed(2)}% [${t.exitReason}]`
      );
    }
    return;
  }

  // 多币种矩阵
  const symbols = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
  ];
  console.log(`\n=== A档异动策略 · 多币种日线矩阵（300根）===`);
  console.log(`币种      信号  交易  胜率    策略收益   B&H收益   盈亏比`);
  let totRet = 0;
  let n = 0;
  for (const s of symbols) {
    try {
      const { signals, bt } = await one(s, "1day", 300);
      console.log(
        `${s.padEnd(9)} ${String(signals.length).padStart(3)}  ${String(bt.tradeCount).padStart(4)}  ${bt.winRate.toFixed(0).padStart(4)}%  ${bt.totalReturnPct.toFixed(2).padStart(8)}%  ${bt.buyHoldReturnPct.toFixed(2).padStart(8)}%  ${bt.profitFactor.toFixed(2).padStart(5)}`
      );
      totRet += bt.totalReturnPct;
      n++;
    } catch (e: any) {
      console.log(`${s.padEnd(9)} 失败: ${e?.message}`);
    }
  }
  if (n > 0) console.log(`\n平均策略收益: ${(totRet / n).toFixed(2)}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
