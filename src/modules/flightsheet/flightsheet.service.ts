import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EnvironmentConfigUtil,
  EnvironmentInfo,
} from './utils/environment-config.util';
import { MemoryInfoUtil } from '../telemetry/utils/hardware/memory-info.util';

interface FlightsheetData {
  [key: string]: unknown;
}

@Injectable()
export class FlightsheetService {
  private flightsheetDir = 'apps';
  private environmentInfo: EnvironmentInfo | null = null;

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly configService: ConfigService,
  ) {}

  async updateFlightsheet(): Promise<boolean> {
    try {
      this.loggingService.log(
        '📡 Fetching flightsheet from API...',
        'INFO',
        'flightsheet',
      );

      // Get miner software from config (synced from backend API)
      const minerSoftware = this.configService.getMinerSoftware();
      if (!minerSoftware) {
        this.loggingService.log(
          '❌ Cannot fetch flightsheet: No minerSoftware found in config. Ensure config is synced with backend.',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      this.loggingService.log(
        `🔍 Using miner software from config: ${minerSoftware}`,
        'DEBUG',
        'flightsheet',
      );

      const minerId = this.configService.getMinerId();
      if (!minerId) {
        this.loggingService.log(
          '❌ Cannot fetch flightsheet: No minerId found',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      const flightsheet = await this.apiService.getFlightsheet(minerId);

      if (!flightsheet) {
        this.loggingService.log(
          '❌ Invalid flightsheet received.',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      const minerConfigPath = path.join(
        this.flightsheetDir,
        minerSoftware,
        'config.json',
      );

      if (!fs.existsSync(path.dirname(minerConfigPath))) {
        fs.mkdirSync(path.dirname(minerConfigPath), { recursive: true });
      }

      // Always update the config file with what we get from backend
      // Apply minimal local optimizations if needed (only for security/compatibility)
      let finalConfig = flightsheet;
      if (minerSoftware === 'xmrig') {
        finalConfig = this.applyMinimalLocalOptimizations(flightsheet);
      }

      // Check if this is a real change that requires miner restart
      // Compare the final processed config (after optimizations) with existing file
      const hasRealChanges = this.hasSignificantChanges(minerConfigPath, finalConfig);
      
      // Only write the file if there are significant changes or if the file doesn't exist
      if (hasRealChanges || !fs.existsSync(minerConfigPath)) {
        fs.writeFileSync(minerConfigPath, JSON.stringify(finalConfig, null, 2));
        
        // Always show that config was written
        this.loggingService.log(
          `✅ Config written to ${minerConfigPath}`,
          'INFO',
          'flightsheet',
        );
      } else {
        this.loggingService.log(
          `⏭️ Skipping config write (no significant changes): ${minerConfigPath}`,
          'DEBUG',
          'flightsheet',
        );
      }
      
      if (hasRealChanges) {
        this.loggingService.log(
          `✅ Flightsheet updated with significant changes: ${minerConfigPath}`,
          'INFO',
          'flightsheet',
        );
        return true; // Miner will be restarted
      } else {
        this.loggingService.log(
          `✅ Flightsheet updated (no significant changes): ${minerConfigPath}`,
          'INFO',
          'flightsheet',
        );
        return false; // No restart needed
      }
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to update flightsheet: ${error.message}`,
        'ERROR',
        'flightsheet',
      );
      return false;
    }
  }

  /**
   * Apply minimal local optimizations (only for security/compatibility)
   * Unlike the full optimization, this only changes non-mining-critical settings
   */
  private applyMinimalLocalOptimizations(flightsheet: any): any {
    const optimizedConfig = { ...flightsheet };

    // Log thread configuration from backend
    if (optimizedConfig.cpu && optimizedConfig.cpu.rx) {
      this.loggingService.log(
        `⚡ Backend provided thread configuration: ${optimizedConfig.cpu.rx.length} threads, rx array: ${JSON.stringify(optimizedConfig.cpu.rx)}`,
        'DEBUG',
        'flightsheet',
      );
    }

    // Log autosave setting from backend
    this.loggingService.log(
      `⚡ Backend autosave setting: ${optimizedConfig.autosave}`,
      'DEBUG',
      'flightsheet',
    );

    // IMPORTANT: Do NOT override any performance settings from backend
    // The backend already provides optimized configurations for each system
    // We only apply security settings for Termux

    // Only apply Termux-specific security settings if in Termux environment
    if (this.isTermuxEnvironment()) {
      // Ensure localhost binding for security in Termux
      if (optimizedConfig.http) {
        optimizedConfig.http.host = '127.0.0.1';
      }
      
      this.loggingService.log(
        `⚡ Applied Termux security optimization: host binding to localhost`,
        'DEBUG',
        'flightsheet',
      );
    }

    this.loggingService.log(
      `⚡ Using backend-provided XMRig configuration as-is (autosave: ${optimizedConfig.autosave})`,
      'DEBUG',
      'flightsheet',
    );

    return optimizedConfig;
  }

  /**
   * Check if running in Termux environment
   */
  private isTermuxEnvironment(): boolean {
    return !!(
      process.env.PREFIX?.includes('termux') ||
      process.env.TERMUX_VERSION ||
      process.env.ANDROID_DATA ||
      process.env.ANDROID_ROOT
    );
  }

  /**
   * Check if running in a low-power environment (mobile devices, limited resources)
   */
  private isLowPowerEnvironment(): boolean {
    // Termux is always considered low-power
    if (this.isTermuxEnvironment()) {
      return true;
    }
    
    // Check for limited memory (less than 4GB)
    const totalMemoryBytes = MemoryInfoUtil.getTotalMemory();
    const totalMemoryGB = totalMemoryBytes / (1024 * 1024 * 1024);
    
    if (totalMemoryGB < 4) {
      return true;
    }
    
    // Check for limited CPU cores (fewer than 4)
    const cpuCores = os.cpus().length;
    if (cpuCores < 4) {
      return true;
    }
    
    return false;
  }

  /**
   * Get optimal thread count based on system resources and environment
   */
  private getOptimalThreadCount(): number {
    const cpuCores = os.cpus().length;
    
    // For mobile/low-power devices, use fewer threads to reduce power consumption
    if (this.isTermuxEnvironment()) {
      // Use 50% of cores for mobile devices to save battery
      return Math.max(1, Math.floor(cpuCores * 0.5));
    }
    
    // For low-power systems, use 75% of cores
    if (this.isLowPowerEnvironment()) {
      return Math.max(1, Math.floor(cpuCores * 0.75));
    }
    
    // For powerful systems, we can use more threads, but leave some for the system
    if (cpuCores >= 8) {
      return Math.max(1, cpuCores - 1); // Leave one core for system
    } else if (cpuCores >= 4) {
      return Math.max(1, Math.floor(cpuCores * 0.75)); // Use 75% of cores
    }
    
    // For systems with very few cores, use all but one
    return Math.max(1, cpuCores - 1);
  }

  /**
   * Check if there are significant changes that require miner restart
   * Only checks mining-critical settings, ignores cosmetic changes and XMRig autosave artifacts
   */
  private hasSignificantChanges(filePath: string, newFlightsheet: any): boolean {
    if (!fs.existsSync(filePath)) {
      this.loggingService.log(
        `📋 No existing config file, treating as significant change`,
        'DEBUG',
        'flightsheet',
      );
      return true;
    }

    try {
      const currentFlightsheet = JSON.parse(
        fs.readFileSync(filePath, 'utf8'),
      );

      // Check mining-critical settings (ignore XMRig autosave artifacts)
      const criticalSettings = [
        'pools',           // Pool changes (wallet, mining pool)
        'threads',         // Thread count for ccminer
        'cpu.rx',          // Thread configuration for XMRig
        'randomx.mode',    // RandomX mode
        'cpu.enabled',     // CPU mining enabled
        'opencl.enabled',  // OpenCL enabled
        'cuda.enabled',    // CUDA enabled
        'cpu.huge-pages',  // Huge pages setting
        'cpu.memory-pool', // Memory pool setting
        'cpu.yield',       // CPU yield setting
      ];

      for (const setting of criticalSettings) {
        const currentValue = this.getNestedValue(currentFlightsheet, setting);
        const newValue = this.getNestedValue(newFlightsheet, setting);
        
        if (JSON.stringify(currentValue) !== JSON.stringify(newValue)) {
          this.loggingService.log(
            `📋 Significant change detected in ${setting}: ${JSON.stringify(currentValue)} → ${JSON.stringify(newValue)}`,
            'INFO',
            'flightsheet',
          );
          return true;
        }
      }

      // Special check: If current config has XMRig-added algorithm arrays but new doesn't,
      // this is NOT a significant change (it's just backend sending compact vs XMRig expanded format)
      const xmrigArtifacts = ['cpu.argon2', 'cpu.cn', 'cpu.cn-heavy', 'cpu.cn-lite', 'cpu.cn-pico', 'cpu.cn/upx2', 'cpu.ghostrider', 'cpu.rx/wow', 'cpu.cn-lite/0', 'cpu.cn/0', 'cpu.rx/arq'];
      let hasOnlyArtifactDifferences = true;
      
      for (const artifact of xmrigArtifacts) {
        const currentValue = this.getNestedValue(currentFlightsheet, artifact);
        const newValue = this.getNestedValue(newFlightsheet, artifact);
        
        // If the new config is missing these artifacts, it's normal (backend sends compact)
        if (currentValue !== undefined && newValue === undefined) {
          continue; // This is expected
        }
        
        // If there are other differences, it's significant
        if (JSON.stringify(currentValue) !== JSON.stringify(newValue)) {
          hasOnlyArtifactDifferences = false;
          break;
        }
      }

      this.loggingService.log(
        `📋 No significant changes detected in mining-critical settings`,
        'DEBUG',
        'flightsheet',
      );
      return false;
    } catch (error: any) {
      this.loggingService.log(
        `⚠️ Error checking config changes: ${error.message}`,
        'WARN',
        'flightsheet',
      );
      return true; // Assume changes if we can't compare
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Apply environment-specific optimizations for XMRig configuration
   */
  private applyXMRigOptimizations(flightsheet: any): any {
    try {
      // Get or cache environment information
      if (!this.environmentInfo) {
        this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();

        // Log environment detection results
        const envSummary = EnvironmentConfigUtil.getEnvironmentSummary(
          this.environmentInfo,
        );
        this.loggingService.log(
          `🔍 Environment detected: ${envSummary}`,
          'INFO',
          'flightsheet',
        );
      }

      // Generate optimized configuration
      const optimizedConfig = EnvironmentConfigUtil.generateOptimalXMRigConfig(
        flightsheet,
        this.environmentInfo,
      );

      // Log what optimizations were applied
      const changes = [];
      if (flightsheet.http?.host !== optimizedConfig.http?.host) {
        changes.push(`Host: ${flightsheet.http?.host} → ${optimizedConfig.http?.host}`);
      }
      if (flightsheet['print-time'] !== optimizedConfig['print-time']) {
        changes.push(`Print-time: ${flightsheet['print-time']} → ${optimizedConfig['print-time']}`);
      }
      if (flightsheet['health-print-time'] !== optimizedConfig['health-print-time']) {
        changes.push(`Health-print-time: ${flightsheet['health-print-time']} → ${optimizedConfig['health-print-time']}`);
      }

      if (changes.length > 0) {
        this.loggingService.log(
          `⚡ Applied XMRig optimizations: ${changes.join(', ')}`,
          'INFO',
          'flightsheet',
        );
      } else {
        this.loggingService.log(
          `⚡ XMRig optimizations applied (no visible changes)`,
          'INFO',
          'flightsheet',
        );
      }

      return optimizedConfig;
    } catch (error: any) {
      this.loggingService.log(
        `⚠️ Failed to apply XMRig optimizations: ${error.message}`,
        'WARN',
        'flightsheet',
      );
      return flightsheet; // Return original on error
    }
  }

  /**
   * Get current environment information
   */
  getEnvironmentInfo(): EnvironmentInfo {
    if (!this.environmentInfo) {
      this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();
    }
    return this.environmentInfo;
  }

  /**
   * Force refresh environment detection
   */
  refreshEnvironmentInfo(): EnvironmentInfo {
    this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();
    return this.environmentInfo;
  }

  getFlightsheet(miner: string): any {
    try {
      const minerConfigPath = path.join(
        this.flightsheetDir,
        miner,
        'config.json',
      );

      if (!fs.existsSync(minerConfigPath)) {
        this.loggingService.log(
          `🚨 No flightsheet found for miner: ${miner} at ${minerConfigPath}`,
          'WARN',
          'flightsheet',
        );
        return null;
      }

      const flightsheet = JSON.parse(
        fs.readFileSync(minerConfigPath, 'utf8'),
      );
      return flightsheet;
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to retrieve flightsheet: ${error.message}`,
        'ERROR',
        'flightsheet',
      );
      return null;
    }
  }

}
