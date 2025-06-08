import { execSync } from 'child_process';
import * as os from 'os';

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
      }      // Combine CPU info with hashrates
      return cpuInfo.map((cpu, index) => ({
        ...cpu,
        // Convert to consistent naming: hashrate in hash/s for both miners
        hashrate: minerHashrates[index] || 0
      }));
    } catch (error) {
      console.error('Failed to get thread performance:', error);
      return this.getDefaultThreadStats();
    }
  }

  /** ✅ Get CPU information with improved parsing */
  private static getCpuInfo(): any[] {
    try {
      // Try using lscpu first with improved parsing
      const lscpuOutput = execSync('lscpu', { encoding: 'utf8' }).split('\n');
      
      // Extract basic CPU info
      const modelNameLine = lscpuOutput.find(l => l.includes('Model name'));
      let modelName = '';
      if (modelNameLine) {
        // Clean up the model name to avoid "None CPU" issues
        modelName = modelNameLine.split(':')[1]?.trim() || '';
        // Remove any "None CPU" artifacts
        modelName = modelName.replace(/\s*None CPU.*$/, '').trim();
      }
      
      const maxMHz = parseFloat(lscpuOutput.find(l => l.includes('CPU max MHz'))?.split(':')[1]?.trim() || '0');
      const minMHz = parseFloat(lscpuOutput.find(l => l.includes('CPU min MHz'))?.split(':')[1]?.trim() || '0');
      const cores = parseInt(lscpuOutput.find(l => l.includes('CPU(s):'))?.split(':')[1]?.trim() || '0');

      if (modelName && cores) {
        return Array(cores).fill(null).map((_, index) => ({
          model: modelName,
          coreId: index,
          maxMHz: maxMHz || 0,
          minMHz: minMHz || 0
        }));
      }

      // Fallback to /proc/cpuinfo with improved parsing
      const cpuinfo = execSync('cat /proc/cpuinfo', { encoding: 'utf8' });
      const processors = cpuinfo.split('\n\n').filter(block => block.trim());

      if (processors.length > 0) {
        return processors.map((block, index) => {
          const lines = block.split('\n');
          const getField = (field: string) => {
            const line = lines.find(l => l.startsWith(field));
            return line ? line.split(':')[1].trim() : '';
          };

          let model = getField('model name') || getField('Hardware');
          // Clean up model name
          model = model.replace(/\s*None CPU.*$/, '').trim();

          return {
            model: model || 'Unknown CPU',
            coreId: index,
            maxMHz: parseFloat(getField('cpu MHz')) || 0,
            minMHz: parseFloat(getField('cpu MHz')) * 0.3 || 0
          };
        });
      }

      // Ultimate fallback to os.cpus()
      return os.cpus().map((cpu, index) => ({
        model: cpu.model.replace(/\s*None CPU.*$/, '').trim() || 'Unknown CPU',
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

  /** ✅ Get CCMiner thread statistics with fallback methods */
  private static getCcminerThreadStats(): any[] {
    try {
      // Method 1: Try the threads command
      let threadsRaw = '';
      try {
        threadsRaw = execSync(`echo 'threads' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });
        if (threadsRaw && threadsRaw.trim()) {
          const stats = this.parseCcminerThreads(threadsRaw);
          if (stats.length > 0) {
            return stats;
          }
        }
      } catch (error) {
        console.log('CCMiner threads command failed, trying alternatives...');
      }

      // Method 2: Try to get total hashrate from summary and distribute evenly
      try {
        const summaryRaw = execSync(`echo 'summary' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });        const hashMatch = summaryRaw.match(/KHS=([\d.]+)/);
        if (hashMatch) {
          const totalHashrate = parseFloat(hashMatch[1]) * 1000; // Convert kilohash to hash
          const cpuCount = os.cpus().length;
          const hashratePerThread = totalHashrate / cpuCount;
          
          return Array(cpuCount).fill(null).map((_, index) => ({
            coreId: index,
            hashrate: hashratePerThread
          }));
        }
      } catch (error) {
        console.log('CCMiner summary fallback failed');
      }

      // Method 3: Try hwinfo for CPU count and estimate
      try {
        const hwinfoRaw = execSync(`echo 'hwinfo' | nc -w 1 127.0.0.1 4068`, { encoding: 'utf8' });
        const cpusMatch = hwinfoRaw.match(/CPUS=(\d+)/);
        if (cpusMatch) {
          const cpuCount = parseInt(cpusMatch[1]);
          // Return zero hashrate for each core since we can't get individual thread stats
          return Array(cpuCount).fill(null).map((_, index) => ({
            coreId: index,
            hashrate: 0
          }));
        }
      } catch (error) {
        console.log('CCMiner hwinfo fallback failed');
      }

      return this.getDefaultThreadStats();
    } catch (error) {
      console.error('Failed to get CCMiner stats:', error);
      return this.getDefaultThreadStats();
    }
  }
  /** ✅ Get XMRig thread statistics */
  private static async getXmrigThreadStats(): Promise<any[]> {
    try {
      const response = await fetch(`http://127.0.0.1:4068/1/summary`, {
        headers: {
          'Authorization': 'Bearer xmrig'
        }
      });
      if (!response.ok) return this.getDefaultThreadStats();

      const json = await response.json();
        // XMRig provides thread hashrates in the main summary endpoint
      if (json.hashrate?.threads && Array.isArray(json.hashrate.threads)) {
        return json.hashrate.threads.map((threadHashrates: number[], index: number) => ({
          coreId: index,
          hashrate: threadHashrates[0] || 0 // First element is current hashrate
        }));
      }
      
      return this.getDefaultThreadStats();
    } catch {
      return this.getDefaultThreadStats();
    }
  }

  /** ✅ Parse CCMiner thread output */
  private static parseCcminerThreads(output: string): any[] {
    if (!output || !output.trim()) {
      return [];
    }

    try {
      // Try to parse pipe-separated format first
      if (output.includes('|')) {
        return output
          .split('|')
          .filter(thread => thread.trim())          .map((thread, index) => {
            const match = thread.match(/KHS=([\d.]+)/);
            return {
              coreId: index,
              hashrate: match ? parseFloat(match[1]) * 1000 : 0 // Convert kilohash to hash
            };
          });
      }

      // Try to parse line-separated format
      const lines = output.split('\n').filter(line => line.trim());      return lines.map((line, index) => {
        const match = line.match(/KHS=([\d.]+)/);
        return {
          coreId: index,
          hashrate: match ? parseFloat(match[1]) * 1000 : 0 // Convert kilohash to hash
        };
      });
    } catch (error) {
      console.error('Failed to parse CCMiner threads:', error);
      return [];
    }
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