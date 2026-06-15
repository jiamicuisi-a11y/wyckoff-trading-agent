import type {
  Candle,
  PhaseSegment,
  StructurePoint,
  WyckoffPhaseType,
} from "./types";
import { sma, atr, volumeAverage, rollingHigh, rollingLow } from "./indicators";
import { getWyckoffParams, type WyckoffParams } from "./params";

/**
 * 威科夫感知引擎（确定性规则，无 LLM）。
 *
 * 设计目标（本次重做的五条硬指标）：
 *  1. 低频高质量：同类结构加冷却期、提高插破/放量/贴边门槛，300 根只输出个位数结构点。
 *  2. 不逆势：做多结构(Spring/SOS/LPS)只允许在 吸筹/拉升 中；做空结构(UTAD/SOW)只允许
 *     在 派发/下跌 中。拉升途中禁止做空，下跌途中禁止做多 —— 这道方向墙在 detectStructures 内。
 *  3. 阶段不横跳：阶段段强制最小持续长度，迭代并入过短段，消除闪烁。
 *  4. 周期自适应：所有窗口/阈值来自 getWyckoffParams(granularity)，不再写死常量。
 *  5. 多币种：本引擎与币种无关，矩阵层负责跑多币种。
 */

export interface WyckoffContext {
  params: WyckoffParams;
  maFast: number[];
  maSlow: number[];
  atr: number[];
  volAvg: number[];
}

export function computeContext(
  candles: Candle[],
  granularity = "1day"
): WyckoffContext {
  const params = getWyckoffParams(granularity);
  const closes = candles.map((c) => c.close);
  return {
    params,
    maFast: sma(closes, params.maFast),
    maSlow: sma(closes, params.maSlow),
    atr: atr(candles, 14),
    volAvg: volumeAverage(candles, params.volWin),
  };
}

/**
 * 单根 K 线的威科夫阶段分类（趋势 + 波动 + 区间位置启发式）。
 * - Markup:   快线 > 慢线，且快线斜率明显向上
 * - Markdown: 快线 < 慢线，且快线斜率明显向下
 * - Accumulation: 低斜率/横盘，且此前经历下跌或处于区间下半部
 * - Distribution: 低斜率/横盘，且此前经历上涨或处于区间上半部
 */
function classifyBar(
  candles: Candle[],
  i: number,
  ctx: WyckoffContext
): WyckoffPhaseType {
  const p = ctx.params;
  if (i < p.maSlow) return "Undefined";

  const c = candles[i];
  const fast = ctx.maFast[i];
  const slow = ctx.maSlow[i];
  const fastPrev = ctx.maFast[i - p.slopeWin];
  if (Number.isNaN(fast) || Number.isNaN(slow) || Number.isNaN(fastPrev)) {
    return "Undefined";
  }

  const slope = (fast - fastPrev) / fastPrev; // 归一化快线斜率
  const rangeHigh = rollingHigh(candles, i, p.rangeWin);
  const rangeLow = rollingLow(candles, i, p.rangeWin);
  const rangeSize = (rangeHigh - rangeLow) / rangeLow;
  const pos = (c.close - rangeLow) / Math.max(rangeHigh - rangeLow, 1e-9); // 区间内 0..1 位置

  // 先判强趋势
  if (fast > slow && slope > p.trendSlope) return "Markup";
  if (fast < slow && slope < -p.trendSlope) return "Markdown";

  // 横盘/收敛：用 priorMove 与区间位置区分 吸筹 / 派发
  const isFlat = Math.abs(slope) < p.flatSlope || rangeSize < p.tightRange;
  if (isFlat) {
    const past = Math.max(0, i - p.priorMoveWin);
    const priorMove = (c.close - candles[past].close) / candles[past].close;
    if (priorMove < -0.05 || pos < 0.5) return "Accumulation";
    if (priorMove > 0.05 || pos >= 0.5) return "Distribution";
    return fast >= slow ? "Distribution" : "Accumulation";
  }

  // 弱趋势兜底
  if (fast >= slow) return "Markup";
  return "Markdown";
}

