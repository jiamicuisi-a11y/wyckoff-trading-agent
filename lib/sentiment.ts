import type {
  SentimentSnapshot,
  SentimentSignalRead,
  SentimentTone,
  TradeSignal,
} from "./types";

/**
 * Bitget Contract Sentiment Enhancement Layer.
 *
 * Pulls three *public* USDT-futures endpoints (no API key, no trading perms):
 *   1. current funding rate
 *   2. open interest (OI)
 *   3. account long/short ratio
 *
 * and folds them into a single "current crowd positioning" snapshot that is
 * used to ENHANCE the interpretation of the latest Wyckoff signal — not to
 * drive the historical backtest. The snapshot is a *current* read, so wiring
 * it into per-candle history would introduce look-ahead bias; we deliberately
 * keep it out of the backtest path.
 *
 * Symbol mapping: spot BTCUSDT -> futures BTCUSDT (same name),
 * productType = usdt-futures.
 */

const MIX_BASE = "https://api.bitget.com/api/v2/mix/market";
const PRODUCT_TYPE = "usdt-futures";
const TIMEOUT_MS = 6000;

// Thresholds for the sentiment-resonance scoring (per task spec).
const FUNDING_HOT = 0.0001; // funding turned meaningfully positive -> longs paying
const LONG_HOT = 0.6; // crowd over-long
const LONG_COLD = 0.5; // crowd under-long

interface FundRateResp {
  code: string;
  data?: Array<{ fundingRate?: string; fundingRateInterval?: string }>;
}
interface OpenInterestResp {
  code: string;
  data?: { openInterestList?: Array<{ size?: string }> };
}
interface LongShortResp {
  code: string;
  data?: Array<{
    longAccountRatio?: string;
    shortAccountRatio?: string;
    longShortAccountRatio?: string;
    ts?: string;
  }>;
}

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as T & { code?: string };
    if (json && json.code && json.code !== "00000") return null;
    return json as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the current contract sentiment snapshot for a futures symbol.
 * Returns null only if ALL upstream calls fail; partial data is tolerated and
 * filled with sane neutral defaults so a single flaky endpoint never crashes
 * the whole analysis.
 */
