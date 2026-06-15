import { NextResponse } from "next/server";
import { fetchCandles, VALID_GRANULARITIES } from "../../../lib/bitget";
import { analyzeWyckoff } from "../../../lib/wyckoff";
import { generateSignals, DEFAULT_RISK } from "../../../lib/strategy";
import { runBacktest } from "../../../lib/backtest";
import {
  fetchSentiment,
  scoreSentimentAgainstSignal,
} from "../../../lib/sentiment";
import { SUPPORTED_SYMBOLS, isSupportedSymbol } from "../../../lib/symbols";
import type { AnalyzeResponse } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_SYMBOLS: string[] = [...SUPPORTED_SYMBOLS];

export async function GET() {
  return NextResponse.json({
    usage: "POST /api/analyze with JSON body { symbol, granularity, limit }",
    example: { symbol: "BTCUSDT", granularity: "1day", limit: 300 },
    validSymbols: ALLOWED_SYMBOLS,
    validGranularities: VALID_GRANULARITIES,
    note: "数据来自 Bitget 公开现货行情，仅用于研究/教育，非投资建议。",
  });
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const symbol = String(body.symbol || "BTCUSDT").toUpperCase();
    const granularity = String(body.granularity || "1day");
    let limit = Number(body.limit ?? 300);

    if (!isSupportedSymbol(symbol)) {
      return NextResponse.json(
        { error: `不支持的币种：${symbol}，可选 ${ALLOWED_SYMBOLS.join(", ")}` },
        { status: 400 }
      );
    }
    if (!VALID_GRANULARITIES.includes(granularity as any)) {
      return NextResponse.json(
        { error: `不支持的周期：${granularity}` },
        { status: 400 }
      );
    }
    if (!Number.isFinite(limit) || limit < 50) limit = 300;
    if (limit > 300) limit = 300;

    const candles = await fetchCandles(symbol, granularity, limit);
    if (candles.length < 60) {
      return NextResponse.json(
        { error: "K线数据不足，无法进行威科夫分析（需至少 60 根）。" },
        { status: 422 }
      );
    }

    const wyckoff = analyzeWyckoff(candles, granularity);
    const signals = generateSignals(
      candles,
      wyckoff.structurePoints,
      DEFAULT_RISK,
      granularity
    );
    const backtest = runBacktest(candles, signals, DEFAULT_RISK);

    // Sentiment enhancement layer: pull the CURRENT Bitget contract sentiment
    // snapshot (funding / OI / long-short ratio) and read it against the latest
    // signal. This is snapshot-only — it never touches the historical backtest,
    // so no look-ahead bias is introduced. Fetch is fault-tolerant: if Bitget
    // contract endpoints fail, sentiment is null and the analysis still returns.
    const sentiment = await fetchSentiment(symbol, "1H");
    const sentimentRead = scoreSentimentAgainstSignal(signals, sentiment);

    const payload: AnalyzeResponse & { currentPhase: string } = {
      symbol,
      granularity,
      candles,
      phases: wyckoff.phases,
      structurePoints: wyckoff.structurePoints,
      signals,
      backtest,
      riskConfig: DEFAULT_RISK,
      sentiment,
      sentimentRead,
      currentPhase: wyckoff.currentPhase,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (err: any) {
    const msg = err?.message || "未知错误";
    return NextResponse.json(
      { error: `分析失败：${msg}` },
      { status: 502 }
    );
  }
}
