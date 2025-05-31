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

// Match database structure where scheduledRestarts is array of strings
interface Config {
  minerId: string;
  rigId: string;
  name: string;
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
    scheduledRestarts: string[]; // Array of times like ["16:00"]
  };
}

@Injectable()
export class ConfigService implements OnModuleInit {
  private configPath = path.join(process.cwd(), 'config', 'config.json');
  private syncInterval: NodeJS.Timeout;
  private apiUrl: string;

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

    // Only sync if minerId is present
    const config = this.getConfig();
    if (config && config.minerId && config.minerId.length > 0) {
      await this.syncConfigWithApi();
      // Set up periodic sync (every 15 minutes)
      this.syncInterval = setInterval(() => {
        this.syncConfigWithApi();
      }, 15 * 60 * 1000);
    } else {
      this.loggingService.log(
        'ConfigService: Skipping config sync, minerId not set yet. Will sync after registration.',
        'WARN',
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
      this.syncInterval = setInterval(() => {
        this.syncConfigWithApi();
      }, 15 * 60 * 1000);
    }
  }

  getConfig(): Config | null {
    try {
      this.loggingService.log(`📂 Reading config from: ${this.configPath}`, 'DEBUG', 'config');
      
      if (!fs.existsSync(this.configPath)) {
        throw new Error('Config file not found');
      }
      
      const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.loggingService.log('✅ Config loaded successfully', 'DEBUG', 'config');
      return config;
    } catch (error) {
      this.loggingService.log(`❌ Failed to load config: ${error.message}`, 'ERROR', 'config');
      return null;
    }
  }

  saveConfig(config: Config): boolean {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      this.loggingService.log('✅ Config saved successfully', 'DEBUG', 'config');
      return true;
    } catch (error) {
      this.loggingService.log(`❌ Failed to save config: ${error.message}`, 'ERROR', 'config');
      return false;
    }
  }

  getRigToken(): string | null {
    const token = process.env.RIG_TOKEN;
    if (!token) {
      this.loggingService.log('❌ RIG_TOKEN not found in environment', 'ERROR', 'config');
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
        this.loggingService.log('⚠️ Cannot sync config: RIG_TOKEN not found', 'WARN', 'config');
        return false;
      }

      // First clean up the config to ensure consistent structure
      await this.cleanupConfig();
      
      const currentConfig = this.getConfig();
      if (!currentConfig) {
        this.loggingService.log('⚠️ Cannot sync config: Local config not found', 'WARN', 'config');
        return false;
      }

      this.loggingService.log('🔄 Syncing configuration with API...', 'INFO', 'config');
      
      // Get miner configuration from API
      const url = `${this.apiUrl}/api/miners/config?rigToken=${rigToken}`;
      this.loggingService.log(`📡 Fetching config from: ${url}`, 'DEBUG', 'config');
      
      const response = await firstValueFrom(
        this.httpService.get(url)
      );

      if (response.status !== 200) {
        throw new Error(`API returned ${response.status}`);
      }

      const apiConfig = response.data;
      this.loggingService.log(`📥 Received config data: ${JSON.stringify(apiConfig)}`, 'DEBUG', 'config');

      // Accept the backend's minerId if it differs
      if (apiConfig.minerId && apiConfig.minerId !== currentConfig.minerId) {
        this.loggingService.log(
          `API provided different minerId (${apiConfig.minerId}), updating local minerId to match backend`,
          'INFO',
          'config',
        );
        currentConfig.minerId = apiConfig.minerId;
      }
      // Create a clean config with API values and backend minerId
      const updatedConfig: Config = {
        minerId: currentConfig.minerId,
        rigId: apiConfig.rigId || currentConfig.rigId,
        name: apiConfig.name || currentConfig.name,
        thresholds: {
          maxCpuTemp: apiConfig.thresholds?.maxCpuTemp ?? currentConfig.thresholds.maxCpuTemp,
          maxBatteryTemp: apiConfig.thresholds?.maxBatteryTemp ?? currentConfig.thresholds.maxBatteryTemp,
          maxStorageUsage: apiConfig.thresholds?.maxStorageUsage ?? currentConfig.thresholds.maxStorageUsage,
          minHashrate: apiConfig.thresholds?.minHashrate ?? currentConfig.thresholds.minHashrate,
          shareRatio: apiConfig.thresholds?.shareRatio ?? currentConfig.thresholds.shareRatio,
        },
        schedules: {
          scheduledMining: {
            enabled: apiConfig.schedules?.scheduledMining?.enabled ?? currentConfig.schedules.scheduledMining.enabled,
            periods: apiConfig.schedules?.scheduledMining?.periods ?? currentConfig.schedules.scheduledMining.periods,
          },
          scheduledRestarts: apiConfig.schedules?.scheduledRestarts ?? currentConfig.schedules.scheduledRestarts,
        },
      };
      this.saveConfig(updatedConfig);
      this.loggingService.log('✅ Config synchronized with API successfully', 'INFO', 'config');
      this.loggingService.log(`📄 Updated config: ${JSON.stringify(updatedConfig)}`, 'DEBUG', 'config');
      return true;
    } catch (error) {
      this.loggingService.log(`❌ Failed to sync config with API: ${error.message}`, 'ERROR', 'config');
      return false;
    }
  }

  /**
   * Force an immediate config sync with the API
   * This can be called by services that need the latest config (like the MinerManagerService)
   */
  async forceSyncWithApi(): Promise<boolean> {
    this.loggingService.log('🔄 Forcing immediate config sync...', 'INFO', 'config');
    return await this.syncConfigWithApi();
  }

  /**
   * Clean up config file to ensure consistent structure
   */
  async cleanupConfig(): Promise<boolean> {
    try {
      const currentConfig = this.getConfig();
      if (!currentConfig) {
        this.loggingService.log('⚠️ Cannot clean config: File not found', 'WARN', 'config');
        return false;
      }

      // Create a new config with exactly the expected structure
      const cleanConfig: Config = {
        minerId: currentConfig.minerId || '',
        rigId: currentConfig.rigId || '',
        name: currentConfig.name || 'Unnamed Rig',
        thresholds: {
          maxCpuTemp: currentConfig.thresholds?.maxCpuTemp ?? 85,
          maxBatteryTemp: currentConfig.thresholds?.maxBatteryTemp ?? 45,
          maxStorageUsage: currentConfig.thresholds?.maxStorageUsage ?? 90,
          minHashrate: currentConfig.thresholds?.minHashrate ?? 0,
          shareRatio: currentConfig.thresholds?.shareRatio ?? 0.5
        },
        schedules: {
          scheduledMining: {
            enabled: currentConfig.schedules?.scheduledMining?.enabled ?? false,
            periods: currentConfig.schedules?.scheduledMining?.periods || []
          },
          scheduledRestarts: currentConfig.schedules?.scheduledRestarts || []
        }
      };

      // Save the cleaned config
      const saved = this.saveConfig(cleanConfig);
      if (saved) {
        this.loggingService.log('✅ Config cleaned up successfully', 'INFO', 'config');
        this.loggingService.log(`📄 Cleaned config: ${JSON.stringify(cleanConfig)}`, 'DEBUG', 'config');
      }
      return saved;
    } catch (error) {
      this.loggingService.log(`❌ Failed to clean config: ${error.message}`, 'ERROR', 'config');
      return false;
    }
  }
}