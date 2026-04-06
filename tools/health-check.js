// Health Check System
// Track bot health and report issues

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HEALTH_FILE = join(process.cwd(), 'health-check.json');

export function getHealthStatus() {
  const data = {
    timestamp: new Date().toISOString(),
    bot: {
      running: true,
      pid: process.pid,
      uptime: process.uptime()
    },
    emergency_stop: existsSync(join(process.cwd(), 'EMERGENCY_STOP')),
    position: null,
    daily_pnl: null,
    issues: []
  };
  
  // Check if bot is running
  try {
    const state_file = join(process.cwd(), 'state.json');
    if (existsSync(state_file)) {
      const state = JSON.parse(readFileSync(state_file, 'utf8'));
      data.position = state.positions?.length || 0;
    }
  } catch(e) {}
  
  // Check daily PnL
  try {
    const daily_file = join(process.cwd(), 'daily-pnl.json');
    if (existsSync(daily_file)) {
      const daily = JSON.parse(readFileSync(daily_file, 'utf8'));
      data.daily_pnl = daily;
    }
  } catch(e) {}
  
  // Check for issues
  if (data.emergency_stop) {
    data.issues.push('Emergency stop ACTIVE');
  }
  if (data.position > 0) {
    data.issues.push('Has open position');
  }
  
  return data;
}

export function logHealth() {
  const health = getHealthStatus();
  console.log('[HEALTH]', JSON.stringify({
    time: health.timestamp,
    position: health.position,
    emergency: health.emergency_stop,
    daily_pnl: health.daily_pnl?.pnl || 0,
    issues: health.issues.length
  }));
}

// Auto health check every 5 minutes
setInterval(logHealth, 5 * 60 * 1000);
