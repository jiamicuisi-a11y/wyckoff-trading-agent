import { NextResponse } from "next/server";
import { runBacktestMatrix } from "../../../lib/matrix";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const GRANS = ["1day", "4h"];

/**
 * GET /api/matrix
 * Runs the strategy across BTC/ETH/SOL x 1day/4h and returns a 6-row matrix of
 * headline backtest metrics, proving the edge is not BTC-specific over-fitting.
 */
export async function GET() {
  try {
    const rows = await runBacktestMatrix(SYMBOLS, GRANS, 300);
    return NextResponse.json({
      symbols: SYMBOLS,
      granularities: GRANS,
      rows,
      generatedAt: new Date().toISOString(),
      note: "成本已计入（taker 0.06% + 滑点 0.02%，单边约 0.08%），入场价采用信号确认后下一根开盘价，无前视偏差。",
    });
  } catch (err: any) {
    const msg = err?.message || "未知错误";
    return NextResponse.json({ error: `矩阵回测失败：${msg}` }, { status: 502 });
  }
}
