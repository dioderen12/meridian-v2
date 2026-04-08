import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isPoolBlacklisted } from "../pool-blacklist.js";
import { log } from "../logger.js";
import { recallForPool } from "../pool-memory.js";
import { isDeployerBlacklisted } from "./deployer-blacklist.js";
import { checkVolumeSpike, filterBySpike, getSpikeScore, logSpikeInfo } from "./volume-spike.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Filter blacklisted base tokens
  const pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) {
    log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens`);
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  console.log('[SCREENING] getTopCandidates called - fetching from Meteora...');
  
  let pools = [];
  try {
    const { pools: rawPools } = await discoverPools({ page_size: 100 });
    console.log('[SCREENING] Raw pools from API:', rawPools?.length || 0);
    pools = rawPools || [];
  } catch(e) {
    console.log('[SCREENING] discoverPools failed:', e.message);
  }

  // Exclude pools where the wallet already has an open position
  // CRITICAL: Make this resilient - don't let getMyPositions failure break entire screening
  let occupiedPools = new Set();
  let occupiedMints = new Set();
  try {
    const { getMyPositions } = await import("./dlmm.js");
    const { positions } = await getMyPositions().catch(() => ({ positions: [] }));
    occupiedPools = new Set(positions.map((p) => p.pool));
    occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  } catch(e) {
    // If getMyPositions fails, continue without position filtering
    console.log('[SCREENING] Warning: Could not check existing positions:', e.message);
  }

  const eligible = pools
    .filter((p) => !occupiedPools.has(p.pool) && !occupiedMints.has(p.base?.mint))
    .filter((p) => !isPoolBlacklisted(p.pool))
    .slice(0, limit);

  // CRITICAL: Record all eligible pools in screening cache so DEPLOY GATE passes
  // This ensures getTopCandidates pools can be deployed (same as getV2Candidates)
  for (const pool of eligible) {
    recordScreeningResult(pool.pool_address, {
      pool: pool.pool_address,
      name: pool.name,
      mcap: pool.token_x?.market_cap || 0,
      organic_score: pool.token_x?.organic_score || 0,
      holders: pool.token_x?.holders || 0,
      fee: pool.fee || 0,
      fee_pct: pool.fee_pct || 0,
      volume: pool.volume || 0,
      tvl: pool.tvl || 0,
      bin_step: pool.dlmm_params?.bin_step || 0,
      pool_type: pool.pool_type,
      token_address: pool.token_x?.address,
    }, true); // Mark as passed=true so DEPLOY GATE allows deployment
  }

  console.log('[SCREENING] Eligible pools after position filter:', eligible.length);
  console.log('[SCREENING] Returning candidates:', eligible.slice(0, limit).map(p => p.name).join(', ') || 'none');
  
  return {
    candidates: eligible,
    total_screened: pools.length,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
        fee_yield: p.fee_active_tvl_ratio > 0 ? p.fee_active_tvl_ratio : (p.fee > 0 && p.tvl > 0 ? (p.fee / p.tvl) * 100 : 0),
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

/**
 * Comprehensive v2 Pool Scanner
 * Fetches from multiple sources and filters with v2 criteria
 */
export async function getV2Candidates({ limit = 20 } = {}) {
  const { config } = await import("../config.js");
  
  log("scanner", "Starting comprehensive v2 pool scan...");
  
  // v2 thresholds
  const minMcap = config.screening.minMcap || 150000;
  const maxMcap = config.screening.maxMcap || 1000000;
  const minOrganic = config.screening.minOrganic || 65;
  const minHolders = config.screening.minHolderCount || 500;
  const minFee = 0.1; // SOL fees - minimum reasonable pool activity
  const minFeePct = config.screening.minFeePct || 2; // GE: 2-10% fee filter
  const maxFeePct = config.screening.maxFeePct || 10;
  
  try {
    // Fetch ALL pools from Meteora without API filters (filters not reliable)
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=500&timeframe=${config.screening.timeframe || "5m"}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    
    const data = await res.json();
    const rawPools = data.data || [];
    log("scanner", `Meteora: fetched ${rawPools.length} raw pools`);
    
    // Apply v2 filters LOCALLY with correct field paths
    const v2Candidates = [];
    
    for (const p of rawPools) {
      const tokenX = p.token_x || {};
      const mcap = tokenX.market_cap || tokenX.mcap || 0;
      const org = tokenX.organic_score || 0;
      const holders = tokenX.holders || p.base_token_holders || 0;
      const fee = p.fee || 0;
      const tokenAgeHours = tokenX.age_hours || tokenX.token_age_hours || 0;
      
      // v2 filters
      const feePct = p.fee_pct || 0; // fee percentage from pool
      const v2Passed = 
        mcap >= minMcap && mcap <= maxMcap &&
        org >= minOrganic &&
        holders >= minHolders &&
        fee >= minFee &&
        feePct >= minFeePct && feePct <= maxFeePct && // GE: 2-10% fee filter
        !isBlacklisted(tokenX.address) &&
        !isPoolBlacklisted(p.pool_address) &&
        tokenAgeHours >= 0.5 && tokenAgeHours <= 720;
      
      // Check deployer blacklist
      const deployer = p.creator || p.deployer || p.creator_address || null;
      const isBlockedDeployer = deployer ? await isDeployerBlacklisted(deployer) : false;
      
      // Block if pool is blacklisted
      if (isPoolBlacklisted(p.pool_address)) {
        log("scanner", `Filtered ${p.name} - pool is BLACKLISTED`);
        continue;
      }
      
      // Record ALL pools in cache (both passing and failing)
      // This allows executor to check if pool was screened even if vol=0 from single-query
      const poolData = {
        pool: p.pool_address,
        name: p.name,
        mcap,
        organic_score: org,
        holders,
        fee,
        fee_pct: feePct, // GE: 2-10% fee filter
        volume: p.volume || 0,
        tvl: p.tvl || 0,
        bin_step: p.dlmm_params?.bin_step || 0,
        pool_type: p.pool_type,
        fee_yield: p.fee_active_tvl_ratio > 0 ? p.fee_active_tvl_ratio : (p.fee > 0 && p.tvl > 0 ? (p.fee / p.tvl) * 100 : 0),
        token_address: tokenX.address,
      };
      recordScreeningResult(p.pool_address, poolData, v2Passed);
      
      if (!v2Passed) {
        if (mcap < minMcap || mcap > maxMcap) {
          log("scanner", `Filtered ${p.name} - mcap ${(mcap/1000).toFixed(0)}K outside range`);
        }
        if (org < minOrganic) {
          log("scanner", `Filtered ${p.name} - organic ${org}% below ${minOrganic}%`);
        }
        if (holders < minHolders) {
          log("scanner", `Filtered ${p.name} - holders ${holders} below ${minHolders}`);
        }
        if (isBlacklisted(tokenX.address)) {
          log("scanner", `Filtered ${p.name} - blacklisted`);
        }
        if (isBlockedDeployer) {
          log("scanner", `Filtered ${p.name} - deployer ${deployer?.slice(0,10)}... is BLOCKED`);
        }
        if (tokenAgeHours > 0 && tokenAgeHours > 720) {
          log("scanner", `Filtered ${p.name} - token age ${tokenAgeHours}h > 720h (max 30 days)`);
        }
        if (feePct > 0 && (feePct < minFeePct || feePct > maxFeePct)) {
          log("scanner", `Filtered ${p.name} - fee_pct ${feePct.toFixed(1)}% outside ${minFeePct}-${maxFeePct}% range`);
        }
        continue;
      }
      
      // 🚨 RUG SUSPECT DETECTION: Check for volume manipulation
      // Scammers fake volume to attract LPs - detect artificial volume spikes
      // 🚨 HARD CHECK: Volume must be >= $1000 USD (V2 STRATEGY)
      const volume = p.volume || 0;
      const SOL_PRICE_USD = 84; // Approximate SOL price
      const minRequiredVolumeUSD = 1000; // $1000 USD minimum
      const minRequiredVolumeSOL = minRequiredVolumeUSD / SOL_PRICE_USD; // Convert to SOL
      if (volume < minRequiredVolumeSOL) {
        log('scanner', 'Filtered ' + p.name + ' - volume ' + volume.toFixed(1) + ' SOL (~$' + (volume * SOL_PRICE_USD).toFixed(0) + ') < $' + minRequiredVolumeUSD + ' USD (HARD REQUIRED)');
        continue;
      }
      
      // 🚨 HARD CHECK: Dead pool detection - volume must be > 0
      if (volume === 0) {
        log("scanner", `Filtered ${p.name} - DEAD POOL (volume = 0)`);
        continue;
      }
      
      // 🚨 HARD CHECK: Volatility must be < 0.03 (3%) for stability
      // High volatility = price swings fast = high OOR risk
      const volatility = p.volatility || 0;
      if (volatility >= 0.03) {
        log("scanner", `Filtered ${p.name} - volatility ${(volatility * 100).toFixed(1)}% >= 3% (TOO VOLATILE)`);
        continue;
      }
      
      // 🚨 HARD CHECK: Check pool history from memory
      // Skip pools with avgPnl < -10% (consistently losing)
      const poolHistory = getPoolMemory(p.pool_address);
      if (poolHistory && poolHistory.avg_pnl_pct < -10) {
        log("scanner", `Filtered ${p.name} - avgPnl ${poolHistory.avg_pnl_pct.toFixed(2)}% < -10% (BAD HISTORY)`);
        continue;
      }
      
      // 🚨 HARD CHECK: Skip if deployed to this pool recently (within 30 min)
      if (isRecentlyDeployed(p.pool_address)) {
        log("scanner", `Filtered ${p.name} - recently deployed (cooldown active)`);
        continue;
      }
      
      const volumeToMcapRatio = volume > 0 && mcap > 0 ? (volume * 100) / (mcap / 1000) : 0; // volume as % of mcap
      const isSuspiciousVolume = volumeToMcapRatio > 5; // volume > 5% of mcap is suspicious
      
      // Also check: very high volume but low organic = manipulation likely
      const isLowOrganicHighVolume = org < 50 && volume > 500; // Low organic but high volume SOL
      const isRugSuspect = isSuspiciousVolume || isLowOrganicHighVolume;
      
      if (isRugSuspect) {
        log("scanner", `⚠️ RUG SUSPECT: ${p.name} - Vol/Mcap: ${volumeToMcapRatio.toFixed(1)}%, Org: ${org}%, Vol: ${volume.toFixed(1)} SOL - VOLUME MANIPULATION DETECTED!`);
        // Record as rug suspect in pool memory for future reference
        try {
          const { addPoolNote } = await import('../pool-memory.js');
          await addPoolNote(p.pool_address, 'rug_suspect', `Volume manipulation detected: Vol/Mcap=${volumeToMcapRatio.toFixed(1)}%, Org=${org}%`);
        } catch(e) {}
        // Don't block - just flag for awareness in lesson
      }
      
      // POOL COOLDOWN + TIR SCREENING: Skip pools with bad history or low TIR
      const poolMem = recallForPool(p.pool_address);
      if (poolMem && poolMem.last_deployed_at) {
        const lastDeploy = new Date(poolMem.last_deployed_at).getTime();
        const now = Date.now();
        const minutesSince = (now - lastDeploy) / 1000 / 60;
        
        // Check avgPnl history
        if (poolMem.avg_pnl_pct < 0) {
          log("scanner", `Filtered ${p.name} - bad history (avgPnl ${poolMem.avg_pnl_pct}%)`);
          continue;
        }
        
        // Check TIR history (avg_tir_pct)
        if (poolMem.avg_tir_pct !== undefined && poolMem.avg_tir_pct < 50) {
          log("scanner", `Filtered ${p.name} - poor TIR history (avgTIR ${poolMem.avg_tir_pct}%)`);
          continue;
        }
        
        // Check Volume Spike (MODERATE approach - filter fading only)
        try {
          const spikeData = await checkVolumeSpike(p.pool_address, p);
          if (!filterBySpike(spikeData)) {
            log("scanner", `Filtered ${p.name} - volume fading (${spikeData?.ratio}x, not confirmed)`);
            continue;
          }
          // Add spike score to pool data
          poolData.spikeData = spikeData;
          poolData.spikeScore = getSpikeScore(spikeData);
        } catch(e) {
          // Volume spike check failed - continue anyway
          log("scanner", `Spike check failed for ${p.name}: ${e.message}`);
        }
        
        // Cooldown check
        if (minutesSince < 10) {
          log("scanner", `Filtered ${p.name} - deployed ${Math.round(minutesSince)}m ago (within 10min cooldown)`);
          continue;
        }
      }
      
      v2Candidates.push(poolData);
    }
    
    log("scanner", `Pools passing v2 filters: ${v2Candidates.length}`);
    
    // Sort by FEE YIELD + SPIKE SCORE (prioritas pool dengan fee tinggi + volume spike)
    v2Candidates.sort((a, b) => {
      const feeScoreA = (a.fee_yield || 0) * Math.log10(a.mcap + 1);
      const feeScoreB = (b.fee_yield || 0) * Math.log10(b.mcap + 1);
      const spikeBonusA = (a.spikeScore || 50) * 0.5; // Spike bonus
      const spikeBonusB = (b.spikeScore || 50) * 0.5;
      const totalScoreA = feeScoreA + spikeBonusA;
      const totalScoreB = feeScoreB + spikeBonusB;
      return totalScoreB - totalScoreA;
    });
    
    return {
      candidates: v2Candidates.slice(0, limit),
      total_screened: rawPools.length,
      pools_passed: v2Candidates.length,
      sources: ["Meteora Pool Discovery API"],
      filters: { minMcap, maxMcap, minOrganic, minHolders, minFee },
    };
  } catch(e) {
    log("scanner", `Error: ${e.message}`);
    return {
      candidates: [],
      total_screened: 0,
      pools_passed: 0,
      sources: ["Meteora Pool Discovery API"],
      error: e.message,
    };
  }
}

/**
 * Screening Cache - tracks pools that have been screened
 * Used to safely handle vol=0 from single-pool API calls
 */
const screeningCache = new Map(); // pool_address -> { volume, mcap, organic, holders, timestamp, passed }

export function recordScreeningResult(pool_address, data, passed) {
  screeningCache.set(pool_address, {
    volume: data.volume || 0,
    mcap: data.mcap || 0,
    organic: data.organic_score || 0,
    holders: data.holders || 0,
    timestamp: Date.now(),
    passed,
  });
  // Keep cache size manageable
  if (screeningCache.size > 1000) {
    const oldest = Array.from(screeningCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, 100);
    oldest.forEach(([k]) => screeningCache.delete(k));
  }
}

// CRITICAL: Get screening result for a pool - used to verify pool was properly screened before deploy
export function getScreeningResult(pool_address) {
  return screeningCache.get(pool_address);
}

// CRITICAL: Check if pool was recently screened (within 15 min)
export function wasRecentlyScreened(pool_address, maxAgeMs = 900000) {
  const result = screeningCache.get(pool_address);
  if (!result) return false;
  return (Date.now() - result.timestamp) < maxAgeMs;
}

// CRITICAL: Verify pool passed V2 filters
export function verifyPoolPassedV2Filters(pool_address) {
  const result = screeningCache.get(pool_address);
  return result?.passed === true;
}

export function getCachedScreeningResult(pool_address) {
  return screeningCache.get(pool_address) || null;
}

export function clearScreeningCache() {
  screeningCache.clear();
}

// ─── VOLUME TRAJECTORY ANALYSIS ──────────────────────────────────────────────
// Check if volume is increasing or decreasing
export async function getVolumeTrajectory(poolAddress) {
  try {
    // Get historical volume data from Meteora
    const response = await fetch(`https://api.meteora.ag/api/pools/${poolAddress}/volume`);
    if (!response.ok) return null;
    
    const data = await response.json();
    
    // Calculate volume change over time
    const volumes = data.volume_24h || [];
    if (volumes.length < 2) return null;
    
    const recent = volumes.slice(0, 6);  // Last 6 periods
    const older = volumes.slice(6, 12);   // Previous 6 periods
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;
    
    return {
      recentAvg,
      olderAvg,
      changePercent,
      trajectory: changePercent > 20 ? 'increasing' : changePercent < -20 ? 'decreasing' : 'stable'
    };
  } catch(e) {
    return null;
  }
}

// ─── VOLUME TRAJECTORY FILTER ────────────────────────────────────────────────
// Filter out pools with fading volume
export function filterByVolumeTrajectory(pool, trajectory) {
  if (!trajectory) return true; // Can't determine, pass through
  
  // If volume is decreasing > 30%, likely a bad entry
  if (trajectory.changePercent < -30) {
    log("screening", `Filtered ${pool.name} - volume fading (${trajectory.changePercent.toFixed(1)}%)`);
    return false;
  }
  
  return true;
}
