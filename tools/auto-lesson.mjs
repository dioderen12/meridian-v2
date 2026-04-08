// Auto-Lesson System - with Winner Analysis
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = join(__dirname, '..', 'lessons.json');
const BLACKLIST_FILE = join(__dirname, '..', 'pool-blacklist.json');
const WINNERS_FILE = join(__dirname, '..', 'winner-patterns.json');

let lessons = [];
let blacklist = { v2: {} };
let winners = { byHour: {}, byTIR: {}, byFeeYield: {}, fastWins: [], bigWins: [], recentWins: [] };

function loadData() {
  try {
    if (existsSync(LESSONS_FILE)) {
      const data = JSON.parse(readFileSync(LESSONS_FILE, 'utf8'));
      lessons = data.lessons || [];
    }
    if (existsSync(BLACKLIST_FILE)) {
      blacklist = JSON.parse(readFileSync(BLACKLIST_FILE, 'utf8'));
      if (!blacklist.v2) blacklist.v2 = {};
    }
    if (existsSync(WINNERS_FILE)) {
      winners = JSON.parse(readFileSync(WINNERS_FILE, 'utf8'));
    }
  } catch(e) {
    console.log('[LESSONS] Load error:', e.message);
  }
}
loadData();

async function saveLessons() {
  try {
    writeFileSync(LESSONS_FILE, JSON.stringify({ lessons, performance: [] }, null, 2));
  } catch(e) {}
}

function saveWinners() {
  try {
    writeFileSync(WINNERS_FILE, JSON.stringify(winners, null, 2));
  } catch(e) {}
}

function log(prefix, msg) {
  console.log(`[${prefix}] ${msg}`);
}

// Winner Analysis Functions
export function analyzeWinner({ pair, poolAddress, pnlPct, age, tirPercent, feeYield }) {
  const hour = new Date().getHours();
  
  // By hour
  if (!winners.byHour[hour]) winners.byHour[hour] = { wins: 0, total: 0 };
  winners.byHour[hour].wins++;
  winners.byHour[hour].total++;
  
  // By TIR bucket
  const tirBucket = Math.floor(tirPercent / 10) * 10;
  if (!winners.byTIR[tirBucket]) winners.byTIR[tirBucket] = { wins: 0, total: 0 };
  winners.byTIR[tirBucket].wins++;
  winners.byTIR[tirBucket].total++;
  
  // By fee yield
  const feeBucket = Math.floor(feeYield / 5) * 5;
  if (!winners.byFeeYield[feeBucket]) winners.byFeeYield[feeBucket] = { wins: 0, total: 0 };
  winners.byFeeYield[feeBucket].wins++;
  winners.byFeeYield[feeBucket].total++;
  
  // Fast wins
  if (age < 5 && pnlPct > 0) {
    winners.fastWins.push({ pair, pnlPct, age, tirPercent, timestamp: new Date().toISOString() });
    if (winners.fastWins.length > 20) winners.fastWins = winners.fastWins.slice(-20);
  }
  
  // Big wins
  if (pnlPct > 15) {
    winners.bigWins.push({ pair, pnlPct, age, tirPercent, timestamp: new Date().toISOString() });
    if (winners.bigWins.length > 20) winners.bigWins = winners.bigWins.slice(-20);
  }
  
  // Recent
  winners.recentWins.push({ pair, poolAddress, pnlPct, age, tirPercent, feeYield, timestamp: new Date().toISOString() });
  if (winners.recentWins.length > 50) winners.recentWins = winners.recentWins.slice(-50);
  
  saveWinners();
  log('WINNER', `Analyzed: ${pair} +${pnlPct}% in ${age}min`);
}

export function getBestHours() {
  return Object.entries(winners.byHour)
    .map(([h, d]) => ({ hour: parseInt(h), winRate: d.wins / d.total, wins: d.wins }))
    .filter(h => h.wins >= 2)
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 3);
}

