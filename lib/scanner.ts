import type { SignalDirection } from "./types";

/**
 * A档 · 实时异动扫描器（Anomaly Scanner / Realtime）
 *
 * 与「策略回测」彻底分开：A档的灵魂是**当下的实时合约数据**——OI 在涨没涨、
 * 资金费率正不正常、价格短时异动、成交额突增、多空比偏向。这些都是「此刻」
 * 的快照，历史 K 线里没有，所以 A档不做回测，只做实时扫描出榜。
 *
 * 数据来源：Bitget 公开合约接口 `mix/market/tickers`（免 key），一次返回全市场
 * 600+ 永续合约，每条自带 holdingAmount(OI) / fundingRate / change24h /
 * usdtVolume / bid-ask 盘口。OI 的「变化率」靠对比上一次扫描的快照算出。
 *
 * 打分维度（对齐原版 A档框架）：
 *   - OI 异动      权重 0.30（需两次扫描间隔才有变化率；首扫为 0）
 *   - 主动买卖盘    权重 0.25（用盘口 bid/ask 失衡 + 价格方向近似）
 *   - 价格异动      权重 0.20（24h / UTC 涨跌幅）
 *   - 成交额异动    权重 0.15（成交额相对全市场分位）
 *   - 资金费率异动  权重 0.10（极端费率）
 *
 * 硬过滤（原版口径）：综合分≥35、OI≥100万U、正向/负向标签判方向、
 * 同币同向 30 分钟冷却、一次最多出 5 条。
 */

export interface TickerRaw {
  symbol: string;
  lastPr: string;
  bidSz: string;
  askSz: string;
  change24h: string;
  changeUtc24h: string;
  usdtVolume: string;
  fundingRate: string;
  holdingAmount: string; // 当前 OI（base 计价）
  markPrice: string;
}

/** OI 快照：symbol -> { oi, ts }，用于算两次扫描间的 OI 变化率。 */
export interface OiSnapshot {
  [symbol: string]: { oi: number; ts: number };
}

export type AnomalyTag =
  | "多头共振"
  | "大户领先做多"
  | "主动买领先多"
  | "大户领先做空"
  | "主动买领先空"
  | "无明显异动";

/** 正向标签（允许做多）。 */
const POSITIVE_TAGS: AnomalyTag[] = ["多头共振", "大户领先做多", "主动买领先多"];
/** 负向标签（偏做空）。 */
const NEGATIVE_TAGS: AnomalyTag[] = ["大户领先做空", "主动买领先空"];

export interface AnomalyFactorScores {
  oi: number; // OI 异动分 0..100
  activeBuy: number; // 主动买卖盘失衡分 0..100
  price: number; // 价格异动分 0..100
  volume: number; // 成交额异动分 0..100
  funding: number; // 资金费率极端分 0..100
}

export interface AnomalyHit {
  symbol: string;
  score: number; // 综合分 0..100
  direction: SignalDirection;
  tag: AnomalyTag;
  factors: AnomalyFactorScores;
  // 展示用原始值
  lastPrice: number;
  oiUsd: number; // 当前 OI 折美元（OI × 价格）
  oiChangePct: number | null; // 相对上次扫描的 OI 变化率（首扫为 null）
  change24hPct: number;
  fundingRate: number;
  volumeUsd: number;
  bidAskImbalance: number; // (bid-ask)/(bid+ask)，正=买压
}

export interface ScanConfig {
  minScore: number;
  minOiUsd: number;
  maxHits: number;
  cooldownMinutes: number;
}

export const DEFAULT_SCAN: ScanConfig = {
  minScore: 35,
  minOiUsd: 1_000_000,
  maxHits: 5,
  cooldownMinutes: 30,
};

const WEIGHTS = {
  oi: 0.3,
  activeBuy: 0.25,
  price: 0.2,
  volume: 0.15,
  funding: 0.1,
} as const;

const num = (s: string | undefined): number => {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
};

/** OI 异动分：相对上次快照的变化率。首扫无基准 -> 0。 */
function oiFactor(oiChangePct: number | null): number {
  if (oiChangePct === null) return 0;
  // 1% 变化 -> 20 分，5% 封顶 100
  return Math.min(Math.abs(oiChangePct) * 20, 100);
}

/** 主动买卖盘失衡分：盘口 bid/ask 量失衡的绝对强度。 */
function activeBuyFactor(imbalance: number): number {
  return Math.min(Math.abs(imbalance) * 100, 100);
}

/** 价格异动分：24h 涨跌幅绝对值放大。 */
function priceFactor(change24hPct: number): number {
  return Math.min(Math.abs(change24hPct) * 4, 100);
}

/** 成交额异动分：对数刻度，1万U起步，10亿U封顶。 */
function volumeFactor(volumeUsd: number): number {
  if (volumeUsd <= 10_000) return 0;
  const score = ((Math.log10(volumeUsd) - 4) / (9 - 4)) * 100;
  return Math.min(Math.max(score, 0), 100);
}

/** 资金费率异动分：极端费率（绝对值）。0.05% 起算，0.3% 封顶。 */
function fundingFactor(fundingRate: number): number {
  const absPct = Math.abs(fundingRate) * 100;
  if (absPct < 0.05) return 0;
  return Math.min(((absPct - 0.05) / (0.3 - 0.05)) * 100, 100);
}

