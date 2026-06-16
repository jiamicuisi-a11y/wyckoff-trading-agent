import { AnomalyFactors } from './types';

const WEIGHTS = {
  oiChange: 0.35,
  activeBuy: 0.30,
  priceMove: 0.20,
  volumeSurge: 0.15,
};

export function calculateScore(factors: AnomalyFactors): number {
  let score = 0;
  score += factors.oiChange * WEIGHTS.oiChange;
  score += factors.activeBuy * WEIGHTS.activeBuy;
  score += factors.priceMove * WEIGHTS.priceMove;
  score += factors.volumeSurge * WEIGHTS.volumeSurge;
  return Math.round(Math.min(score, 100));
}

export function generateLabel(factors: AnomalyFactors, score: number): string {
  if (score < 35) return '无明显异动';

  const dominant = Object.keys(factors).reduce((a, b) =>
    factors[a as keyof AnomalyFactors] > factors[b as keyof AnomalyFactors] ? a : b
  );

  const labelMap: Record<string, string> = {
    oiChange: '持仓异动',
    activeBuy: '主动买领先',
    priceMove: '价格异动',
    volumeSurge: '放量异动',
  };

  return labelMap[dominant] || '异动信号';
}