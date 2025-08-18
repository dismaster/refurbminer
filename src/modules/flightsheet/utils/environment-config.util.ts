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
   * NOTE: This preserves thread configurations and performance settings from backend while only optimizing security/compatibility settings
   */
  static generateOptimalXMRigConfig(baseConfig: any, environmentInfo: EnvironmentInfo): any {
    const optimizedConfig = { ...baseConfig };

    // CRITICAL: Do NOT override RandomX mode from backend - it knows best for the specific pool/algorithm
    // The backend already provides optimized RandomX configuration
    // if (optimizedConfig.randomx) {
    //   optimizedConfig.randomx.mode = environmentInfo.recommendedRandomXMode;
    //   if (environmentInfo.recommendedRandomXMode === 'light') {
    //     optimizedConfig.randomx['1gb-pages'] = false;
    //   }
    // }

    // CRITICAL: Do NOT override CPU configuration from backend - it provides optimal thread mapping
    // The backend already provides optimized CPU settings including thread configuration
    // if (optimizedConfig.cpu) {
    //   optimizedConfig.cpu['huge-pages'] = environmentInfo.shouldUseHugePages;
    //   optimizedConfig.cpu['huge-pages-jit'] = environmentInfo.shouldUseHugePages;
    //   optimizedConfig.cpu['memory-pool'] = environmentInfo.totalMemoryGB > 8;
    //   optimizedConfig.cpu.yield = environmentInfo.isTermux;
    //   if (!environmentInfo.isTermux && environmentInfo.hasRoot) {
    //     optimizedConfig.cpu.priority = 2;
    //   }
    // }

    // Only apply Termux-specific security settings
    if (environmentInfo.isTermux) {
      // On Termux, bind to localhost only for security
      if (optimizedConfig.http) {
        optimizedConfig.http.host = '127.0.0.1';
      }
      
      // More conservative logging settings for mobile to reduce overhead
      optimizedConfig.colors = false;
      optimizedConfig['print-time'] = 120;
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
