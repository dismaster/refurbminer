import { execSync } from 'child_process';
import * as os from 'os'; // ✅ Import the OS module

export class MinerThreadsUtil {
  /** ✅ Get thread performance data */
  static async getThreadPerformance(): Promise<any[]> {
    try {
      const miner = this.detectMiner();
      const cpuInfo = this.getCpuInfo();
      
      // Get hashrates from miner if running
      let minerHashrates: number[] = [];
      if (miner) {
        const threadStats = miner === 'ccminer' 
          ? this.getCcminerThreadStats()
          : await this.getXmrigThreadStats();
          
        minerHashrates = threadStats.map(t => t.hashrate || 0);
      }

      // Combine CPU info with hashrates
      return cpuInfo.map((cpu, index) => ({
        ...cpu,
        khs: minerHashrates[index] || 0
      }));
    } catch (error) {
      console.error('Failed to get thread performance:', error);
      return this.getDefaultThreadStats();
    }
  }

  /** ✅ Get CPU information */
  private static getCpuInfo(): any[] {
    try {
      // Try using lscpu first
      const lscpuOutput = execSync('lscpu', { encoding: 'utf8' }).split('\n');
      const modelName = lscpuOutput.find(l => l.includes('Model name'))?.split(':')[1]?.trim() || '';
      const maxMHz = parseFloat(lscpuOutput.find(l => l.includes('CPU max MHz'))?.split(':')[1]?.trim() || '0');
      const minMHz = parseFloat(lscpuOutput.find(l => l.includes('CPU min MHz'))?.split(':')[1]?.trim() || '0');
      const cores = parseInt(lscpuOutput.find(l => l.includes('CPU(s)'))?.split(':')[1]?.trim() || '0');

      if (modelName && cores) {
        return Array(cores).fill(null).map((_, index) => ({
          model: modelName,
          coreId: index,
          maxMHz: maxMHz,
          minMHz: minMHz
        }));
      }

      // Fallback to /proc/cpuinfo
      const cpuinfo = execSync('cat /proc/cpuinfo', { encoding: 'utf8' });
      const processors = cpuinfo.split('\n\n').filter(block => block.trim());

      if (processors.length > 0) {
        return processors.map((block, index) => {
          const lines = block.split('\n');
          const getField = (field: string) => {
            const line = lines.find(l => l.startsWith(field));
            return line ? line.split(':')[1].trim() : '';
          };

          return {
            model: getField('model name') || getField('Hardware'),
            coreId: index,
            maxMHz: parseFloat(getField('cpu MHz')) || 0,
            minMHz: parseFloat(getField('cpu MHz')) * 0.3 || 0
          };
        });
      }

      // Ultimate fallback to os.cpus()
      return os.cpus().map((cpu, index) => ({
        model: cpu.model,
        coreId: index,
        maxMHz: cpu.speed,
        minMHz: Math.floor(cpu.speed * 0.3)
      }));

    } catch (error) {
      console.error('Failed to get CPU info:', error);
      return this.getDefaultThreadStats();
    }
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
      const stats = this.parseCcminerThreads(threadsRaw);
      return stats.length ? stats : this.getDefaultThreadStats();
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
