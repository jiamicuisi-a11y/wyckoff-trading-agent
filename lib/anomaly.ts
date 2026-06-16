import type { Candle, TradeSignal, RiskConfig } from "./types";
import { DEFAULT_RISK } from "./strategy";

/**
 * A档 · 异动扫描策略（Anomaly Scanner）
 *
 * 核心逻辑：多因子异动打分 + 正向标签过滤 + 流动性过滤 + 去重冷却。
 *
 * 与威科夫策略的区别：
 * - 威科夫是结构驱动（吸筹/拉升/派发/下跌 + Spring/SOS/UTAD...）。
 * - A档是异动驱动：在任意一根 K 线上，用「持仓代理 / 主动买盘 / 价格动量 /
 *   放量」四个因子合成一个异动综合分，分数够高且方向明确才触发。
 *
 * 硬过滤（原版口径，找回的已确认部分 + 合理默认补全）：
 * | 综合分        | ≥ 35                          |
 * | 流动性(成交额) | ≥ 阈值（按价格×量近似，过滤僵尸盘） |
 * | 结构标签      | 必须属于正向标签列表             |
 * | 冷却时间      | 同方向 30 分钟内不重复（按周期换算成根数） |
 * | 最大返回      | 实时扫描一次最多 5 条             |
 *
 * 无前视偏差：每根 K 线只用截至当根的历史数据打分；信号在当根收盘确认，
 * 最早只能在「下一根开盘」成交，与威科夫策略保持一致的撮合口径。
 */

export interface AnomalyFactors {
  oiChange: number; // 持仓异动（用成交量动能代理）
  activeBuy: number; // 主动买盘领先
  priceMove: number; // 价格异动
  volumeSurge: number; // 放量异动
}

export type AnomalyLabel =
  | "持仓异动"
  | "主动买领先"
  | "价格异动"
  | "放量异动"
  | "无明显异动";

/** 正向标签列表：只有落在这四类、且方向明确的异动才可执行。 */
const POSITIVE_LABELS: AnomalyLabel[] = [
  "持仓异动",
  "主动买领先",
  "价格异动",
  "放量异动",
];

const WEIGHTS = {
  oiChange: 0.35,
  activeBuy: 0.3,
  priceMove: 0.2,
  volumeSurge: 0.15,
} as const;

export interface AnomalyConfig {
  minScore: number; // 综合分门槛
  minLiquidity: number; // 流动性门槛（近似成交额：均量×均价）
  cooldownMinutes: number; // 同方向冷却（分钟）
  cooldownBarsFloor: number; // 同方向冷却的最小根数下限（保证大周期也低频）
  globalCooldownBars: number; // 跨方向全局冷却根数（抑制信号扎堆）
  maxAlerts: number; // 实时扫描最多返回条数
  oiWin: number; // 持仓代理：近端窗口
  oiBaseWin: number; // 持仓代理：基准窗口
  activeBuyWin: number; // 主动买盘回看窗口
  priceWin: number; // 价格动量回看窗口
  volWin: number; // 放量基准窗口
  stopAtrMult: number; // 止损 = ATR × 该倍数
  targetR: number; // 止盈 = 风险距离 × 该倍数
  atrWin: number; // ATR 窗口
}

export const DEFAULT_ANOMALY: AnomalyConfig = {
  // 综合分门槛抬高到 50：原版 35 在现货代理数据上触发太密，
  // 配合全局冷却把日线信号压到个位数，做到「低频高质量」。
  minScore: 50,
  minLiquidity: 1_000_000,
  cooldownMinutes: 30,
  // 同方向冷却至少隔 12 根（日线≈12天），避免同向连环触发。
  cooldownBarsFloor: 12,
  // 任意两笔信号（含反向）至少隔 6 根，抑制扎堆。
  globalCooldownBars: 6,
  maxAlerts: 5,
  oiWin: 5,
  oiBaseWin: 30,
  activeBuyWin: 10,
  priceWin: 5,
  volWin: 20,
  stopAtrMult: 2.0,
  targetR: 2.0,
  atrWin: 14,
};

/** 周期 -> 每根 K 线的分钟数，用于把「30 分钟冷却」换算成根数。 */
function granularityMinutes(granularity: string): number {
  const g = granularity.toLowerCase();
  const map: Record<string, number> = {
    "1min": 1,
    "5min": 5,
    "15min": 15,
    "30min": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
    "6h": 360,
    "12h": 720,
    "1day": 1440,
    "1week": 10080,
  };
  return map[g] ?? 1440;
}