/**
 * 把逐根标签平滑成连续阶段段，并强制最小持续长度，消除横跳。
 *
 * 关键改动：旧版只把 <3 根的段并入前一段，导致 300 根里仍有七八次切换。
 * 新版做两件事：
 *  (1) 多数表决平滑（窗口随周期）
 *  (2) 迭代地把短于 minPhaseLen 的段并入"更应归属"的相邻段（取较长的邻段方向），
 *      反复执行直到没有过短段为止 —— 这样吸筹/派发不会一两根就翻面。
 */
export function detectPhases(
  candles: Candle[],
  ctx: WyckoffContext
): PhaseSegment[] {
  const p = ctx.params;
  const raw: WyckoffPhaseType[] = candles.map((_, i) =>
    classifyBar(candles, i, ctx)
  );

  // 多数表决平滑
  const smoothed: WyckoffPhaseType[] = raw.slice();
  const sw = p.smoothWin;
  for (let i = 0; i < raw.length; i++) {
    const counts: Record<string, number> = {};
    for (
      let k = Math.max(0, i - sw);
      k <= Math.min(raw.length - 1, i + sw);
      k++
    ) {
      counts[raw[k]] = (counts[raw[k]] || 0) + 1;
    }
    let best = raw[i];
    let bestN = -1;
    for (const [ph, n] of Object.entries(counts)) {
      if (n > bestN) {
        bestN = n;
        best = ph as WyckoffPhaseType;
      }
    }
    smoothed[i] = best;
  }

  // 构建初始段
  let segments = buildSegments(smoothed, candles);

  // 迭代并入过短段：每轮找最短且 < minPhaseLen 的段，合并到相邻较长段
  // （用相邻较长段的相位覆盖它），直到所有段都 >= minPhaseLen 或只剩一段。
  let guard = 0;
  while (segments.length > 1 && guard < 500) {
    guard++;
    let shortestIdx = -1;
    let shortestLen = Infinity;
    for (let k = 0; k < segments.length; k++) {
      const len = segments[k].endIndex - segments[k].startIndex + 1;
      if (len < p.minPhaseLen && len < shortestLen) {
        shortestLen = len;
        shortestIdx = k;
      }
    }
    if (shortestIdx === -1) break; // 没有过短段了

    // 决定并入方向：选相邻中较长的那一段的相位
    const prev = segments[shortestIdx - 1];
    const next = segments[shortestIdx + 1];
    let targetPhase: WyckoffPhaseType;
    if (prev && next) {
      const prevLen = prev.endIndex - prev.startIndex + 1;
      const nextLen = next.endIndex - next.startIndex + 1;
      targetPhase = prevLen >= nextLen ? prev.phase : next.phase;
    } else if (prev) {
      targetPhase = prev.phase;
    } else {
      targetPhase = next.phase;
    }

    // 用目标相位覆盖该段，再重建（相邻同相位段会自动合并）
    for (
      let idx = segments[shortestIdx].startIndex;
      idx <= segments[shortestIdx].endIndex;
      idx++
    ) {
      smoothed[idx] = targetPhase;
    }
    segments = buildSegments(smoothed, candles);
  }

  return segments;
}

function buildSegments(
  labels: WyckoffPhaseType[],
  candles: Candle[]
): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  let start = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i === labels.length || labels[i] !== labels[start]) {
      const phase = labels[start];
      segments.push({
        phase,
        startIndex: start,
        endIndex: i - 1,
        startTime: candles[start].time,
        endTime: candles[i - 1].time,
        note: phaseNote(phase),
      });
      start = i;
    }
  }
  return segments;
}

function phaseNote(phase: WyckoffPhaseType): string {
  switch (phase) {
    case "Accumulation":
      return "吸筹：价格在低位区间震荡，主力低吸，波动收敛、缩量后伺机放量。";
    case "Markup":
      return "拉升：均线多头排列，价格持续创新高，趋势向上。";
    case "Distribution":
      return "派发：价格在高位区间震荡，主力派货，上涨乏力。";
    case "Markdown":
      return "下跌：均线空头排列，价格持续创新低，趋势向下。";
    default:
      return "数据不足或形态不明确。";
  }
}

