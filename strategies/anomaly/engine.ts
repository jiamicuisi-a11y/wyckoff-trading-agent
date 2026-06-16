import { Kline, AnomalySignal } from './types';
import { getAllFactors } from './factors';
import { calculateScore, generateLabel } from './scorer';

export class AnomalyEngine {
  private minScore: number;
  private minOi: number;

  constructor(params?: { minScore?: number; minOi?: number }) {
    this.minScore = params?.minScore ?? 35;
    this.minOi = params?.minOi ?? 1_000_000;
  }

  /**
   * 生成A档异动信号
   */
  generateSignals(klines: Kline[], symbol: string): AnomalySignal[] {
    if (klines.length < 30) return [];

    const factors = getAllFactors(klines);
    const score = calculateScore(factors);

    if (score < this.minScore) return [];

    const label = generateLabel(factors, score);
    const direction = factors.activeBuy > 40 || factors.priceMove > 30 ? 'long' : 'short';

    return [{
      symbol,
      direction,
      score,
      label,
      factors,
      timestamp: klines[klines.length - 1].timestamp,
    }];
  }
}