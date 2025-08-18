import { execSync } from 'child_process';
import { MinerApiConfigUtil } from './miner-api-config.util';

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
      // Use dynamic endpoint discovery
      const endpoint = MinerApiConfigUtil.getCcminerApiEndpoint();
      const poolRaw = execSync(`echo 'pool' | nc -w 1 ${endpoint}`, {
        encoding: 'utf8',
      });

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
        uptime: parseInt(parsed.UPTIME) || 0,
        // Note: difficulty moved to minerSoftware section in telemetry service
        difficulty: parseFloat(parsed.DIFF) || 0, // Keep for now as telemetry service still reads it
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
        uptime: 0,
        difficulty: 0
      };
    }
  }  
  
    /** ✅ Get XMRig pool info */
  private static async getXmrigPoolInfo(): Promise<any> {
    try {
      // Use dynamic endpoint discovery with multiple API attempts
      const baseUrl = MinerApiConfigUtil.getXmrigApiUrl();
      
      console.log(`🔍 Attempting XMRig API connection to: ${baseUrl}`);
      
      // Try the main endpoint first
      const response = await fetch(`${baseUrl}/1/summary`, {
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      
      if (!response.ok) {
        console.log(`❌ XMRig API responded with status ${response.status}`);
        return this.getDefaultPoolInfo();
      }
      
      const json = await response.json();
      console.log(`✅ XMRig API responded successfully`);
      
      // Parse the actual API response structure based on your example
      const poolData = {
        name: json.connection?.pool || 'unknown',
        url: json.connection?.pool || 'unknown', 
        user: 'unknown', // User not exposed in summary API
        acceptedShares: parseInt(json.connection?.accepted || '0'),
        rejectedShares: parseInt(json.connection?.rejected || '0'),
        staleShares: 0, // Not available in XMRig API
        ping: parseInt(json.connection?.ping || '0'),
        uptime: parseInt(json.connection?.uptime || '0'),
        difficulty: parseFloat(json.connection?.diff || '0') || 0,
        // Additional pool info from the API
        poolIp: json.connection?.ip || 'unknown',
        tlsVersion: json.connection?.tls || 'none',
        algorithm: json.connection?.algo || json.algo || 'unknown',
        failures: parseInt(json.connection?.failures || '0'),
      };

      console.log(`✅ XMRig pool data parsed:`, poolData);
      return poolData;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ XMRig pool info failed: ${errorMessage}`);
      
      // Log additional debugging info
      if (process.env.DEBUG === 'true') {
        console.debug('XMRig API error details:', error);
      }
      
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

  /** ✅ Default pool info fallback */  private static getDefaultPoolInfo(): any {
    return {
      name: 'unknown',
      url: 'unknown',
      user: 'unknown',
      acceptedShares: 0,
      rejectedShares: 0,
      staleShares: 0,
      ping: 0,
      uptime: 0,
      difficulty: 0
    };
  }
}
