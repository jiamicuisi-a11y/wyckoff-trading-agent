/**
 * 支持的主流币种（已逐一用 Bitget 现货公开行情 API 验证可拉到 1day 数据）。
 * 单一来源，前端选择器、analyze 校验、matrix 矩阵共用，避免各处写死不一致。
 */
export const SUPPORTED_SYMBOLS = [
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
] as const;

export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export function isSupportedSymbol(symbol: string): boolean {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(symbol);
}