/**
 * 标签 + 方向判定：综合 OI 方向、盘口买卖压、价格方向。
 * - OI 上升 + 价格涨 + 买压 -> 多头共振（最强做多）
 * - OI 上升 + 买压          -> 大户领先做多
 * - 买压明显               -> 主动买领先多
 * - OI 上升 + 价格跌 / 卖压 -> 大户领先做空 / 主动买领先空
 */
function classify(
  oiChangePct: number | null,
  change24hPct: number,
  imbalance: number
): { tag: AnomalyTag; direction: SignalDirection } {
  const oiUp = oiChangePct !== null && oiChangePct > 0.5; // OI 升超 0.5%
  const priceUp = change24hPct > 0;
  const buyPressure = imbalance > 0.1; // 买盘量明显大于卖盘
  const sellPressure = imbalance < -0.1;

  // 做多侧
  if (oiUp && priceUp && buyPressure) return { tag: "多头共振", direction: "long" };
  if (oiUp && (priceUp || buyPressure)) return { tag: "大户领先做多", direction: "long" };
  if (buyPressure && priceUp) return { tag: "主动买领先多", direction: "long" };

  // 做空侧
  if (oiUp && !priceUp && sellPressure) return { tag: "大户领先做空", direction: "short" };
  if (sellPressure && !priceUp) return { tag: "主动买领先空", direction: "short" };

  // 兜底：按价格方向给最弱标签
  if (priceUp && buyPressure) return { tag: "主动买领先多", direction: "long" };
  if (!priceUp && sellPressure) return { tag: "主动买领先空", direction: "short" };

  return { tag: "无明显异动", direction: priceUp ? "long" : "short" };
}

export function scoreFactors(f: AnomalyFactorScores): number {
  const s =
    f.oi * WEIGHTS.oi +
    f.activeBuy * WEIGHTS.activeBuy +
    f.price * WEIGHTS.price +
    f.volume * WEIGHTS.volume +
    f.funding * WEIGHTS.funding;
  return Math.round(Math.min(s, 100));
}

export interface ScanResult {
  hits: AnomalyHit[];
  /** 本次扫描的 OI 快照，调用方应持久化，下次扫描传回来算变化率。 */
  oiSnapshot: OiSnapshot;
  scannedCount: number; // 全市场扫描的合约数
  scannedAt: string;
}

/**
 * 对全市场 tickers 跑一次实时异动扫描。
 *
 * @param tickers   Bitget mix/market/tickers 的 data 数组
 * @param prevOi    上次扫描的 OI 快照（用于算变化率，首扫传 {}）
 * @param cfg       扫描配置
 */
export function scanTickers(
  tickers: TickerRaw[],
  prevOi: OiSnapshot,
  cfg: ScanConfig = DEFAULT_SCAN
): ScanResult {
  const now = Date.now();
  const oiSnapshot: OiSnapshot = {};
  const candidates: AnomalyHit[] = [];

  for (const t of tickers) {
    const symbol = t.symbol;
    const lastPrice = num(t.lastPr);
    const oiBase = num(t.holdingAmount);
    const oiUsd = oiBase * lastPrice;

    // 记录本次 OI 快照（无论是否命中，都要存，供下次对比）
    oiSnapshot[symbol] = { oi: oiBase, ts: now };

    // 硬过滤 1：OI 折美元 ≥ 阈值
    if (oiUsd < cfg.minOiUsd) continue;

    // OI 变化率（相对上次快照）
    const prev = prevOi[symbol];
    const oiChangePct =
      prev && prev.oi > 0 ? ((oiBase - prev.oi) / prev.oi) * 100 : null;

    const change24hPct = num(t.changeUtc24h) * 100;
    const fundingRate = num(t.fundingRate);
    const volumeUsd = num(t.usdtVolume);
    const bidSz = num(t.bidSz);
    const askSz = num(t.askSz);
    const imbalance =
      bidSz + askSz > 0 ? (bidSz - askSz) / (bidSz + askSz) : 0;

    const factors: AnomalyFactorScores = {
      oi: oiFactor(oiChangePct),
      activeBuy: activeBuyFactor(imbalance),
      price: priceFactor(change24hPct),
      volume: volumeFactor(volumeUsd),
      funding: fundingFactor(fundingRate),
    };
    const score = scoreFactors(factors);

    // 硬过滤 2：综合分 ≥ 阈值
    if (score < cfg.minScore) continue;

    const { tag, direction } = classify(oiChangePct, change24hPct, imbalance);

    // 硬过滤 3：必须落在正向或负向标签（无明显异动直接丢）
    if (!POSITIVE_TAGS.includes(tag) && !NEGATIVE_TAGS.includes(tag)) continue;

    candidates.push({
      symbol,
      score,
      direction,
      tag,
      factors,
      lastPrice,
      oiUsd,
      oiChangePct: oiChangePct === null ? null : Math.round(oiChangePct * 100) / 100,
      change24hPct: Math.round(change24hPct * 100) / 100,
      fundingRate,
      volumeUsd,
      bidAskImbalance: Math.round(imbalance * 1000) / 1000,
    });
  }

  // 按综合分降序，取前 maxHits
  candidates.sort((a, b) => b.score - a.score);
  const hits = candidates.slice(0, cfg.maxHits);

  return {
    hits,
    oiSnapshot,
    scannedCount: tickers.length,
    scannedAt: new Date(now).toISOString(),
  };
}

export { POSITIVE_TAGS, NEGATIVE_TAGS };
