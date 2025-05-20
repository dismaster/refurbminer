import { execSync } from 'child_process';

export class MinerPoolUtil {
  /** ✅ Get miner pool details based on detected miner */
  static async getPoolStatistics(): Promise<any> {
    const miner = this.detectMiner();

    if (!miner) {
      return this.getDefaultPoolInfo();
    }

    return miner === 'ccminer'
      ? this.getCcminerPoolInfo()
      : await this.getXmrigPoolInfo();
  }

  /** ✅ Detect which miner is running */
  private static detectMiner(): string | null {
    try {
      const runningProcesses = execSync('ps aux', { encoding: 'utf8' });

      if (runningProcesses.includes('ccminer')) return 'ccminer';
      if (runningProcesses.includes('xmrig')) return 'xmrig';

      return null;
    } catch {
      return null;
    }
  }

  private static getCcminerPoolInfo(): any {
    try {
      // Use same pattern as in summary and threads collection
      const poolRaw = execSync(`echo 'pool' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });

      if (!poolRaw || !poolRaw.trim()) {
        return this.getDefaultPoolInfo();
      }

      const parsed = this.parseCcminerOutput(poolRaw);

      return {
        name: parsed.POOL || 'unknown',
        url: parsed.URL || 'unknown',
        user: parsed.USER || 'unknown',
        acceptedShares: parseInt(parsed.ACC) || 0,
        rejectedShares: parseInt(parsed.REJ) || 0,
        staleShares: parseInt(parsed.STALE) || 0, 
        ping: parseInt(parsed.PING) || 0,
        uptime: parseInt(parsed.UPTIME) || 0
      };
    } catch (error) {
      // Instead of logging the error, handle it silently
      // Only log detailed errors in debug mode
      if (process.env.DEBUG === 'true') {
        console.debug('CCMiner API not responsive:', error.message);
      }
      
      // Return default pool info with zeros for statistics
      return {
        name: 'RefurbMiner Verus Pool',  // Use default pool name
        url: 'stratum+tcp://pool.refurbminer.de:3956',  // Use default URL
        user: 'unknown',
        acceptedShares: 0,
        rejectedShares: 0,
        staleShares: 0,
        ping: 0,
        uptime: 0
      };
    }
  }

  /** ✅ Get XMRig pool info */
  private static async getXmrigPoolInfo(): Promise<any> {
    try {
      const response = await fetch(`http://127.0.0.1:4067/summary`);
      if (!response.ok) return this.getDefaultPoolInfo();

      const json = await response.json();
      return {
        name: json.connection.pool || 'unknown',
        url: json.connection.pool || 'unknown',
        user: 'unknown',
        acceptedShares: parseInt(json.results.shares_good || '0'),
        rejectedShares: parseInt((json.results.shares_total - json.results.shares_good).toString() || '0'),
        staleShares: 0,
        ping: parseInt(json.connection.ping || '0'),
        uptime: parseInt(json.connection.uptime || '0')
      };
    } catch {
      return this.getDefaultPoolInfo();
    }
  }

/** ✅ Parse CCMiner output */
private static parseCcminerOutput(output: string): any {
  try {
    const parsed: any = {};
    const pairs = output.trim().split(';');

    for (const pair of pairs) {
      if (!pair.trim()) continue;
      const [key, ...valueParts] = pair.trim().split('=');
      if (key && valueParts.length) {
        parsed[key.trim()] = valueParts.join('=').trim();
      }
    }

    return parsed;
  } catch (error) {
    console.error('CCMiner parse error:', error); // Debug log
    return {};
  }
}

  /** ✅ Default pool info fallback */
  private static getDefaultPoolInfo(): any {
    return {
      name: 'unknown',
      url: 'unknown',
      user: 'unknown',
      acceptedShares: 0,
      rejectedShares: 0,
      staleShares: 0,
      ping: 0,
      uptime: 0
    };
  }
}