/** Wilder ATR，逐根输出（前 atrWin 根为 NaN）。 */
function computeATR(candles: Candle[], win: number): number[] {
  const atr: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < win + 1) return atr;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
  }
  let sum = 0;
  for (let i = 1; i <= win; i++) sum += tr[i];
  let prev = sum / win;
  atr[win] = prev;
  for (let i = win + 1; i < candles.length; i++) {
    prev = (prev * (win - 1) + tr[i]) / win;
    atr[i] = prev;
  }
  return atr;
}

/**
 * 持仓异动代理：近端均量相对基准均量的增幅（0..100）。
 * 没有真实 OI，用成交量动能近似——成交量骤增往往伴随持仓变化。
 */
function oiFactorAt(candles: Candle[], i: number, win: number, baseWin: number): number {
  if (i < baseWin) return 0;
  let recent = 0;
  for (let k = i - win + 1; k <= i; k++) recent += candles[k].volume;
  recent /= win;
  let base = 0;
  for (let k = i - baseWin + 1; k <= i - win; k++) base += candles[k].volume;
  const baseN = baseWin - win;
  base /= baseN;
  if (base <= 0) return 0;
  const change = (recent - base) / base;
  return Math.min(Math.max(change * 100, 0), 100);
}

/** 主动买盘领先：回看窗口内强实体阳线占比（0..100）。 */
function activeBuyAt(candles: Candle[], i: number, win: number): number {
  if (i < win) return 0;
  let strong = 0;
  for (let k = i - win + 1; k <= i; k++) {
    const c = candles[k];
    const body = c.close - c.open;
    const range = c.high - c.low;
    if (range > 0 && body / range > 0.6) strong++;
  }
  return (strong / win) * 100;
}

/** 价格异动：回看窗口内的绝对涨跌幅放大（0..100）。 */
function priceMoveAt(candles: Candle[], i: number, win: number): number {
  if (i < win) return 0;
  const now = candles[i].close;
  const prev = candles[i - win].close;
  if (prev <= 0) return 0;
  const changePct = ((now - prev) / prev) * 100;
  return Math.min(Math.abs(changePct) * 8, 100);
}

/** 放量异动：近 3 根均量相对基准均量的倍数（0..100）。 */
function volumeSurgeAt(candles: Candle[], i: number, win: number): number {
  if (i < win) return 0;
  let recent = 0;
  for (let k = i - 2; k <= i; k++) recent += candles[k].volume;
  recent /= 3;
  let base = 0;
  for (let k = i - win + 1; k <= i - 3; k++) base += candles[k].volume;
  const baseN = win - 3;
  if (baseN <= 0) return 0;
  base /= baseN;
  if (base <= 0) return 0;
  const ratio = recent / base;
  return Math.min(Math.max((ratio - 1) * 50, 0), 100);
}

function factorsAt(candles: Candle[], i: number, cfg: AnomalyConfig): AnomalyFactors {
  return {
    oiChange: oiFactorAt(candles, i, cfg.oiWin, cfg.oiBaseWin),
    activeBuy: activeBuyAt(candles, i, cfg.activeBuyWin),
    priceMove: priceMoveAt(candles, i, cfg.priceWin),
    volumeSurge: volumeSurgeAt(candles, i, cfg.volWin),
  };
}

export function scoreFactors(f: AnomalyFactors): number {
  const s =
    f.oiChange * WEIGHTS.oiChange +
    f.activeBuy * WEIGHTS.activeBuy +
    f.priceMove * WEIGHTS.priceMove +
    f.volumeSurge * WEIGHTS.volumeSurge;
  return Math.round(Math.min(s, 100));
}

export function dominantLabel(f: AnomalyFactors, score: number, minScore: number): AnomalyLabel {
  if (score < minScore) return "无明显异动";
  const entries: [keyof AnomalyFactors, AnomalyLabel][] = [
    ["oiChange", "持仓异动"],
    ["activeBuy", "主动买领先"],
    ["priceMove", "价格异动"],
    ["volumeSurge", "放量异动"],
  ];
  let best = entries[0];
  for (const e of entries) {
    if (f[e[0]] > f[best[0]]) best = e;
  }
  return best[1];
}

/**
 * 流动性近似：用「近端均量 × 当前价」估算成交额，过滤掉太小的盘。
 * 现货公开 K 线没有 OI，这是在无 OI 数据下最接近原版「OI≥100万U」的代理。
 */
function liquidityAt(candles: Candle[], i: number, win: number): number {
  if (i < win) return 0;
  let vol = 0;
  for (let k = i - win + 1; k <= i; k++) vol += candles[k].volume;
  vol /= win;
  return vol * candles[i].close;
}

