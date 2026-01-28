import { exec, ExecOptionsWithStringEncoding } from 'child_process';
import { promisify } from 'util';
import { MinerApiConfigUtil } from './miner-api-config.util';

type ExecOptionsString = Omit<ExecOptionsWithStringEncoding, 'encoding'> & {
  encoding?: BufferEncoding;
};

const execAsync = promisify(exec) as (
  command: string,
  options?: ExecOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

const execCommand = async (
  command: string,
  options: ExecOptionsString = {},
): Promise<string> => {
  const { stdout } = await execAsync(command, {
    encoding: 'utf8',
    ...options,
  } as ExecOptionsWithStringEncoding);
  return stdout ?? '';
};

export class MinerSummaryUtil {
  private static summaryCache: { miner: string | null; data: any; timestamp: number } | null = null;
  private static readonly SUMMARY_CACHE_TTL = 15000; // 15 seconds

  /** ✅ Get miner summary based on detected miner */
  static async getMinerSummary(): Promise<any> {
    const now = Date.now();
    if (
      this.summaryCache &&
      now - this.summaryCache.timestamp < this.SUMMARY_CACHE_TTL
    ) {
      return this.summaryCache.data;
    }

    const miner = await this.detectMiner();

    if (!miner) {
      return this.getDefaultSummary();
    }

    const data = miner === 'ccminer'
      ? await this.getCcminerSummary()
      : await this.getXmrigSummary();

    this.summaryCache = { miner, data, timestamp: Date.now() };
    return data;
  }

  /** ✅ Detect which miner is running */
  private static async detectMiner(): Promise<string | null> {
    try {
      const runningProcesses = await execCommand('ps aux');

      if (runningProcesses.includes('ccminer')) return 'ccminer';
      if (runningProcesses.includes('xmrig')) return 'xmrig';

      return null;
    } catch {
      return null;
    }
  }

  /** ✅ Get CCMiner summary */
  private static async getCcminerSummary(): Promise<any> {
    try {
      // Clear cache to force rediscovery of correct local endpoint
      MinerApiConfigUtil.clearCache();
      
      const endpoint = await MinerApiConfigUtil.getCcminerApiEndpoint();
      
      // Use direct summary command since it provides accurate real-time data
      // Added better timeout protection to prevent hanging
      let summaryRaw: string;
      try {
        // Force kill netcat after timeout using signal
        summaryRaw = await execCommand(`echo 'summary' | nc -w 2 ${endpoint}`, {
          timeout: 5000, // Increased timeout
          killSignal: 'SIGKILL', // Force kill if timeout
        });
      } catch (timeoutError) {
        // If the API call times out, return fallback data
        return {
          name: 'ccminer',
          version: 'unknown',
          algorithm: 'unknown',
          hashrate: 0,
          acceptedShares: 0,
          rejectedShares: 0,
          uptime: 0,
          averageShareRate: 0,
          solvedBlocks: 0,
        };
      }

      if (!summaryRaw || !summaryRaw.trim()) {
        return {
          name: 'ccminer',
          version: 'unknown',
          algorithm: 'unknown',
          hashrate: 0,
          acceptedShares: 0,
          rejectedShares: 0,
          uptime: 0,
          averageShareRate: 0,
          solvedBlocks: 0,
        };
      }
      
      const parsed = this.parseCcminerOutput(summaryRaw);

      const result = {
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
      
      return result;
    } catch (error) {
      return this.getDefaultSummary();
    }
  }
  
  /** ✅ Get XMRig summary */
  private static async getXmrigSummary(): Promise<any> {
    const maxRetries = 3;
    const timeoutMs = 10000; // Increased to 10 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const baseUrl = await MinerApiConfigUtil.getXmrigApiUrl();
        
        if (attempt > 1) {
          // XMRig summary retry
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

  /** ✅ Extract real-time hashrate from CCMiner process or logs */
  private static async extractRealtimeHashrate(): Promise<number> {
    try {
      // Try to get most current hashrate from CCMiner API with shorter timeout
      const endpoint = await MinerApiConfigUtil.getCcminerApiEndpoint();
      
      // Try 'threads' command which may have more current per-thread data
      try {
        const threadsRaw = await execCommand(`echo 'threads' | nc -w 1 ${endpoint}`, {
          timeout: 1500,
        });
        
        // Parse threads output to get total current hashrate
        if (threadsRaw && threadsRaw.includes('KHS=')) {
          let totalKHS = 0;
          const khsMatches = threadsRaw.match(/KHS=([\d.]+)/g);
          if (khsMatches) {
            for (const match of khsMatches) {
              const khs = match.match(/KHS=([\d.]+)/);
              if (khs && khs[1]) {
                totalKHS += parseFloat(khs[1]);
              }
            }
            if (totalKHS > 0) {
              return totalKHS * 1000; // Convert kH/s to H/s
            }
          }
        }
      } catch (threadsError) {
        // Threads command failed
      }

      // Try a fresh 'summary' call with minimal timeout for most current data
      try {
        const summaryRaw = await execCommand(`echo 'summary' | nc -w 1 ${endpoint}`, {
          timeout: 1500,
        });
        const summaryData = this.parseCcminerOutput(summaryRaw);
        if (summaryData.KHS) {
          return parseFloat(summaryData.KHS) * 1000;
        }
      } catch (summaryError) {
        // Fresh summary failed
      }

    } catch (error) {
      // All extraction methods failed
    }
    
    return 0; // Return 0 to indicate real-time extraction failed, use API fallback
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