export function getBestTIRRange() {
  const entries = Object.entries(winners.byTIR)
    .map(([b, d]) => ({ min: parseInt(b), winRate: d.wins / d.total, wins: d.wins }))
    .filter(t => t.wins >= 2)
    .sort((a, b) => b.winRate - a.winRate);
  return entries[0] || { min: 70, max: 100 };
}

export function scoreCandidate({ tirPercent, feeYield, hour }) {
  let score = 50;
  
  const bestTIR = getBestTIRRange();
  if (tirPercent >= bestTIR.min) score += 20;
  else if (tirPercent >= 70) score += 10;
  
  const bestHours = getBestHours();
  if (bestHours.some(h => h.hour === hour)) score += 15;
  
  return Math.min(100, score);
}

export function getWinnerStats() {
  return {
    totalWins: winners.recentWins.length,
    avgPnL: winners.recentWins.length > 0 
      ? winners.recentWins.reduce((s, w) => s + w.pnlPct, 0) / winners.recentWins.length : 0,
    bestHours: getBestHours(),
    bestTIR: getBestTIRRange(),
    fastWins: winners.fastWins.length,
    bigWins: winners.bigWins.length
  };
}

// Lesson Templates
const EXIT_REASONS = {
  stop_loss: { tags: ['bad', 'stop_loss', 'loss'], lesson: 'Stopped out at -5%' },
  take_profit: { tags: ['good', 'take_profit', 'win'], lesson: 'Took profit at +10%' },
  max_hold: { tags: ['neutral', 'max_hold', 'completed'], lesson: 'Held for full 15 minutes' },
  oor: { tags: ['bad', 'oor', 'out_of_range'], lesson: 'Position went out of range' },
  oor_immediate: { tags: ['bad', 'scam', 'immediate_oor'], lesson: 'Immediate OOR - potential rug!' }
};

const TIR_LESSONS = {
  poor_tir: { tags: ['poor-tir', 'unstable', 'risky'], lesson: 'Pool only {inRangePercent}% in range - unstable' },
  good_tir: { tags: ['good-tir', 'stable', 'safe'], lesson: 'Pool {inRangePercent}% in range - stable' },
  oor_heavy: { tags: ['oor-heavy', 'high-risk', 'avoid'], lesson: 'Pool was {outOfRangePercent}% out of range' }
};

const WIN_PATTERNS = {
  fast_win: { tags: ['win', 'fast', 'quick'], lesson: 'Fast win! <5 min to TP' },
  slow_win: { tags: ['win', 'slow', 'steady'], lesson: 'Steady profit over 10-15 min' },
  fee_king: { tags: ['win', 'fee', 'high-fee'], lesson: 'Fees made up >50% of profit' },
  in_range_master: { tags: ['win', 'perfect', 'in-range'], lesson: 'Perfect in-range performance' },
  perfect_entry: { tags: ['win', 'perfect-entry'], lesson: 'Excellent entry timing' }
};

export async function autoAddLesson({ reason, poolAddress, pair, pnl, age, poolStats }) {
  const template = EXIT_REASONS[reason];
  if (!template) return;
  
  const lesson = {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36),
    created_at: new Date().toISOString(),
    outcome: reason,
    rule: template.lesson,
    tags: template.tags,
    context: { pool: poolAddress, pair: pair || '', pnl, age, poolStats }
  };
  
  lessons.push(lesson);
  log('LESSONS', `Added: ${reason} for ${pair}`);
  await saveLessons();
  
  // If winning trade, analyze patterns
  if (pnl > 0 && reason !== 'oor') {
    analyzeWinner({
      pair,
      poolAddress,
      pnlPct: pnl,
      age,
      tirPercent: poolStats?.tirPercent || 80,
      feeYield: poolStats?.feeYield || 5
    });
  }
}

