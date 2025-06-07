import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';

interface SchedulePeriod {
  startTime: string;
  endTime: string;
  days: string[]; // Keep for future compatibility
}

// Interface for new backend API restart objects
interface ScheduledRestart {
  time: string;
  days?: string[]; // Optional array of days
}

// Match database structure where scheduledRestarts is array of objects
interface Config {
  minerId: string;
  rigId: string;
  name: string;
  minerSoftware?: string; // Current selected miner software (xmrig, ccminer, etc.)
  thresholds: {
    maxCpuTemp: number;
    maxBatteryTemp: number;
    maxStorageUsage: number;
    minHashrate: number;
    shareRatio: number;
  };
  schedules: {
    scheduledMining: {
      enabled: boolean;
      periods: SchedulePeriod[];
    };
    scheduledRestarts: ScheduledRestart[]; // Array of objects like [{time: "16:00", days: ["monday"]}]
  };
}

@Injectable()
export class ConfigService implements OnModuleInit {
  private configPath = path.join(process.cwd(), 'config', 'config.json');
  private syncInterval: NodeJS.Timeout;
  private apiUrl: string;
  private readonly MAX_BACKUPS = 5; // Maximum number of backup files to keep

  constructor(
    private readonly loggingService: LoggingService,
    private readonly httpService: HttpService,
  ) {
    this.apiUrl = process.env.API_URL || 'https://api.refurbminer.de';
  }
  async onModuleInit() {
    // Create config directory if it doesn't exist
    const configDir = path.join(process.cwd(), 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Create default config if it doesn't exist
    if (!fs.existsSync(this.configPath)) {
      this.saveConfig({
        minerId: '',
        rigId: '',
        name: 'Unnamed Rig',
        minerSoftware: undefined, // Will be synced from backend API after registration
        thresholds: {
          maxCpuTemp: 85,
          maxBatteryTemp: 45,
          maxStorageUsage: 90,
          minHashrate: 0,
          shareRatio: 0.5,
        },
        schedules: {
          scheduledMining: { enabled: false, periods: [] },
          scheduledRestarts: [],
        },
      });
    } else {
      await this.cleanupConfig();
    }

    // IMPORTANT: Do NOT sync with API during module initialization
    // This prevents gathering wrong data before miner registration is complete
    // The sync will be triggered by BootstrapService after successful registration
    const config = this.getConfig();
    if (config && config.minerId && config.minerId.length > 0) {
      this.loggingService.log(
        'ConfigService: Valid minerId found, but skipping initial sync to prevent race conditions. Sync will be triggered after bootstrap.',
        'INFO',
        'config',
      );
    } else {
      this.loggingService.log(
        'ConfigService: No minerId found yet. Will sync after registration.',
        'INFO',
        'config',
      );
    }
  }

  /**
   * Call this after successful registration to trigger config sync and periodic sync
   */
  public async triggerConfigSyncAfterRegistration() {
    await this.syncConfigWithApi();
    if (!this.syncInterval) {
      // Set up periodic sync every 5 minutes to avoid log flooding
      this.syncInterval = setInterval(
        () => {
          this.syncConfigWithApi();
        },
        5 * 60 * 1000, // 5 minutes - reduced frequency to minimize log noise
      );
    }
  }

  getConfig(): Config | null {
    try {
      this.loggingService.log(
        `📂 Reading config from: ${this.configPath}`,
        'DEBUG',
        'config',
      );

      if (!fs.existsSync(this.configPath)) {
        throw new Error('Config file not found');
      }

      const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.loggingService.log(
        '✅ Config loaded successfully',
        'DEBUG',
        'config',
      );
      return config;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to load config: ${error.message}`,
        'ERROR',
        'config',
      );
      return null;
    }
  }

  saveConfig(config: Config): boolean {
    try {
      // Create a backup of the current config file if it exists
      if (fs.existsSync(this.configPath)) {
        const timestamp = Date.now();
        const backupPath = `${this.configPath}.${timestamp}.bak`;
        fs.copyFileSync(this.configPath, backupPath);
        this.loggingService.log(
          `📦 Config backup created: ${backupPath}`,
          'DEBUG',
          'config',
        );
      }
      
      // Write new config
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      this.loggingService.log(
        '✅ Config saved successfully',
        'DEBUG',
        'config',
      );
      
      // Clean up old backups
      this.cleanupConfigBackups();
      
      return true;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to save config: ${error.message}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  getRigToken(): string | null {
    const token = process.env.RIG_TOKEN;
    if (!token) {
      this.loggingService.log(
        '❌ RIG_TOKEN not found in environment',
        'ERROR',
        'config',
      );
    }
    return token || null;
  }

  getMinerId(): string {
    const config = this.getConfig();
    // Do NOT generate a fallback minerId!
    return config?.minerId || '';
  }

  /**
   * Sync local config with backend API
   */
  async syncConfigWithApi(): Promise<boolean> {
    try {
      const rigToken = this.getRigToken();
      if (!rigToken) {
        this.loggingService.log(
          '⚠️ Cannot sync config: RIG_TOKEN not found',
          'WARN',
          'config',
        );
        return false;
      }

      // First clean up the config to ensure consistent structure
      await this.cleanupConfig();

      const currentConfig = this.getConfig();
      if (!currentConfig) {
        this.loggingService.log(
          '⚠️ Cannot sync config: Local config not found',
          'WARN',
          'config',
        );
        return false;
      }

      this.loggingService.log(
        '🔄 Syncing configuration with API...',
        'DEBUG',
        'config',
      );

      // Get miner configuration from API
      const url = `${this.apiUrl}/api/miners/config?rigToken=${rigToken}`;
      this.loggingService.log(
        `📡 Fetching config from: ${url}`,
        'DEBUG',
        'config',
      );

      const response = await firstValueFrom(this.httpService.get(url));

      if (response.status !== 200) {
        throw new Error(`API returned ${response.status}`);
      }
      const apiConfig = response.data;
      this.loggingService.log(
        `📥 Received config data: ${JSON.stringify(apiConfig)}`,
        'DEBUG',
        'config',
      );

      // Only log minerSoftware changes, not every sync
      if (apiConfig.minerSoftware !== currentConfig.minerSoftware) {
        this.loggingService.log(
          `🔄 Miner software changing: ${currentConfig.minerSoftware} → ${apiConfig.minerSoftware}`,
          'INFO',
          'config',
        );
      }

      // PRESERVE the local minerId - never overwrite with API data
      // The miner ID should only be set during initial registration
      // API sync is only for configuration data (schedules, thresholds, etc.)
      if (apiConfig.minerId && apiConfig.minerId !== currentConfig.minerId) {
        this.loggingService.log(
          `API returned different minerId (${apiConfig.minerId}) but keeping local minerId (${currentConfig.minerId}) to prevent overwriting registration`,
          'INFO',
          'config',
        );
      }

      // Create a clean config preserving local minerId and only syncing configuration data
      const updatedConfig: Config = {
        minerId: currentConfig.minerId, // Always preserve local minerId
        rigId: apiConfig.rigId || currentConfig.rigId,
        name: apiConfig.name || currentConfig.name,
        minerSoftware: apiConfig.minerSoftware || currentConfig.minerSoftware, // Sync mining software from backend
        thresholds: {
          maxCpuTemp:
            apiConfig.thresholds?.maxCpuTemp ??
            currentConfig.thresholds.maxCpuTemp,
          maxBatteryTemp:
            apiConfig.thresholds?.maxBatteryTemp ??
            currentConfig.thresholds.maxBatteryTemp,
          maxStorageUsage:
            apiConfig.thresholds?.maxStorageUsage ??
            currentConfig.thresholds.maxStorageUsage,
          minHashrate:
            apiConfig.thresholds?.minHashrate ??
            currentConfig.thresholds.minHashrate,
          shareRatio:
            apiConfig.thresholds?.shareRatio ??
            currentConfig.thresholds.shareRatio,
        },
        schedules: {
          scheduledMining: {
            enabled:
              apiConfig.schedules?.scheduledMining?.enabled ??
              currentConfig.schedules.scheduledMining.enabled,
            periods:
              apiConfig.schedules?.scheduledMining?.periods ??
              currentConfig.schedules.scheduledMining.periods,
          },
          scheduledRestarts:
            apiConfig.schedules?.scheduledRestarts ??
            currentConfig.schedules.scheduledRestarts,
        },
      };
      this.saveConfig(updatedConfig);
      this.loggingService.log(
        '✅ Config synchronized with API successfully',
        'DEBUG',
        'config',
      );
      // Only log the final config in DEBUG, not INFO
      this.loggingService.log(
        `📄 Updated config: ${JSON.stringify(updatedConfig)}`,
        'DEBUG',
        'config',
      );
      return true;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to sync config with API: ${error.message}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Force an immediate config sync with the API
   * This can be called by services that need the latest config (like the MinerManagerService)
   */
  async forceSyncWithApi(): Promise<boolean> {
    this.loggingService.log(
      '🔄 Forcing immediate config sync...',
      'DEBUG',
      'config',
    );
    return await this.syncConfigWithApi();
  }

  /**
   * Clean up config file to ensure consistent structure
   */
  async cleanupConfig(): Promise<boolean> {
    try {
      const currentConfig = this.getConfig();
      if (!currentConfig) {
        this.loggingService.log(
          '⚠️ Cannot clean config: File not found',
          'WARN',
          'config',
        );
        return false;
      }

      // Create a new config with exactly the expected structure
      const cleanConfig: Config = {
        minerId: currentConfig.minerId || '',
        rigId: currentConfig.rigId || '',
        name: currentConfig.name || 'Unnamed Rig',
        minerSoftware: currentConfig.minerSoftware, // Preserve mining software selection
        thresholds: {
          maxCpuTemp: currentConfig.thresholds?.maxCpuTemp ?? 85,
          maxBatteryTemp: currentConfig.thresholds?.maxBatteryTemp ?? 45,
          maxStorageUsage: currentConfig.thresholds?.maxStorageUsage ?? 90,
          minHashrate: currentConfig.thresholds?.minHashrate ?? 0,
          shareRatio: currentConfig.thresholds?.shareRatio ?? 0.5,
        },
        schedules: {
          scheduledMining: {
            enabled: currentConfig.schedules?.scheduledMining?.enabled ?? false,
            periods: currentConfig.schedules?.scheduledMining?.periods || [],
          },
          scheduledRestarts: currentConfig.schedules?.scheduledRestarts || [],
        },
      };

      // Save the cleaned config
      const saved = this.saveConfig(cleanConfig);
      if (saved) {
        this.loggingService.log(
          '✅ Config cleaned up successfully',
          'DEBUG',
          'config',
        );
        // Only log cleaned config details in DEBUG mode
        this.loggingService.log(
          `📄 Cleaned config: ${JSON.stringify(cleanConfig)}`,
          'DEBUG',
          'config',
        );
      }
      return saved;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to clean config: ${error.message}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Cleans up old backup files, keeping only the most recent ones
   */
  private cleanupConfigBackups(): void {
    try {
      const dirPath = path.dirname(this.configPath);
      const fileName = path.basename(this.configPath);

      // Get all files in the directory
      const files = fs.readdirSync(dirPath);

      // Filter for backup files matching our pattern
      const backupFiles = files
        .filter((file) => file.startsWith(`${fileName}.`) && file.endsWith('.bak'))
        .map((file) => ({
          name: file,
          path: path.join(dirPath, file),
          // Extract timestamp from filename
          timestamp:
            parseInt(file.replace(`${fileName}.`, '').replace('.bak', ''), 10) ||
            0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first

      // Remove older backups if we have more than MAX_BACKUPS
      if (backupFiles.length > this.MAX_BACKUPS) {
        backupFiles.slice(this.MAX_BACKUPS).forEach((file) => {
          try {
            fs.unlinkSync(file.path);
            this.loggingService.log(
              `🗑️ Removed old config backup: ${file.name}`,
              'DEBUG',
              'config',
            );
          } catch (error: any) {
            this.loggingService.log(
              `Failed to delete backup ${file.name}: ${error.message}`,
              'WARN',
              'config',
            );
          }
        });
      }
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to clean up config backups: ${error.message}`,
        'ERROR',
        'config',
      );
    }
  }

  /**
   * Get the currently configured miner software
   */
  getMinerSoftware(): string | undefined {
    const config = this.getConfig();
    return config?.minerSoftware;
  }

  /**
   * Set the current miner software in config
   */
  setMinerSoftware(minerSoftware: string): boolean {
    try {
      const config = this.getConfig();
      if (!config) {
        this.loggingService.log(
          '❌ Cannot set miner software: Config not found',
          'ERROR',
          'config',
        );
        return false;
      }

      config.minerSoftware = minerSoftware;
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      
      this.loggingService.log(
        `✅ Miner software updated to: ${minerSoftware}`,
        'INFO',
        'config',
      );
      return true;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to set miner software: ${error.message}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }
}