/** 方向判定：主动买盘强 / 价格向上 -> 做多；价格向下且买盘弱 -> 做空。 */
function directionAt(
  candles: Candle[],
  i: number,
  f: AnomalyFactors,
  priceWin: number
): "long" | "short" | null {
  const now = candles[i].close;
  const prev = candles[Math.max(0, i - priceWin)].close;
  const up = now >= prev;
  // 价格向上 + 有主动买盘 -> 做多
  if (up && f.activeBuy >= 40) return "long";
  // 价格向上但买盘一般，只要动量为正也可偏多
  if (up && f.priceMove >= 30) return "long";
  // 价格向下 + 买盘弱 -> 做空
  if (!up && f.activeBuy < 40) return "short";
  return null;
}

export interface AnomalySignalMeta {
  index: number;
  score: number;
  label: AnomalyLabel;
  factors: AnomalyFactors;
}

export interface AnomalyResult {
  signals: TradeSignal[];
  /** 最近的（最多 maxAlerts 条）异动元信息，供前端展示标签/分数。 */
  latestAlerts: AnomalySignalMeta[];
}

/**
 * 全序列扫描，产出可回测的标准 TradeSignal。
 *
 * 每根 K 线：用截至当根的历史算因子分；过分 + 正向标签 + 流动性 + 方向明确 +
 * 冷却通过，才在「下一根开盘」挂一笔交易。止损按 ATR，止盈按风险距离倍数。
 */
export function generateAnomalySignals(
  candles: Candle[],
  granularity = "1day",
  cfg: AnomalyConfig = DEFAULT_ANOMALY,
  risk: RiskConfig = DEFAULT_RISK
): AnomalyResult {
  const signals: TradeSignal[] = [];
  const alerts: AnomalySignalMeta[] = [];
  if (candles.length < cfg.oiBaseWin + 2) return { signals, latestAlerts: [] };

  const atr = computeATR(candles, cfg.atrWin);
  const barMin = granularityMinutes(granularity);
  // 同方向冷却：取「30分钟换算根数」与「根数下限」的较大值，
  // 这样小周期用时间口径、大周期用根数下限，两头都保持低频。
  const cooldownBars = Math.max(
    cfg.cooldownBarsFloor,
    Math.ceil(cfg.cooldownMinutes / barMin)
  );

  let lastLongIdx = -Infinity;
  let lastShortIdx = -Infinity;
  let lastAnyIdx = -Infinity;

  const warmup = Math.max(cfg.oiBaseWin, cfg.atrWin) + 1;
  for (let i = warmup; i < candles.length - 1; i++) {
    const f = factorsAt(candles, i, cfg);
    const score = scoreFactors(f);
    if (score < cfg.minScore) continue;

    const label = dominantLabel(f, score, cfg.minScore);
    if (!POSITIVE_LABELS.includes(label)) continue;

    if (liquidityAt(candles, i, cfg.volWin) < cfg.minLiquidity) continue;

    const dir = directionAt(candles, i, f, cfg.priceWin);
    if (!dir) continue;

    // 同方向冷却
    if (dir === "long" && i - lastLongIdx < cooldownBars) continue;
    if (dir === "short" && i - lastShortIdx < cooldownBars) continue;
    // 全局冷却（跨方向）：抑制信号扎堆
    if (i - lastAnyIdx < cfg.globalCooldownBars) continue;

    const a = atr[i];
    const atrVal = Number.isNaN(a) ? candles[i].close * 0.01 : a;

    const entryIdx = i + 1;
    const entryBar = candles[entryIdx];
    const entry = entryBar.open;

    let stop: number;
    let target: number;
    let riskDist: number;
    if (dir === "long") {
      stop = entry - atrVal * cfg.stopAtrMult;
      riskDist = entry - stop;
      if (riskDist <= 0) continue;
      target = entry + riskDist * cfg.targetR;
    } else {
      stop = entry + atrVal * cfg.stopAtrMult;
      riskDist = stop - entry;
      if (riskDist <= 0) continue;
      target = entry - riskDist * cfg.targetR;
    }

    const stopPct = riskDist / entry;
    const positionPct =
      stopPct > 0 ? Math.min(risk.riskPerTradePct / 100 / stopPct, 1) : 0;

    signals.push({
      index: entryIdx,
      time: entryBar.time,
      direction: dir,
      entry,
      stop,
      target,
      positionPct: Math.round(positionPct * 1000) / 1000,
      riskReward: cfg.targetR,
      reason: `${label}（综合分 ${score}）触发${dir === "long" ? "做多" : "做空"}`,
      sourceStructure: "SOS", // A档无威科夫结构，占位以兼容类型
    });

    alerts.push({ index: i, score, label, factors: f });

    if (dir === "long") lastLongIdx = i;
    else lastShortIdx = i;
    lastAnyIdx = i;
  }

  const latestAlerts = alerts.slice(-cfg.maxAlerts).reverse();
  return { signals, latestAlerts };
}
