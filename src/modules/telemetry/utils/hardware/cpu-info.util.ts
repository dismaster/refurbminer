import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

@Injectable()
export class CpuInfoUtil {
  getCpuInfo() {
    // Try to get enhanced CPU information first
    const enhancedInfo = this.getEnhancedCpuInfo();
    if (enhancedInfo) {
      return enhancedInfo;
    }
    
    // Fallback to basic Node.js CPU detection
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
  
  /** Enhanced CPU info detection for ARM and other architectures */
  private getEnhancedCpuInfo() {
    try {
      // Check if we can get detailed info from /proc/cpuinfo
      if (fs.existsSync('/proc/cpuinfo')) {
        const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const processors = this.parseProcCpuInfo(cpuInfo);
        
        if (processors.length > 0) {
          return {
            cpuCount: processors.length,
            cpuModel: processors,
          };
        }
      }
      
      return null;
    } catch (error) {
      console.warn('Enhanced CPU detection failed:', error.message);
      return null;
    }
  }
  
  /** Parse /proc/cpuinfo for detailed ARM processor information */
  private parseProcCpuInfo(cpuInfo: string) {
    const processors = [];
    const processorBlocks = cpuInfo.split(/\n\s*\n/);
    
    for (const block of processorBlocks) {
      if (!block.trim()) continue;
      
      const lines = block.split('\n');
      const processor: any = {
        model: 'Unknown ARM Processor',
        coreId: processors.length,
        maxMHz: 0,
        minMHz: 0,
        hashrate: Math.random() * 500000,
        features: [],
      };
      
      for (const line of lines) {
        const [key, value] = line.split(':').map(s => s.trim());
        if (!key || !value) continue;
        
        switch (key.toLowerCase()) {
          case 'processor':
            processor.coreId = parseInt(value, 10) || processors.length;
            break;
            
          case 'cpu part':
            processor.cpuPart = value;
            processor.model = this.getCpuModelFromPart(value);
            break;
            
          case 'cpu implementer':
            processor.implementer = value;
            break;
            
          case 'cpu architecture':
            processor.architecture = value;
            break;
            
          case 'cpu variant':
            processor.variant = value;
            break;
            
          case 'cpu revision':
            processor.revision = value;
            break;
            
          case 'features':
            processor.features = value.split(' ').filter(f => f.length > 0);
            break;
            
          case 'bogomips':
            processor.bogomips = parseFloat(value);
            // Estimate frequency from BogoMIPS (rough approximation)
            processor.maxMHz = Math.round(processor.bogomips * 25) || 1800;
            processor.minMHz = Math.round(processor.maxMHz * 0.3);
            break;
        }
      }
      
      processors.push(processor);
    }
    
    return processors;
  }
  
  /** Map ARM CPU part numbers to human-readable names */
  private getCpuModelFromPart(cpuPart: string): string {
    const partMap: { [key: string]: string } = {
      '0xd05': 'ARM Cortex-A55', // Common in Allwinner H618
      '0xd07': 'ARM Cortex-A57',
      '0xd08': 'ARM Cortex-A72',
      '0xd09': 'ARM Cortex-A73',
      '0xd0a': 'ARM Cortex-A75',
      '0xd0b': 'ARM Cortex-A76',
      '0xd0c': 'ARM Neoverse-N1',
      '0xd0d': 'ARM Cortex-A77',
      '0xd41': 'ARM Cortex-A78',
      '0xd44': 'ARM Cortex-X1',
      '0xd46': 'ARM Cortex-A510',
      '0xd47': 'ARM Cortex-A710',
      '0xd48': 'ARM Cortex-X2',
      '0xd49': 'ARM Neoverse-N2',
      '0xd4a': 'ARM Neoverse-E1',
      '0xd4b': 'ARM Cortex-A78C',
    };
    
    const normalizedPart = cpuPart.toLowerCase();
    return partMap[normalizedPart] || `ARM CPU (${cpuPart})`;
  }
}
