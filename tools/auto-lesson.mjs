// Auto-Lesson System - ESM Module
// Records lessons from every close

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = join(__dirname, '..', 'lessons.json');
const BLACKLIST_FILE = join(__dirname, '..', 'pool-blacklist.json');

let lessons = [];
let blacklist = { v2: {} };

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
  } catch(e) {
    console.log('[LESSONS] Load error:', e.message);
  }
}
loadData();

async function saveLessons() {
  try {
    const data = { lessons, performance: {} };
    writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.log('[LESSONS] Save error:', e.message);
  }
}

function log(prefix, msg) {
  console.log(`[${prefix}] ${msg}`);
}

const EXIT_REASON_LESSONS = {
  stop_loss: { tags: ['bad', 'stop_loss', 'loss'], lesson: 'Stopped out at -5%' },
  take_profit: { tags: ['good', 'take_profit', 'win'], lesson: 'Took profit at +10%' },
  max_hold: { tags: ['neutral', 'max_hold', 'completed'], lesson: 'Held for full 15 minutes' },
  oor: { tags: ['bad', 'oor', 'out_of_range'], lesson: 'Position went out of range' },
  oor_immediate: { tags: ['bad', 'scam', 'immediate_oor'], lesson: 'Immediate OOR - potential rug!' }
};

const TIR_LESSONS = {
  poor_tir: { tags: ['poor-tir', 'unstable', 'risky'], lesson: 'Pool only {inRangePercent}% in range' },
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
  const template = EXIT_REASON_LESSONS[reason];
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
  log('LESSONS', `Added lesson for ${pair}: ${reason}`);
  await saveLessons();
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

export async function analyzeWinPattern({ pnl, age, feeEarned, poolStats, entryPrice, exitPrice, inRangePercent }) {
  const patterns = [];
  
  if (age < 5) patterns.push('fast_win');
  if (age >= 10 && age <= 15) patterns.push('slow_win');
  if (feeEarned && pnl && feeEarned > pnl * 0.5) patterns.push('fee_king');
  if (inRangePercent && inRangePercent > 90) patterns.push('in_range_master');
  if (entryPrice && exitPrice && inRangePercent > 80 && age < 8) patterns.push('perfect_entry');
  
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
