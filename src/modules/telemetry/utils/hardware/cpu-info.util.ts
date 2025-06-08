import { Injectable } from '@nestjs/common';
import * as os from 'os';

@Injectable()
export class CpuInfoUtil {  getCpuInfo() {
    const cpus = os.cpus().map((cpu, index) => ({
      model: cpu.model,
      coreId: index,
      maxMHz: cpu.speed,
      minMHz: Math.floor(cpu.speed * 0.3), // Simulated min speed
      hashrate: Math.random() * 500000, // Simulated hashrate in hash/s (converted from kh/s)
    }));

    return {
      cpuCount: cpus.length,
      cpuModel: cpus,
    };
  }
}