/**
 * 在阶段图之上检测威科夫结构事件。
 *
 * 低频高质量手段（全部生效）：
 *  - 冷却期：同类结构在 structureCooldown 根内只允许触发一次。
 *  - 插破幅度：Spring/UTAD 的盘中插破必须超过 penetrationPct，且收回幅度够 closeBackPct。
 *  - 放量确认：SOS/SOW 必须 volMult 倍于成交量均值。
 *  - 贴边约束：触发点必须靠近区间边缘（edgeDistPct 内），排除区间中部乱触发。
 *
 * 不逆势方向墙（最重要）：
 *  - 做多结构(Spring/SOS/LPS)只在 Accumulation 或 Markup 出现；Markdown 中一律禁止。
 *  - 做空结构(UTAD/SOW)只在 Distribution 或 Markdown 出现；Markup 中一律禁止。
 */
export function detectStructures(
  candles: Candle[],
  ctx: WyckoffContext,
  phases: PhaseSegment[]
): StructurePoint[] {
  const p = ctx.params;
  const points: StructurePoint[] = [];
  const phaseAt = (i: number): WyckoffPhaseType => {
    for (const s of phases)
      if (i >= s.startIndex && i <= s.endIndex) return s.phase;
    return "Undefined";
  };

  // 冷却检查：同类结构在 structureCooldown 根内不得重复；
  // 另有全局冷却 globalCooldown —— 任意两个结构点（跨类型）之间也要拉开间隔，抑制扎堆。
  const lastIdxOfType: Record<string, number> = {};
  let lastAnyIdx = -Infinity;
  const onCooldown = (type: string, i: number): boolean => {
    const last = lastIdxOfType[type];
    const sameTypeBlocked =
      last !== undefined && i - last < p.structureCooldown;
    const globalBlocked = i - lastAnyIdx < p.globalCooldown;
    return sameTypeBlocked || globalBlocked;
  };
  const record = (type: string, i: number): void => {
    lastIdxOfType[type] = i;
    lastAnyIdx = i;
  };

  for (let i = p.maSlow; i < candles.length; i++) {
    const c = candles[i];
    const prevLow = rollingLow(candles, i, p.rangeWin, true);
    const prevHigh = rollingHigh(candles, i, p.rangeWin, true);
    const rangeMid = (prevHigh + prevLow) / 2;
    const rangeWidth = Math.max(prevHigh - prevLow, 1e-9);
    const vol = c.volume;
    const vAvg = ctx.volAvg[i];
    const highVol = !Number.isNaN(vAvg) && vol > vAvg * p.volMult;

    const phase = phaseAt(i);
    const phasePrev = phaseAt(i - 1);

    // 方向墙：当前/上一根所属阶段决定允许的结构方向
    const bullishCtx =
      phase === "Accumulation" ||
      phase === "Markup" ||
      phasePrev === "Accumulation";
    const bearishCtx =
      phase === "Distribution" ||
      phase === "Markdown" ||
      phasePrev === "Distribution";
    // 明确禁止逆势：拉升中不做空，下跌中不做多
    const longForbidden = phase === "Markdown";
    const shortForbidden = phase === "Markup";

    // 贴边判定（距离对应边缘的相对距离）
    const nearLowEdge = (prevLow - c.low) >= 0 || (c.low - prevLow) / rangeWidth <= p.edgeDistPct;
    const nearHighEdge = (c.high - prevHigh) >= 0 || (prevHigh - c.high) / rangeWidth <= p.edgeDistPct;

    // ---------- Spring（看多）：盘中跌破前低足够幅度后收回区间内 ----------
    if (
      !longForbidden &&
      bullishCtx &&
      !onCooldown("Spring", i) &&
      c.low < prevLow * (1 - p.penetrationPct) &&
      c.close > prevLow * (1 + p.closeBackPct) &&
      c.close > c.open &&
      nearLowEdge
    ) {
      points.push({
        type: "Spring",
        index: i,
        time: c.time,
        price: c.low,
        bias: "bullish",
        explanation:
          "弹簧 Spring：盘中放量跌破前期支撑后强力收回区间内，假突破洗盘，吸筹末端的看多信号。",
      });
      record("Spring", i);
      continue;
    }

    // ---------- UTAD（看空）：盘中突破前高足够幅度后收回区间内 ----------
    if (
      !shortForbidden &&
      bearishCtx &&
      !onCooldown("UTAD", i) &&
      c.high > prevHigh * (1 + p.penetrationPct) &&
      c.close < prevHigh * (1 - p.closeBackPct) &&
      c.close < c.open &&
      nearHighEdge
    ) {
      points.push({
        type: "UTAD",
        index: i,
        time: c.time,
        price: c.high,
        bias: "bearish",
        explanation:
          "UTAD：盘中突破前期高点后快速跌回区间内，假突破诱多，派发末端的看空信号。",
      });
      record("UTAD", i);
      continue;
    }

    // ---------- SOS（看多）：放量强势收盘突破区间上沿 ----------
    if (
      !longForbidden &&
      bullishCtx &&
      !onCooldown("SOS", i) &&
      c.close > prevHigh * (1 + p.penetrationPct) &&
      highVol &&
      c.close > c.open &&
      c.close > rangeMid
    ) {
      points.push({
        type: "SOS",
        index: i,
        time: c.time,
        price: c.close,
        bias: "bullish",
        explanation: "SOS 强势信号：放量突破吸筹区间上沿，需求占优，趋势确认向上。",
      });
      record("SOS", i);
      continue;
    }

    // ---------- SOW（看空）：放量弱势收盘跌破区间下沿 ----------
    if (
      !shortForbidden &&
      bearishCtx &&
      !onCooldown("SOW", i) &&
      c.close < prevLow * (1 - p.penetrationPct) &&
      highVol &&
      c.close < c.open &&
      c.close < rangeMid
    ) {
      points.push({
        type: "SOW",
        index: i,
        time: c.time,
        price: c.close,
        bias: "bearish",
        explanation: "SOW 弱势信号：放量跌破派发区间下沿，供给占优，趋势确认向下。",
      });
      record("SOW", i);
      continue;
    }

    // ---------- LPS（看多）：SOS 之后的回踩不破，确认趋势延续 ----------
    if (!longForbidden && bullishCtx && !onCooldown("LPS", i)) {
      const recentSOS = points
        .slice()
        .reverse()
        .find(
          (pt) =>
            pt.type === "SOS" &&
            i - pt.index > 0 &&
            i - pt.index <= p.lpsLookback
        );
      if (
        recentSOS &&
        c.low <= recentSOS.price &&
        c.close > recentSOS.price * (1 - p.closeBackPct * 3) &&
        c.close > c.open
      ) {
        points.push({
          type: "LPS",
          index: i,
          time: c.time,
          price: c.low,
          bias: "bullish",
          explanation:
            "LPS 最后支撑点：突破后回踩不破前高/支撑，多头确认，趋势延续。",
        });
        record("LPS", i);
        continue;
      }
    }
  }

  return points;
}

export interface WyckoffAnalysis {
  phases: PhaseSegment[];
  structurePoints: StructurePoint[];
  currentPhase: WyckoffPhaseType;
}

export function analyzeWyckoff(
  candles: Candle[],
  granularity = "1day"
): WyckoffAnalysis {
  const ctx = computeContext(candles, granularity);
  const phases = detectPhases(candles, ctx);
  const structurePoints = detectStructures(candles, ctx, phases);
  const currentPhase =
    phases.length > 0 ? phases[phases.length - 1].phase : "Undefined";
  return { phases, structurePoints, currentPhase };
}
