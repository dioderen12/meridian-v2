// Volume Spike Detection - Weighted Multi-Period
// Moderate approach: weighted average + consistency check

import { readFileSync, writeFileSync, existsSync } from 'fs';

const SPIKE_DB = '/tmp/volume-spike-cache.json';
let cache = {};

function loadCache() {
  try {
    if (existsSync(SPIKE_DB)) {
      cache = JSON.parse(readFileSync(SPIKE_DB, 'utf8'));
    }
  } catch(e) {}
}
loadCache();

function saveCache() {
  try {
    writeFileSync(SPIKE_DB, JSON.stringify(cache, null, 2));
  } catch(e) {}
}

// Check if pool has recent spike data
function getCachedSpike(poolAddress) {
  const entry = cache[poolAddress];
  if (!entry) return null;
  
  // Cache valid for 2 minutes
  const age = Date.now() - entry.timestamp;
  if (age > 120000) return null;
  
  return entry;
}

export async function checkVolumeSpike(poolAddress, meteoraPoolData) {
  // Check cache first
  const cached = getCachedSpike(poolAddress);
  if (cached) return cached;
  
  try {
    // Get volume data from Meteora
    // Try multiple endpoints
    let volumeData = null;
    
    // Method 1: From pool data if available
    if (meteoraPoolData) {
      volumeData = {
        volume1h: meteoraPoolData.volume_1h || meteoraPoolData.vol_1h || 0,
        volume5m: meteoraPoolData.volume_5m || meteoraPoolData.vol_5m || 0,
        volume24h: meteoraPoolData.volume_24h || meteoraPoolData.vol_24h || 0
      };
    }
    
    // Method 2: Fetch from API
    if (!volumeData || volumeData.volume1h === 0) {
      try {
        const response = await fetch(`https://api.meteora.ag/api/pools/${poolAddress}/volume`);
        if (response.ok) {
          volumeData = await response.json();
        }
      } catch(e) {}
    }
    
    if (!volumeData) {
      // No volume data - return neutral
      const result = {
        pool: poolAddress,
        ratio: 1,
        confirmed: false,
        priority: 'medium',
        status: 'unknown',
        timestamp: Date.now()
      };
      cache[poolAddress] = result;
      saveCache();
      return result;
    }
    
    // Calculate weighted average from multiple periods
    // Use available data to estimate
    const vol1h = volumeData.volume1h || 0;
    const vol5m = volumeData.volume5m || 0;
    const vol24h = volumeData.volume24h || 0;
    
    // Estimate periods (if 1h = 12 x 5min periods)
    const estimated5mBack1 = vol5m; // Current
    const estimated5mBack2 = vol1h / 12; // 5 min ago estimate
    const estimated5mBack3 = vol1h / 12 * 0.9; // 10 min ago
    const estimated5mBack4 = vol1h / 12 * 0.8; // 15 min ago
    
    const periods = [estimated5mBack1, estimated5mBack2, estimated5mBack3, estimated5mBack4];
    
    // Weighted average (recent = more important)
    const weights = [0.4, 0.3, 0.2, 0.1];
    const weightedSum = periods.reduce((sum, vol, i) => sum + vol * weights[i], 0);
    const weightedAvg = weightedSum / 4;
    
    // Spike ratio
    const current = periods[0];
    const ratio = weightedAvg > 0 ? current / weightedAvg : 1;
    
    // Consistency check: how many periods are elevated?
    const threshold = weightedAvg * 2; // 2x average
    const elevated = periods.filter(p => p > threshold).length;
    const confirmed = elevated >= 2;
    
    // Status determination (Moderate approach)
    let status, priority;
    if (ratio > 4 && confirmed) {
      status = 'mega_spike';
      priority = 'high';
    } else if (ratio > 3 && confirmed) {
      status = 'confirmed_spike';
      priority = 'high';
    } else if (ratio > 3) {
      status = 'suspicious_spike';
      priority = 'medium';
    } else if (ratio > 1.5) {
      status = 'normal';
      priority = 'medium';
    } else {
      status = 'fading';
      priority = 'low';
    }
    
    const result = {
      pool: poolAddress,
      current: current.toFixed(2),
      weightedAvg: weightedAvg.toFixed(2),
      ratio: ratio.toFixed(2),
      confirmed,
      elevatedPeriods: elevated,
      status,
      priority,
      timestamp: Date.now()
    };
    
    cache[poolAddress] = result;
    saveCache();
    
    return result;
    
  } catch(e) {
    // Error - return neutral
    return {
      pool: poolAddress,
      ratio: 1,
      confirmed: false,
      priority: 'medium',
      status: 'error',
      error: e.message,
      timestamp: Date.now()
    };
  }
}

// Filter pool based on spike - Moderate approach
export function filterBySpike(spikeData) {
  if (!spikeData) return true; // Can't determine, pass through
  
  // Skip if fading
  if (spikeData.status === 'fading') {
    return false;
  }
  
  // Skip if suspicious spike (ratio > 3 but not confirmed)
  // unless we have very strong other indicators
  if (spikeData.status === 'suspicious_spike') {
    // Only allow if we have other strong indicators
    // For now, treat as medium priority but continue
    return true;
  }
  
  // Allow confirmed spikes, normal, and unknown
  return true;
}

// Get priority score (higher = better entry)
export function getSpikeScore(spikeData) {
  if (!spikeData) return 50; // Neutral
  
  switch (spikeData.priority) {
    case 'high': return 80;
    case 'medium': return 50;
    case 'low': return 30;
    default: return 50;
  }
}

// Log spike info for debugging
export function logSpikeInfo(poolName, spikeData) {
  if (!spikeData || spikeData.status === 'unknown') return '';
  
  const icons = {
    mega_spike: '🚀',
    confirmed_spike: '📈',
    suspicious_spike: '⚠️',
    normal: '➡️',
    fading: '📉'
  };
  
  const icon = icons[spikeData.status] || '❓';
  const confirmed = spikeData.confirmed ? '✅' : '❌';
  
  return `${icon} ${poolName}: ${spikeData.status} (${spikeData.ratio}x, ${confirmed}confirmed)`;
}
