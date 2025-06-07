import { execSync } from 'child_process';
import * as os from 'os';
import { MemoryInfoUtil } from '../../telemetry/utils/hardware/memory-info.util';

export interface EnvironmentInfo {
  isTermux: boolean;
  isLinux: boolean;
  totalMemoryGB: number;
  cpuCores: number;
  hasRoot: boolean;
  architecture: string;
  hasHugePageSupport: boolean;
  recommendedRandomXMode: 'light' | 'auto';
  shouldUseHugePages: boolean;
}

export class EnvironmentConfigUtil {
  /**
   * Detect environment and system resources for optimal XMRig configuration
   */
  static detectEnvironment(): EnvironmentInfo {
    const isTermux = this.isTermuxEnvironment();
    const isLinux = process.platform === 'linux';
    const totalMemoryBytes = MemoryInfoUtil.getTotalMemory();
    const totalMemoryGB = totalMemoryBytes / (1024 * 1024 * 1024);
    const cpuCores = os.cpus().length;
    const hasRoot = this.hasRootAccess();
    const architecture = process.arch;
    const hasHugePageSupport = this.checkHugePageSupport();

    // Determine optimal RandomX mode
    // Mobile devices (Termux) should use "light" mode for lower memory usage
    // Systems with >6GB memory can use "auto" mode for better performance
    const recommendedRandomXMode: 'light' | 'auto' = 
      isTermux || totalMemoryGB < 6 ? 'light' : 'auto';

    // Determine huge pages usage
    // Disable for Termux, enable for systems with sufficient memory and better CPU
    const shouldUseHugePages = !isTermux && 
      totalMemoryGB > 4 && 
      cpuCores >= 4 && 
      hasHugePageSupport &&
      hasRoot;

    return {
      isTermux,
      isLinux,
      totalMemoryGB,
      cpuCores,
      hasRoot,
      architecture,
      hasHugePageSupport,
      recommendedRandomXMode,
      shouldUseHugePages,
    };
  }

  /**
   * Check if running in Termux environment
   */
  private static isTermuxEnvironment(): boolean {
    return !!(
      process.env.PREFIX?.includes('termux') ||
      process.env.TERMUX_VERSION ||
      process.env.ANDROID_DATA ||
      process.env.ANDROID_ROOT
    );
  }

  /**
   * Check if system has root access
   */
  private static hasRootAccess(): boolean {
    try {
      if (this.isTermuxEnvironment()) {
        // In Termux, check if 'su' command is available
        execSync('command -v su', { stdio: 'pipe' });
        return true;
      } else {
        // On regular Linux, check effective user ID
        return process.getuid ? process.getuid() === 0 : false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Check if system supports huge pages
   */
  private static checkHugePageSupport(): boolean {
    try {
      // Check if huge pages are available in the system
      const hugePagesInfo = execSync('cat /proc/meminfo | grep -i hugepage', {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      
      // If we can read huge page info, system likely supports it
      return hugePagesInfo.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Generate optimal XMRig configuration based on environment
   */
  static generateOptimalXMRigConfig(baseConfig: any, environmentInfo: EnvironmentInfo): any {
    const optimizedConfig = { ...baseConfig };

    // Apply RandomX mode optimization
    if (optimizedConfig.randomx) {
      optimizedConfig.randomx.mode = environmentInfo.recommendedRandomXMode;
      
      // For light mode, also disable 1GB pages
      if (environmentInfo.recommendedRandomXMode === 'light') {
        optimizedConfig.randomx['1gb-pages'] = false;
      }
    }

    // Apply CPU configuration optimization
    if (optimizedConfig.cpu) {
      optimizedConfig.cpu['huge-pages'] = environmentInfo.shouldUseHugePages;
      optimizedConfig.cpu['huge-pages-jit'] = environmentInfo.shouldUseHugePages;
      
      // Adjust memory pool usage based on available memory
      optimizedConfig.cpu['memory-pool'] = environmentInfo.totalMemoryGB > 8;
      
      // Set thread yield for mobile devices to reduce power consumption  
      optimizedConfig.cpu.yield = environmentInfo.isTermux;
      
      // Adjust priority for better performance on non-mobile devices
      if (!environmentInfo.isTermux && environmentInfo.hasRoot) {
        optimizedConfig.cpu.priority = 2; // Higher priority for mining
      }
    }

    // Adjust API settings for different environments
    if (optimizedConfig.http) {
      // On Termux, may need to bind to localhost only for security
      if (environmentInfo.isTermux) {
        optimizedConfig.http.host = '127.0.0.1';
      }
    }

    // Adjust logging and background settings
    if (environmentInfo.isTermux) {
      // More conservative settings for mobile
      optimizedConfig.colors = false; // Reduce terminal overhead
      optimizedConfig['print-time'] = 120; // Less frequent printing
      optimizedConfig['health-print-time'] = 120;
    }

    return optimizedConfig;
  }

  /**
   * Get environment summary for logging
   */
  static getEnvironmentSummary(environmentInfo: EnvironmentInfo): string {
    return [
      `Environment: ${environmentInfo.isTermux ? 'Termux' : 'Linux'}`,
      `Memory: ${environmentInfo.totalMemoryGB.toFixed(1)}GB`,
      `CPU Cores: ${environmentInfo.cpuCores}`,
      `Architecture: ${environmentInfo.architecture}`,
      `Root Access: ${environmentInfo.hasRoot ? 'Yes' : 'No'}`,
      `Huge Pages: ${environmentInfo.hasHugePageSupport ? 'Available' : 'Not Available'}`,
      `Recommended RandomX: ${environmentInfo.recommendedRandomXMode}`,
      `Use Huge Pages: ${environmentInfo.shouldUseHugePages ? 'Yes' : 'No'}`
    ].join(', ');
  }
}