export async function fetchSentiment(
  symbol: string,
  period: "5m" | "1H" | "4H" = "1H"
): Promise<SentimentSnapshot | null> {
  const sym = symbol.toUpperCase();

  const fundUrl = `${MIX_BASE}/current-fund-rate?symbol=${encodeURIComponent(
    sym
  )}&productType=${PRODUCT_TYPE}`;
  const oiUrl = `${MIX_BASE}/open-interest?symbol=${encodeURIComponent(
    sym
  )}&productType=${PRODUCT_TYPE}`;
  const lsUrl = `${MIX_BASE}/account-long-short?symbol=${encodeURIComponent(
    sym
  )}&period=${period}&productType=${PRODUCT_TYPE}`;

  const [fund, oi, ls] = await Promise.all([
    getJson<FundRateResp>(fundUrl),
    getJson<OpenInterestResp>(oiUrl),
    getJson<LongShortResp>(lsUrl),
  ]);

  // If every source failed, signal hard failure to the caller.
  if (!fund && !oi && !ls) return null;

  const fundingRate = fund?.data?.[0]?.fundingRate
    ? parseFloat(fund.data[0].fundingRate)
    : NaN;
  const fundingRateInterval = fund?.data?.[0]?.fundingRateInterval
    ? parseInt(fund.data[0].fundingRateInterval, 10)
    : null;

  const openInterest = oi?.data?.openInterestList?.[0]?.size
    ? parseFloat(oi.data.openInterestList[0].size)
    : NaN;

  // account-long-short returns an ascending series; take the most recent entry.
  const lsList = ls?.data ?? [];
  const latestLs = lsList.length > 0 ? lsList[lsList.length - 1] : undefined;
  const longAccountRatio = latestLs?.longAccountRatio
    ? parseFloat(latestLs.longAccountRatio)
    : NaN;
  const shortAccountRatio = latestLs?.shortAccountRatio
    ? parseFloat(latestLs.shortAccountRatio)
    : NaN;
  const longShortRatio = latestLs?.longShortAccountRatio
    ? parseFloat(latestLs.longShortAccountRatio)
    : Number.isFinite(longAccountRatio) && shortAccountRatio > 0
    ? longAccountRatio / shortAccountRatio
    : NaN;

  const { tone, reading } = interpret(
    fundingRate,
    longAccountRatio,
    openInterest
  );

  return {
    symbol: sym,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : 0,
    fundingRateInterval,
    openInterest: Number.isFinite(openInterest) ? openInterest : 0,
    longAccountRatio: Number.isFinite(longAccountRatio) ? longAccountRatio : 0,
    shortAccountRatio: Number.isFinite(shortAccountRatio)
      ? shortAccountRatio
      : 0,
    longShortRatio: Number.isFinite(longShortRatio) ? longShortRatio : 0,
    tone,
    reading,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Plain-language read of the standalone snapshot (crowd positioning).
 * - Funding positive + crowd over-long => crowded longs, contrarian bearish risk.
 * - Funding negative + crowd under-long => crowd fearful/short, contrarian bullish.
 */
function interpret(
  fundingRate: number,
  longRatio: number,
  oi: number
): { tone: SentimentTone; reading: string } {
  const fr = Number.isFinite(fundingRate) ? fundingRate : 0;
  const lr = Number.isFinite(longRatio) ? longRatio : 0.5;
  const frPct = (fr * 100).toFixed(4);
  const longPct = (lr * 100).toFixed(1);
  const oiTxt = Number.isFinite(oi) && oi > 0 ? `，持仓量 ${oi.toFixed(0)}` : "";

  // Over-heated longs: funding clearly positive AND crowd net long.
  if (fr > FUNDING_HOT && lr > LONG_HOT) {
    return {
      tone: "bearish",
      reading: `资金费率为正(${frPct}%)且账户多空比偏多(多头 ${longPct}%)，多头拥挤、为持仓付费${oiTxt}——情绪过热，利于做空/警惕多头追高。`,
    };
  }
  // Fearful/short crowd: funding negative AND crowd under-long.
  if (fr < 0 && lr < LONG_COLD) {
    return {
      tone: "bullish",
      reading: `资金费率为负(${frPct}%)且账户多空比偏空(多头 ${longPct}%)，空头为持仓付费、人群偏悲观${oiTxt}——逆向偏多，利于低吸/Spring 类做多。`,
    };
  }
  // Mild negative funding but crowd still long, or mixed.
  if (fr < 0) {
    return {
      tone: "neutral",
      reading: `资金费率为负(${frPct}%)，多头获得资金费补贴；账户多头占比 ${longPct}%${oiTxt}——情绪中性偏多，缺乏极端拥挤信号。`,
    };
  }
  if (fr > FUNDING_HOT) {
    return {
      tone: "neutral",
      reading: `资金费率为正(${frPct}%)，多头需付费；账户多头占比 ${longPct}%${oiTxt}——情绪中性偏热，尚未到极端拥挤。`,
    };
  }
  return {
    tone: "neutral",
    reading: `资金费率接近中性(${frPct}%)，账户多头占比 ${longPct}%${oiTxt}——合约情绪平衡，无明显共振或背离。`,
  };
}

/**
 * Score the CURRENT sentiment snapshot against the latest Wyckoff signal.
 *
 * Resonance rules (per strategy spec):
 *  - SHORT signal + funding positive & high (>0.0001) + longRatio > 0.6
 *       => "情绪共振增强" (crowd over-long, contrarian short confirmed)
 *  - LONG signal + funding < 0 + longRatio < 0.5
 *       => "情绪共振增强" (crowd fearful, contrarian long confirmed)
 *  - signal direction contradicts crowd extreme => "情绪背离，谨慎"
 *
 * Returns null if there is no signal or no snapshot. This NEVER touches the
 * backtest — it only annotates the latest live signal for display.
 */
export function scoreSentimentAgainstSignal(
  signals: TradeSignal[],
  snapshot: SentimentSnapshot | null
): SentimentSignalRead | null {
  if (!snapshot || signals.length === 0) return null;

  // Latest signal = most recent in time.
  const last = signals[signals.length - 1];
  const fr = snapshot.fundingRate;
  const lr = snapshot.longAccountRatio;
  const frPct = (fr * 100).toFixed(4);
  const longPct = (lr * 100).toFixed(1);

  if (last.direction === "short") {
    if (fr > FUNDING_HOT && lr > LONG_HOT) {
      return {
        signalIndex: last.index,
        direction: "short",
        alignment: "resonance",
        confidenceDelta: 0.15,
        label: "情绪共振增强",
        detail: `做空信号叠加资金费率转正偏高(${frPct}%)与账户多头过热(${longPct}%)：多头拥挤为做空提供逆向动能，信心提升。`,
      };
    }
    // Short but crowd fearful/short already -> contrarian risk of squeeze up.
    if (fr < 0 && lr < LONG_COLD) {
      return {
        signalIndex: last.index,
        direction: "short",
        alignment: "divergence",
        confidenceDelta: -0.12,
        label: "情绪背离，谨慎",
        detail: `做空信号但资金费率为负(${frPct}%)、账户多头偏低(${longPct}%)：人群已偏空，存在轧空风险，谨慎追空。`,
      };
    }
  }

  if (last.direction === "long") {
    if (fr < 0 && lr < LONG_COLD) {
      return {
        signalIndex: last.index,
        direction: "long",
        alignment: "resonance",
        confidenceDelta: 0.15,
        label: "情绪共振增强",
        detail: `做多信号叠加资金费率为负(${frPct}%)与账户多头偏低(${longPct}%)：人群悲观、空头付费，逆向做多得到情绪支持，信心提升。`,
      };
    }
    // Long but crowd already over-long & paying -> chasing risk.
    if (fr > FUNDING_HOT && lr > LONG_HOT) {
      return {
        signalIndex: last.index,
        direction: "long",
        alignment: "divergence",
        confidenceDelta: -0.12,
        label: "情绪背离，谨慎",
        detail: `做多信号但资金费率为正偏高(${frPct}%)、账户多头过热(${longPct}%)：多头已拥挤，追多易接盘，谨慎。`,
      };
    }
  }

  return {
    signalIndex: last.index,
    direction: last.direction,
    alignment: "neutral",
    confidenceDelta: 0,
    label: "情绪中性",
    detail: `当前合约情绪与${last.direction === "long" ? "做多" : "做空"}信号无明显共振或背离（资金费率 ${frPct}%，多头占比 ${longPct}%）。`,
  };
}