export function checkAutoBlacklist({ poolAddress, pair, pnl, age }) {
  if (!poolAddress) return;
  
  if (age && age < 5) {
    const key = poolAddress.substring(0, 8);
    if (!blacklist.v2[key]) {
      blacklist.v2[key] = {
        symbol: pair || 'unknown',
        reason: `OOR immediate (${age?.toFixed(1)}min) - potential rug`,
        added_at: new Date().toISOString()
      };
      writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
      log('BLACKLIST', `Auto-blacklisted ${pair} - OOR immediate`);
    }
  }
  
  if (pnl && pnl < -20) {
    const key = poolAddress.substring(0, 8);
    if (!blacklist.v2[key]) {
      blacklist.v2[key] = {
        symbol: pair || 'unknown',
        reason: `Big loss: ${pnl.toFixed(1)}%`,
        added_at: new Date().toISOString()
      };
      writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
      log('BLACKLIST', `Auto-blacklisted ${pair} - Big loss ${pnl.toFixed(1)}%`);
    }
  }
}

export async function autoBlacklistBigLoss(poolAddress, pair, pnl) {
  if (!poolAddress || pnl >= -20) return false;
  
  const key = poolAddress.substring(0, 8);
  if (!blacklist.v2[key]) {
    blacklist.v2[key] = {
      symbol: pair || 'unknown',
      reason: `BIG LOSS: ${pnl.toFixed(2)}% loss - auto-blacklisted`,
      added_at: new Date().toISOString(),
      auto: true
    };
    writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
    log('AUTO-BLACKLIST', `${pair} (${key}) ADDED - Loss ${pnl.toFixed(2)}%`);
    return true;
  }
  return false;
}

export async function analyzeWinPattern({ pnl, age, feeEarned, inRangePercent }) {
  const patterns = [];
  
  if (age < 5) patterns.push('fast_win');
  if (age >= 10 && age <= 15) patterns.push('slow_win');
  if (feeEarned && pnl && feeEarned > pnl * 0.5) patterns.push('fee_king');
  if (inRangePercent && inRangePercent > 90) patterns.push('in_range_master');
  if (inRangePercent > 80 && age < 8) patterns.push('perfect_entry');
  
  return patterns;
}

export async function addWinLesson(closeInfo, patterns) {
  for (const pattern of patterns) {
    const template = WIN_PATTERNS[pattern];
    if (!template) continue;
    
    const lesson = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36),
      created_at: new Date().toISOString(),
      outcome: 'win_pattern',
      rule: template.lesson,
      tags: template.tags,
      context: { pool: closeInfo.pool, pnl: closeInfo.pnl, age: closeInfo.age, pattern }
    };
    
    lessons.push(lesson);
    log('WIN-LESSON', `Pattern: ${pattern} - ${template.lesson}`);
  }
  await saveLessons();
}

export async function addTIRLesson({ pool, pnl, tirStats }) {
  if (!tirStats) return;
  
  const inRangePercent = parseFloat(tirStats.inRangePercent);
  const outOfRangePercent = parseFloat(tirStats.outOfRangePercent);
  
  let template = null;
  
  if (outOfRangePercent > 50) {
    template = TIR_LESSONS.oor_heavy;
  } else if (inRangePercent < 70) {
    template = TIR_LESSONS.poor_tir;
  } else if (inRangePercent >= 90) {
    template = TIR_LESSONS.good_tir;
  }
  
  if (template) {
    const lessonText = template.lesson
      .replace('{inRangePercent}', inRangePercent.toFixed(1))
      .replace('{outOfRangePercent}', outOfRangePercent.toFixed(1));
    
    const lesson = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36),
      created_at: new Date().toISOString(),
      outcome: 'tir',
      rule: lessonText,
      tags: template.tags,
      context: { pool, pnl, tirStats }
    };
    
    lessons.push(lesson);
    log('TIR-LESSON', lessonText);
    await saveLessons();
  }
}
