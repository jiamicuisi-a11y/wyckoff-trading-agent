import type { Candle } from "./types";

/** Simple Moving Average over closes. Returns array aligned to candles (NaN until enough data). */
export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Average True Range (Wilder-style simple mean of true ranges). */
export function atr(candles: Candle[], period: number): number[] {
  const tr: number[] = new Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }
  return sma(tr, period);
}

/** Rolling mean of volume. */
export function volumeAverage(candles: Candle[], period: number): number[] {
  return sma(
    candles.map((c) => c.volume),
    period
  );
}

/** Highest high over the trailing window ending at index i (inclusive of lookback, excluding i optionally). */
export function rollingHigh(
  candles: Candle[],
  i: number,
  window: number,
  excludeCurrent = false
): number {
  const end = excludeCurrent ? i - 1 : i;
  const start = Math.max(0, end - window + 1);
  let hi = -Infinity;
  for (let k = start; k <= end; k++) hi = Math.max(hi, candles[k].high);
  return hi;
}

/** Lowest low over the trailing window ending at index i. */
export function rollingLow(
  candles: Candle[],
  i: number,
  window: number,
  excludeCurrent = false
): number {
  const end = excludeCurrent ? i - 1 : i;
  const start = Math.max(0, end - window + 1);
  let lo = Infinity;
  for (let k = start; k <= end; k++) lo = Math.min(lo, candles[k].low);
  return lo;
}

/** Standard deviation of an array (sample). */
export function stdDev(values: number[]): number {
  const valid = values.filter((v) => !Number.isNaN(v));
  if (valid.length < 2) return 0;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance =
    valid.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (valid.length - 1);
  return Math.sqrt(variance);
}
