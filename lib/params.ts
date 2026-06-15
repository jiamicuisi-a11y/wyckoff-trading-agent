import type { Granularity } from "./bitget";

/**
 * 周期自适应参数。
 *
 * 理念："15m 有 15m 的威科夫，4h 有 4h 的威科夫，日线有日线的威科夫。"
 * 不同周期的噪声尺度、趋势持续长度、放量门槛都不一样，因此回看窗口与阈值
 * 必须随 granularity 缩放，而不是写死 MA_FAST=20 / RANGE_WIN=20 这种全局常量。
 *
 * 较小周期（15m/1h）：噪声大、假突破多 —— 用更长的相对回看窗口、更高的放量
 *   与插破门槛、更长的冷却期来压制频繁触发。
 * 较大周期（日线/周线）：每根 K 线信息量大 —— 窗口相对收紧，但阶段最小持续
 *   长度仍要足够，避免来回横跳。
 */
export interface WyckoffParams {
  granularity: string;
  // 均线 / 斜率
  maFast: number;
  maSlow: number;
  slopeWin: number; // 计算快线斜率的回看根数
  // 区间 / 成交量窗口
  rangeWin: number; // 描述当前交易区间的回看根数
  volWin: number; // 成交量均值窗口
  // 阶段判定阈值
  trendSlope: number; // 超过该归一化斜率视为趋势
  flatSlope: number; // 低于该斜率视为横盘
  tightRange: number; // 区间宽度低于该比例视为收敛
  priorMoveWin: number; // 判断"此前是上涨还是下跌到此"的回看根数
  // 阶段平滑
  smoothWin: number; // 多数表决平滑半窗
  minPhaseLen: number; // 一个有效阶段段的最小持续根数（不到则并入相邻段）
  // 结构触发门槛（低频高质量的核心）
  structureCooldown: number; // 同类结构至少间隔多少根才允许再次触发
  penetrationPct: number; // 插破前高/前低的最小幅度（相对价格）
  closeBackPct: number; // 假突破后收回区间内的最小幅度（相对边缘）
  volMult: number; // 放量确认倍数（相对成交量均值）
  edgeDistPct: number; // 触发点距离区间边缘的最大距离（确保贴边，而非区间中部乱触发）
  lpsLookback: number; // LPS 回踩在 SOS 之后多少根内有效
  globalCooldown: number; // 任意两个结构点之间的最小间隔（跨类型），抑制信号扎堆
  maxPerSegment: number; // 单个阶段段内最多允许的结构点数（威科夫一段行情里关键结构本就稀少）
}

/**
 * 把 granularity 归一化到一个"尺度档位"，再据此给出参数组。
 */
export function getWyckoffParams(granularity: string): WyckoffParams {
  const g = granularity.toLowerCase();

  // 分钟级（1m/5m/15m/30m）：噪声最大，门槛最高、冷却最长
  if (g === "1min" || g === "5min" || g === "15min" || g === "30min") {
    return {
      granularity,
      maFast: 21,
      maSlow: 55,
      slopeWin: 12,
      rangeWin: 30,
      volWin: 30,
      trendSlope: 0.02,
      flatSlope: 0.012,
      tightRange: 0.12,
      priorMoveWin: 40,
      smoothWin: 5,
      minPhaseLen: 20,
      structureCooldown: 20,
      penetrationPct: 0.0015,
      closeBackPct: 0.001,
      volMult: 1.8,
      edgeDistPct: 0.06,
      lpsLookback: 14,
      globalCooldown: 10,
      maxPerSegment: 2,
    };
  }

  // 小时级（1h/2h）
  if (g === "1h" || g === "2h") {
    return {
      granularity,
      maFast: 20,
      maSlow: 50,
      slopeWin: 10,
      rangeWin: 26,
      volWin: 24,
      trendSlope: 0.025,
      flatSlope: 0.015,
      tightRange: 0.14,
      priorMoveWin: 36,
      smoothWin: 4,
      minPhaseLen: 18,
      structureCooldown: 18,
      penetrationPct: 0.002,
      closeBackPct: 0.0015,
      volMult: 1.6,
      edgeDistPct: 0.07,
      lpsLookback: 14,
      globalCooldown: 9,
      maxPerSegment: 2,
    };
  }

  // 4h / 6h / 12h
  if (g === "4h" || g === "6h" || g === "12h") {
    return {
      granularity,
      maFast: 20,
      maSlow: 50,
      slopeWin: 10,
      rangeWin: 22,
      volWin: 20,
      trendSlope: 0.03,
      flatSlope: 0.02,
      tightRange: 0.16,
      priorMoveWin: 32,
      smoothWin: 4,
      minPhaseLen: 16,
      structureCooldown: 16,
      penetrationPct: 0.0025,
      closeBackPct: 0.002,
      volMult: 1.5,
      edgeDistPct: 0.08,
      lpsLookback: 12,
      globalCooldown: 8,
      maxPerSegment: 2,
    };
  }

  // 周线 / 月线：样本少，窗口收紧但阶段持续要求仍在
  if (g === "1week" || g === "1m") {
    return {
      granularity,
      maFast: 10,
      maSlow: 30,
      slopeWin: 6,
      rangeWin: 14,
      volWin: 12,
      trendSlope: 0.05,
      flatSlope: 0.03,
      tightRange: 0.22,
      priorMoveWin: 18,
      smoothWin: 3,
      minPhaseLen: 10,
      structureCooldown: 12,
      penetrationPct: 0.006,
      closeBackPct: 0.004,
      volMult: 1.5,
      edgeDistPct: 0.12,
      lpsLookback: 8,
      globalCooldown: 6,
      maxPerSegment: 2,
    };
  }

  // 默认：日线（1day）。这是参赛验证的主档。
  return {
    granularity,
    maFast: 20,
    maSlow: 50,
    slopeWin: 10,
    rangeWin: 20,
    volWin: 20,
    trendSlope: 0.035,
    flatSlope: 0.02,
    tightRange: 0.18,
    priorMoveWin: 30,
    smoothWin: 3,
    minPhaseLen: 18,
    structureCooldown: 28,
    penetrationPct: 0.006,
    closeBackPct: 0.003,
    volMult: 1.8,
    edgeDistPct: 0.08,
    lpsLookback: 10,
    globalCooldown: 8,
    maxPerSegment: 2,
  };
}
