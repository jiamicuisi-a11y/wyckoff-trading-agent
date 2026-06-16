import { NextResponse } from "next/server";
import {
  scanTickers,
  DEFAULT_SCAN,
  type TickerRaw,
  type OiSnapshot,
} from "../../../lib/scanner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICKERS_URL =
  "https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures";
const TIMEOUT_MS = 8000;

/**
 * POST /api/scan
 *
 * A档实时异动扫描：拉取 Bitget 全市场永续合约 tickers（一次返回 600+），
 * 跑多因子异动打分，返回当下「正在异动」的 top5。
 *
 * OI 变化率需要两次扫描间隔才能算出，因此采用「无状态 + 客户端持有快照」模式：
 * - 请求体可带上一次扫描返回的 oiSnapshot；
 * - 本次扫描用它算 OI 变化率，并返回新的 oiSnapshot 供下次使用。
 * 首次扫描没有快照，OI 异动分为 0（属正常，刷新一次后即生效）。
 */
export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const prevOi: OiSnapshot =
      body && typeof body.oiSnapshot === "object" && body.oiSnapshot
        ? body.oiSnapshot
        : {};

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let json: any;
    try {
      const res = await fetch(TICKERS_URL, {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Bitget HTTP ${res.status}` },
          { status: 502 }
        );
      }
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (!json || json.code !== "00000" || !Array.isArray(json.data)) {
      return NextResponse.json(
        { error: `Bitget 返回异常：${json?.msg || "无数据"}` },
        { status: 502 }
      );
    }

    const tickers = json.data as TickerRaw[];
    const result = scanTickers(tickers, prevOi, DEFAULT_SCAN);

    return NextResponse.json({
      ...result,
      config: DEFAULT_SCAN,
      note: "数据来自 Bitget 公开永续合约行情，实时快照。OI 变化率需连续两次扫描后生效。仅供研究，非投资建议。",
    });
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "请求超时" : err?.message || "未知错误";
    return NextResponse.json({ error: `扫描失败：${msg}` }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({
    usage: "POST /api/scan with optional JSON body { oiSnapshot }",
    note: "返回全市场永续合约的实时异动 top5。",
  });
}
