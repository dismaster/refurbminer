import { execSync } from 'child_process';
import { MinerApiConfigUtil } from './miner-api-config.util';

export class MinerSummaryUtil {
  /** ✅ Get miner summary based on detected miner */
  static async getMinerSummary(): Promise<any> {
    const miner = this.detectMiner();

    if (!miner) {
      return this.getDefaultSummary();
    }

    return miner === 'ccminer'
      ? this.getCcminerSummary()
      : await this.getXmrigSummary();
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
  /** ✅ Get CCMiner summary */
  private static getCcminerSummary(): any {
    try {
      const endpoint = MinerApiConfigUtil.getCcminerApiEndpoint();
      const summaryRaw = execSync(`echo 'summary' | nc -w 1 ${endpoint}`, {
        encoding: 'utf8',
      });
      const parsed = this.parseCcminerOutput(summaryRaw);

      return {
        name: 'ccminer',
        version: parsed.VER || 'unknown',
        algorithm: parsed.ALGO || 'unknown',
        // Convert kilohash to hash by multiplying by 1000
        hashrate: (parseFloat(parsed.KHS) || 0) * 1000,
        acceptedShares: parseInt(parsed.ACC) || 0,
        rejectedShares: parseInt(parsed.REJ) || 0,
        uptime: parseInt(parsed.UPTIME) || 0,
        averageShareRate: parseFloat(parsed.ACCMN) || 0,
        solvedBlocks: parseInt(parsed.SOLV) || 0,
      };
    } catch {
      return this.getDefaultSummary();
    }
  }
  
  /** ✅ Get XMRig summary */
  private static async getXmrigSummary(): Promise<any> {
    try {
      const baseUrl = MinerApiConfigUtil.getXmrigApiUrl();
      const response = await fetch(`${baseUrl}/1/summary`, {
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return this.getDefaultSummary();

      const json = await response.json();
      
      // Parse based on the actual API response structure you provided
      return {
        name: 'xmrig',
        version: json.version || 'unknown',
        algorithm: json.algo || json.connection?.algo || 'unknown',
        hashrate: parseFloat(json.hashrate?.total?.[0] || 0), // Current hashrate (first value)
        acceptedShares: parseInt(json.connection?.accepted || json.results?.shares_good || '0'),
        rejectedShares: parseInt(json.connection?.rejected || '0'),
        uptime: parseInt(json.uptime || '0'), // Main uptime, not connection uptime
        averageShareRate: parseFloat(json.results?.avg_time_ms || json.connection?.avg_time_ms || '0') / 1000,
        solvedBlocks: 0, // Not available in this API
        // Additional fields from the API
        difficulty: parseFloat(json.connection?.diff || json.results?.diff_current || '0'),
        totalHashes: parseInt(json.results?.hashes_total || json.connection?.hashes_total || '0'),
        highestHashrate: parseFloat(json.hashrate?.highest || '0'),
        hugePagesEnabled: json.hugepages || false,
        cpuBrand: json.cpu?.brand || 'unknown',
        cpuThreads: parseInt(json.cpu?.threads || '0'),
      };
    } catch {
      return this.getDefaultSummary();
    }
  }

  /** ✅ Parse CCMiner output */
  private static parseCcminerOutput(output: string): any {
    const parsed: any = {};
    const regex = /(\w+)=([\w\d.]+)/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      parsed[match[1]] = match[2];
    }

    return parsed;
  }

  /** ✅ Default summary fallback */
  private static getDefaultSummary(): any {
    return {
      name: 'unknown',
      version: 'unknown',
      algorithm: 'unknown',
      hashrate: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      uptime: 0,
      averageShareRate: 0,
      solvedBlocks: 0
    };
  }
}
