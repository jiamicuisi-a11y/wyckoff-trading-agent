import type { Candle } from "./types";

const BITGET_BASE = "https://api.bitget.com/api/v2/spot/market/candles";

export const VALID_GRANULARITIES = [
  "1min",
  "5min",
  "15min",
  "30min",
  "1h",
  "4h",
  "6h",
  "12h",
  "1day",
  "1week",
  "1M",
] as const;

export type Granularity = (typeof VALID_GRANULARITIES)[number];

interface BitgetResponse {
  code: string;
  msg: string;
  requestTime: number;
  data: string[][];
}

/**
 * Fetch spot candles from Bitget public market API (no API key required).
 * Bitget returns rows ascending by timestamp:
 * [ts, open, high, low, close, baseVol, quoteVol, usdtVol] as strings.
 */
export async function fetchCandles(
  symbol: string,
  granularity: string,
  limit: number
): Promise<Candle[]> {
  const url = `${BITGET_BASE}?symbol=${encodeURIComponent(
    symbol
  )}&granularity=${encodeURIComponent(granularity)}&limit=${limit}`;

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Bitget HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as BitgetResponse;

  if (json.code !== "00000") {
    throw new Error(`Bitget API error ${json.code}: ${json.msg}`);
  }

  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error("Bitget returned no candle data for this symbol/granularity.");
  }

  const candles: Candle[] = json.data.map((row) => ({
    time: Math.floor(parseInt(row[0], 10) / 1000),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));

  // Ensure ascending by time (defensive)
  candles.sort((a, b) => a.time - b.time);

  return candles;
}
