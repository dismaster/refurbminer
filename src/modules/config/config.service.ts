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
        minerId: this.generateMinerId(),
        rigId: '',
        name: 'Unnamed Rig',
        thresholds: {
          maxCpuTemp: 85,
          maxBatteryTemp: 45,
          maxStorageUsage: 90,
          minHashrate: 0,
          shareRatio: 0.5
        },
        schedules: {
          scheduledMining: {
            enabled: false,
            periods: [],
          },
          scheduledRestarts: [], // Array of times
        },
      });
    }

    // Sync with API on startup
    await this.syncConfigWithApi();

    // Set up periodic sync (every 15 minutes)
    this.syncInterval = setInterval(async () => {
      await this.syncConfigWithApi();
    }, 15 * 60 * 1000);
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
    return config?.minerId || this.generateMinerId();
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

      const currentConfig = this.getConfig();
      if (!currentConfig) {
        this.loggingService.log('⚠️ Cannot sync config: Local config not found', 'WARN', 'config');
        return false;
      }

      // Ensure thresholds exist in current config
      if (!currentConfig.thresholds) {
        currentConfig.thresholds = {
          maxCpuTemp: 85,
          maxBatteryTemp: 45,
          maxStorageUsage: 90,
          minHashrate: 0,
          shareRatio: 0.5
        };
      }
      
      // Ensure name exists
      if (!currentConfig.name) {
        currentConfig.name = 'Unnamed Rig';
      }

      this.loggingService.log('🔄 Syncing configuration with API...', 'INFO', 'config');
      
      // Get miner configuration from API - fixed endpoint URL
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
      
      // Create a deep copy of the current config as a base
      const updatedConfig = JSON.parse(JSON.stringify(currentConfig));

      // Update with API values using a more defensive approach
      updatedConfig.minerId = apiConfig.minerId || updatedConfig.minerId;
      updatedConfig.rigId = apiConfig.rigId || updatedConfig.rigId;
      updatedConfig.name = apiConfig.name || updatedConfig.name;
      
      // Handle thresholds safely
      if (apiConfig.thresholds) {
        updatedConfig.thresholds = {
          maxCpuTemp: apiConfig.thresholds.maxCpuTemp ?? updatedConfig.thresholds.maxCpuTemp,
          maxBatteryTemp: apiConfig.thresholds.maxBatteryTemp ?? updatedConfig.thresholds.maxBatteryTemp,
          maxStorageUsage: apiConfig.thresholds.maxStorageUsage ?? updatedConfig.thresholds.maxStorageUsage,
          minHashrate: apiConfig.thresholds.minHashrate ?? updatedConfig.thresholds.minHashrate,
          shareRatio: apiConfig.thresholds.shareRatio ?? updatedConfig.thresholds.shareRatio
        };
      }
      
      // Handle schedules safely
      if (apiConfig.schedules) {
        updatedConfig.schedules = {
          scheduledMining: apiConfig.schedules.scheduledMining || {
            enabled: false,
            periods: []
          },
          scheduledRestarts: apiConfig.schedules.scheduledRestarts || []
        };
      }

      // Save updated config
      const saved = this.saveConfig(updatedConfig);
      if (saved) {
        this.loggingService.log('✅ Config synchronized with API successfully', 'INFO', 'config');
        this.loggingService.log(`📄 Updated config: ${JSON.stringify(updatedConfig)}`, 'DEBUG', 'config');
      }
      return saved;

    } catch (error) {
      this.loggingService.log(`❌ Failed to sync config with API: ${error.message}`, 'ERROR', 'config');
      this.loggingService.log(`❌ Error stack: ${error.stack}`, 'DEBUG', 'config');
      return false;
    }
  }

  /**
   * Generate a unique miner ID if one doesn't exist
   */
  private generateMinerId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `miner-${timestamp}-${random}`;
  }
}