// Core domain types for Wyckoff Trading Agent

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base volume
}

export type WyckoffPhaseType =
  | "Accumulation"
  | "Markup"
  | "Distribution"
  | "Markdown"
  | "Undefined";

export interface PhaseSegment {
  phase: WyckoffPhaseType;
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  note: string;
}

export type StructureType =
  | "Spring"
  | "SOS"
  | "LPS"
  | "UTAD"
  | "SOW";

export interface StructurePoint {
  type: StructureType;
  index: number;
  time: number;
  price: number;
  bias: "bullish" | "bearish";
  explanation: string;
}

export type SignalDirection = "long" | "short";

export interface TradeSignal {
  index: number;
  time: number;
  direction: SignalDirection;
  entry: number;
  stop: number;
  target: number;
  positionPct: number; // fraction of equity allocated as notional
  riskReward: number;
  reason: string;
  sourceStructure: StructureType;
}

export interface ClosedTrade {
  direction: SignalDirection;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  stop: number;
  target: number;
  outcome: "win" | "loss";
  pnlPct: number; // return on equity for the trade (net of fees & slippage)
  rMultiple: number;
  reason: string;
  exitReason: ExitReason; // why the position was closed
}

export type ExitReason = "止盈" | "止损" | "结构失效" | "末尾平仓";

export interface EquityPoint {
  time: number;
  equity: number;
  benchmark: number;
}

export interface BacktestResult {
  totalReturnPct: number;
  buyHoldReturnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  tradeCount: number;
  wins: number;
  losses: number;
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
}

export interface RiskConfig {
  riskPerTradePct: number; // % of equity risked per trade
  maxConcurrentPositions: number;
  feePct?: number; // taker fee per side, fraction (e.g. 0.0006 = 0.06%)
  slippagePct?: number; // slippage per side, fraction (e.g. 0.0002 = 0.02%)
}

export interface MatrixRow {
  symbol: string;
  granularity: string;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  tradeCount: number;
  error?: string;
}

export interface AnalyzeResponse {
  symbol: string;
  granularity: string;
  candles: Candle[];
  phases: PhaseSegment[];
  structurePoints: StructurePoint[];
  signals: TradeSignal[];
  backtest: BacktestResult;
  riskConfig: RiskConfig;
  generatedAt: string;
}
