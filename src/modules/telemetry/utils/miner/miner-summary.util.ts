import { execSync } from 'child_process';

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
      const summaryRaw = execSync(`echo 'summary' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });
      const parsed = this.parseCcminerOutput(summaryRaw);

      return {
        name: 'ccminer',
        version: parsed.VER || 'unknown',
        algorithm: parsed.ALGO || 'unknown',
        hashrate: parseFloat(parsed.KHS) || 0,
        acceptedShares: parseInt(parsed.ACC) || 0,
        rejectedShares: parseInt(parsed.REJ) || 0,
        uptime: parseInt(parsed.UPTIME) || 0,
        averageShareRate: parseFloat(parsed.ACCMN) || 0,
        solvedBlocks: parseInt(parsed.SOLV) || 0
      };
    } catch {
      return this.getDefaultSummary();
    }
  }  
  
  /** ✅ Get XMRig summary */
  private static async getXmrigSummary(): Promise<any> {
    try {
      const response = await fetch(`http://127.0.0.1:4068/1/summary`, {
        headers: {
          'Authorization': 'Bearer xmrig'
        }
      });
      if (!response.ok) return this.getDefaultSummary();

      const json = await response.json();
      return {
        name: 'xmrig',
        version: json.version || 'unknown',
        algorithm: json.algo || 'unknown',
        hashrate: parseFloat(json.hashrate?.total?.[0] || 0),
        acceptedShares: parseInt(json.connection?.accepted || '0'),
        rejectedShares: parseInt(json.connection?.rejected || '0'),
        uptime: parseInt(json.uptime || '0'),
        averageShareRate: parseFloat(json.results?.avg_time_ms || '0') / 1000, // Convert ms to seconds
        solvedBlocks: json.results?.best?.filter((b: number) => b > 0)?.length || 0
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
