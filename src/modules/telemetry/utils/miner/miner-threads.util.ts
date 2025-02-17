import { execSync } from 'child_process';
import * as os from 'os'; // ✅ Import the OS module

export class MinerThreadsUtil {
  /** ✅ Get thread performance data */
  static async getThreadPerformance(): Promise<any[]> {
    const miner = this.detectMiner();

    if (!miner) {
      return this.getDefaultThreadStats();
    }

    return miner === 'ccminer'
      ? this.getCcminerThreadStats()
      : await this.getXmrigThreadStats();
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

  /** ✅ Get CCMiner thread statistics */
  private static getCcminerThreadStats(): any[] {
    try {
      const threadsRaw = execSync(`echo 'threads' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });
      return this.parseCcminerThreads(threadsRaw);
    } catch {
      return this.getDefaultThreadStats();
    }
  }

  /** ✅ Get XMRig thread statistics */
  private static async getXmrigThreadStats(): Promise<any[]> {
    try {
      const response = await fetch(`http://127.0.0.1:4067/threads`);
      if (!response.ok) return this.getDefaultThreadStats();

      const json = await response.json();
      return json.threads.map((thread: any, index: number) => ({
        coreId: index,
        hashrate: parseFloat(thread.hashrate?.[0] || '0')
      }));
    } catch {
      return this.getDefaultThreadStats();
    }
  }

  /** ✅ Parse CCMiner thread output */
  private static parseCcminerThreads(output: string): any[] {
    return output
      .split('|')
      .map((thread, index) => {
        const match = thread.match(/KHS=([\d.]+)/);
        return {
          coreId: index,
          hashrate: match ? parseFloat(match[1]) : 0
        };
      });
  }

  /** ✅ Default thread stats fallback */
  private static getDefaultThreadStats(): any[] {
    const coreCount = os.cpus().length;
    const hashPerCore = 0;

    return Array(coreCount)
      .fill(0)
      .map((_, index) => ({
        coreId: index,
        hashrate: hashPerCore
      }));
  }
}
