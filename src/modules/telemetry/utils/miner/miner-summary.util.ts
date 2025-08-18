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
    const maxRetries = 3;
    const timeoutMs = 10000; // Increased to 10 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const baseUrl = MinerApiConfigUtil.getXmrigApiUrl();
        
        if (attempt > 1) {
          console.log(`🔄 XMRig summary retry attempt ${attempt}/${maxRetries}`);
        }
        
        // Manual timeout control for better error handling
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        const response = await fetch(`${baseUrl}/1/summary`, {
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          if (attempt < maxRetries) {
            console.warn(`⚠️ XMRig summary API status ${response.status} (attempt ${attempt}) - retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          }
          return this.getDefaultSummary();
        }

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
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('aborted');
        
        if (attempt < maxRetries) {
          console.warn(`⚠️ XMRig summary attempt ${attempt} failed: ${errorMessage} - retrying...`);
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        
        if (isTimeout) {
          console.error(`🕐 XMRig summary timeout after ${maxRetries} attempts - API may be slow`);
        } else {
          console.error(`❌ XMRig summary failed after ${maxRetries} attempts: ${errorMessage}`);
        }
        
        return this.getDefaultSummary();
      }
    }
    
    
    return this.getDefaultSummary();
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
