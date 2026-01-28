import { Injectable, OnModuleInit, OnApplicationShutdown, Inject, forwardRef } from '@nestjs/common';
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

// Support both string format (from config file) and object format (from API)
type ScheduledRestartEntry = string | ScheduledRestart;

// Interface for API response to ensure type safety
interface ApiConfigResponse {
  minerId?: string;
  rigId?: string;
  name?: string;
  minerSoftware?: string;
  benchmark?: boolean; // Boolean flag indicating if benchmark is active
  thresholds?: {
    maxCpuTemp?: number;
    maxBatteryTemp?: number;
    maxStorageUsage?: number;
    minHashrate?: number;
    shareRatio?: number;
  };
  schedules?: {
    scheduledMining?: {
      enabled?: boolean;
      periods?: SchedulePeriod[];
    };
    scheduledRestarts?: ScheduledRestartEntry[];
  };
}

// Match database structure where scheduledRestarts is array of objects
interface Config {
  minerId: string;
  rigId: string;
  name: string;
  minerSoftware?: string; // Current selected miner software (xmrig, ccminer, etc.)
  benchmark?: boolean; // Boolean flag indicating if benchmark is active
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
    scheduledRestarts: ScheduledRestartEntry[]; // Array of strings like ["03:00"] or objects like [{time: "16:00", days: ["monday"]}]
  };
}

@Injectable()
export class ConfigService implements OnModuleInit, OnApplicationShutdown {
  private configPath = path.join(process.cwd(), 'config', 'config.json');
  private syncInterval?: NodeJS.Timeout;
  private apiUrl: string;
  private readonly MAX_BACKUPS = 5; // Maximum number of backup files to keep

  // Enhanced cache to prevent excessive file reads within the same minute
  private configCache: { data: Config | null; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60000; // 1 minute - longer cache for better performance
  private isLoading: boolean = false; // Prevent multiple simultaneous reads
  private writeQueue: Promise<void> = Promise.resolve();

  // API response cache to prevent excessive API calls
  private apiCache: {
    data: ApiConfigResponse | null;
    timestamp: number;
  } | null = null;
  private readonly API_CACHE_TTL = 30000; // 30 seconds for API responses

  private lastSyncSuccessAt?: string;

  constructor(
    @Inject(forwardRef(() => LoggingService))
    private readonly loggingService: LoggingService,
    private readonly httpService: HttpService,
  ) {
    this.apiUrl = process.env.API_URL || 'https://api.refurbminer.de';
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const tempPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tempPath, filePath);
      })
      .catch((error) => {
        this.loggingService.log(
          `❌ Config write failed: ${error instanceof Error ? error.message : String(error)}`,
          'ERROR',
          'config',
        );
        throw error;
      });

    return this.writeQueue;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async onModuleInit() {
    // Create config directory if it doesn't exist
    const configDir = path.join(process.cwd(), 'config');
    await fs.promises.mkdir(configDir, { recursive: true });

    // Check if config exists and is valid, restore from backup if needed
    const configValid = await this.ensureValidConfig();

    if (!configValid) {
      this.loggingService.log(
        'Failed to ensure valid config even after backup restoration attempts',
        'ERROR',
        'config',
      );
    }

    // IMPORTANT: Do NOT sync with API during module initialization
    // This prevents gathering wrong data before miner registration is complete
    // The sync will be triggered by BootstrapService after successful registration
    const config = await this.getConfig();
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

  onApplicationShutdown(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      this.loggingService.log(
        '🛑 Config sync stopped',
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
      // Set up periodic sync every minute as required for real-time config updates
      this.syncInterval = setInterval(
        () => {
          void this.syncConfigWithApi();
        },
        60 * 1000, // 1 minute - config must be fresh for minute-based schedule checks
      );
    }
  }

  async getConfig(): Promise<Config | null> {
    try {
      // Check if cache is still valid
      const now = Date.now();
      if (
        this.configCache &&
        now - this.configCache.timestamp < this.CACHE_TTL
      ) {
        // Only log in DEBUG to reduce noise in logs
        this.loggingService.log(
          '📋 Using cached config data',
          'DEBUG',
          'config',
        );
        return this.configCache.data;
      }

      // Prevent multiple simultaneous reads
      if (this.isLoading) {
        this.loggingService.log(
          '⏳ Config read already in progress, returning cached version',
          'DEBUG',
          'config',
        );
        return this.configCache?.data || null;
      }

      this.isLoading = true;

      // Only log file reads in DEBUG to reduce noise
      this.loggingService.log(
        `📂 Reading config from: ${this.configPath}`,
        'DEBUG',
        'config',
      );

      if (!(await this.fileExists(this.configPath))) {
        this.isLoading = false;
        throw new Error('Config file not found');
      }

      const configData = await fs.promises.readFile(this.configPath, 'utf8');
      const config: Config = JSON.parse(configData);

      if (!this.validateConfigStructure(config)) {
        this.isLoading = false;
        this.loggingService.log(
          '❌ Config schema validation failed',
          'ERROR',
          'config',
        );
        return null;
      }

      // Update cache
      this.configCache = { data: config, timestamp: now };
      this.isLoading = false;

      // Only log successful loads in DEBUG to reduce noise
      this.loggingService.log(
        '✅ Config loaded successfully and cached',
        'DEBUG',
        'config',
      );
      return config;
    } catch (error) {
      this.isLoading = false;
      this.loggingService.log(
        `❌ Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return null;
    }
  }

  async saveConfig(config: Config): Promise<boolean> {
    try {
      // Write new config atomically
      await this.writeJsonAtomic(this.configPath, config);

      // Update cache with the new config instead of invalidating it
      // This prevents unnecessary file reads right after saving
      this.configCache = { data: config, timestamp: Date.now() };

      // Only create backup if not too recent
      await this.createBackupIfNeeded();

      this.loggingService.log(
        '✅ Config saved successfully',
        'DEBUG',
        'config',
      );

      return true;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to save config: ${error instanceof Error ? error.message : String(error)}`,
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

  async getMinerId(): Promise<string> {
    const config = await this.getConfig();
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

      const currentConfig = await this.getConfig();
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
      const url = `${this.apiUrl}/api/miners/config?rigToken=${rigToken}&minerId=${currentConfig.minerId}`;
      this.loggingService.log(
        `📡 Fetching config from: ${url}`,
        'DEBUG',
        'config',
      );

      const response = (await Promise.race([
        firstValueFrom(this.httpService.get(url)),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Config sync timeout after 20 seconds')),
            20000,
          ),
        ),
      ])) as any;

      if (response.status !== 200) {
        throw new Error(`API returned ${response.status}`);
      }

      this.lastSyncSuccessAt = new Date().toISOString();
      this.loggingService.log(
        `✅ Config sync successful at ${this.lastSyncSuccessAt}`,
        'DEBUG',
        'config',
      );

      // Type-safe API response handling
      const apiConfig = response.data as ApiConfigResponse;
      this.loggingService.log(
        `📥 Received config data: ${JSON.stringify(apiConfig)}`,
        'DEBUG',
        'config',
      );

      if (!this.validateApiConfig(apiConfig)) {
        this.loggingService.log(
          '⚠️ API config validation failed, skipping apply',
          'WARN',
          'config',
        );
        return false;
      }

      // Only log minerSoftware changes, not every sync
      if (
        apiConfig.minerSoftware &&
        apiConfig.minerSoftware !== currentConfig.minerSoftware
      ) {
        this.loggingService.log(
          `🔄 Miner software changing: ${currentConfig.minerSoftware} → ${apiConfig.minerSoftware}`,
          'INFO',
          'config',
        );
      }

      // Log benchmark flag changes
      if (
        apiConfig.benchmark !== undefined &&
        apiConfig.benchmark !== currentConfig.benchmark
      ) {
        this.loggingService.log(
          `🧪 Benchmark mode changing: ${currentConfig.benchmark ?? false} → ${apiConfig.benchmark}`,
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
        benchmark: apiConfig.benchmark ?? currentConfig.benchmark ?? false, // Sync benchmark flag from backend
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

      await this.saveConfig(updatedConfig);

      // Update cache immediately with the new config to prevent unnecessary file reads
      this.configCache = { data: updatedConfig, timestamp: Date.now() };

      this.loggingService.log(
        '✅ Config synchronized with API successfully',
        'DEBUG',
        'config',
      );
      // Only log the final config in DEBUG, not INFO
      this.loggingService.log(
        `🎯 Final config: ${JSON.stringify(updatedConfig)}`,
        'DEBUG',
        'config',
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.message?.includes('timeout')) {
        this.loggingService.log(
          '⏰ Config sync timed out after 20 seconds',
          'WARN',
          'config',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to sync config with API: ${error instanceof Error ? error.message : String(error)}`,
          'ERROR',
          'config',
        );
      }
      return false;
    }
  }

  private validateApiConfig(apiConfig: ApiConfigResponse): boolean {
    if (!apiConfig || typeof apiConfig !== 'object') {
      return false;
    }

    if (apiConfig.benchmark !== undefined && typeof apiConfig.benchmark !== 'boolean') {
      return false;
    }

    if (apiConfig.minerSoftware !== undefined && typeof apiConfig.minerSoftware !== 'string') {
      return false;
    }

    if (apiConfig.thresholds) {
      const { maxCpuTemp, maxBatteryTemp, maxStorageUsage, minHashrate, shareRatio } = apiConfig.thresholds;
      const numericFields = [maxCpuTemp, maxBatteryTemp, maxStorageUsage, minHashrate, shareRatio];
      if (numericFields.some((value) => value !== undefined && typeof value !== 'number')) {
        return false;
      }
    }

    if (apiConfig.schedules) {
      const { scheduledMining, scheduledRestarts } = apiConfig.schedules;
      if (scheduledMining?.enabled !== undefined && typeof scheduledMining.enabled !== 'boolean') {
        return false;
      }
      if (scheduledMining?.periods && !Array.isArray(scheduledMining.periods)) {
        return false;
      }
      if (scheduledRestarts && !Array.isArray(scheduledRestarts)) {
        return false;
      }
    }

    return true;
  }

  private validateConfigStructure(config: any): config is Config {
    if (!config || typeof config !== 'object') {
      return false;
    }

    if (typeof config.minerId !== 'string') {
      return false;
    }

    if (typeof config.rigId !== 'string') {
      return false;
    }

    if (typeof config.name !== 'string') {
      return false;
    }

    if (config.minerSoftware !== undefined && typeof config.minerSoftware !== 'string') {
      return false;
    }

    if (config.benchmark !== undefined && typeof config.benchmark !== 'boolean') {
      return false;
    }

    const thresholds = config.thresholds;
    if (!thresholds || typeof thresholds !== 'object') {
      return false;
    }

    const numericFields = [
      thresholds.maxCpuTemp,
      thresholds.maxBatteryTemp,
      thresholds.maxStorageUsage,
      thresholds.minHashrate,
      thresholds.shareRatio,
    ];
    if (numericFields.some((value) => typeof value !== 'number')) {
      return false;
    }

    const schedules = config.schedules;
    if (!schedules || typeof schedules !== 'object') {
      return false;
    }

    if (
      !schedules.scheduledMining ||
      typeof schedules.scheduledMining !== 'object' ||
      typeof schedules.scheduledMining.enabled !== 'boolean' ||
      !Array.isArray(schedules.scheduledMining.periods)
    ) {
      return false;
    }

    if (!Array.isArray(schedules.scheduledRestarts)) {
      return false;
    }

    for (const period of schedules.scheduledMining.periods) {
      if (!period || typeof period !== 'object') {
        return false;
      }
      if (typeof period.startTime !== 'string' || typeof period.endTime !== 'string') {
        return false;
      }
      if (!Array.isArray(period.days) || period.days.some((day: any) => typeof day !== 'string')) {
        return false;
      }
    }

    return true;
  }

  getLastSyncSuccessAt(): string | undefined {
    return this.lastSyncSuccessAt;
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
      const currentConfig = await this.getConfig();
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
      const saved = await this.saveConfig(cleanConfig);
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
        `❌ Failed to clean config: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Cleans up old backup files, keeping only the most recent ones
   */
  private async cleanupConfigBackups(): Promise<void> {
    try {
      const dirPath = path.dirname(this.configPath);
      const fileName = path.basename(this.configPath);

      // Check if directory exists first
      if (!(await this.fileExists(dirPath))) {
        this.loggingService.log(
          `Directory does not exist: ${dirPath}`,
          'DEBUG',
          'config',
        );
        return;
      }

      // Get all files in the directory with timeout protection
      const files = await Promise.race([
        fs.promises.readdir(dirPath),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error('Directory read timeout')), 5000),
        ),
      ]);

      // Filter for backup files matching our pattern with better validation
      const backupFiles = files
        .filter((file) => {
          // More strict pattern matching
          const pattern = new RegExp(
            `^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.bak$`,
          );
          return pattern.test(file);
        })
        .map((file) => {
          // Extract timestamp more safely
          const timestampMatch = file.match(/\.(\d+)\.bak$/);
          const timestamp = timestampMatch
            ? parseInt(timestampMatch[1], 10)
            : 0;

          // Validate timestamp (should be reasonable Unix timestamp)
          const isValidTimestamp =
            timestamp > 1000000000 && timestamp < Date.now() + 86400000;

          return {
            name: file,
            path: path.join(dirPath, file),
            timestamp: isValidTimestamp ? timestamp : 0,
            isValid: isValidTimestamp,
          };
        })
        .filter((file) => file.isValid) // Only keep files with valid timestamps
        .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first

      this.loggingService.log(
        `Found ${backupFiles.length} valid config backup files`,
        'DEBUG',
        'config',
      );

      // Remove older backups if we have more than MAX_BACKUPS
      if (backupFiles.length > this.MAX_BACKUPS) {
        const filesToDelete = backupFiles.slice(this.MAX_BACKUPS);

        // Delete files in parallel with individual error handling
        const deletePromises = filesToDelete.map(async (file) => {
          try {
            // Check if file still exists before attempting to delete
            if (await this.fileExists(file.path)) {
              await Promise.race([
                fs.promises.unlink(file.path),
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error('Config file deletion timeout after 5 seconds')),
                    5000,
                  ),
                ),
              ]);
              this.loggingService.log(
                `🗑️ Removed old config backup: ${file.name}`,
                'DEBUG',
                'config',
              );
              return { success: true, file: file.name };
            } else {
              this.loggingService.log(
                `Config backup file already removed: ${file.name}`,
                'DEBUG',
                'config',
              );
              return { success: true, file: file.name, skipped: true };
            }
          } catch (error) {
            this.loggingService.log(
              `Failed to delete config backup ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'WARN',
              'config',
            );
            return { success: false, file: file.name, error };
          }
        });

        // Wait for all deletions with timeout protection
        const results = await Promise.allSettled(
          deletePromises.map((p) =>
            Promise.race([
              p,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Delete timeout')), 10000),
              ),
            ]),
          ),
        );

        // Log summary of cleanup results
        const successful = results.filter(
          (r) => r.status === 'fulfilled',
        ).length;
        const failed = results.filter((r) => r.status === 'rejected').length;

        this.loggingService.log(
          `Config backup cleanup completed: ${successful} successful, ${failed} failed`,
          failed > 0 ? 'WARN' : 'DEBUG',
          'config',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to clean up config backups: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'config',
      );
      // Don't throw error to prevent blocking the main config process
    }
  }

  /**
   * Get the currently configured miner software
   */
  async getMinerSoftware(): Promise<string | undefined> {
    const config = await this.getConfig();
    return config?.minerSoftware;
  }

  /**
   * Get the benchmark flag
   */
  async getBenchmarkFlag(): Promise<boolean> {
    const config = await this.getConfig();
    return config?.benchmark ?? false;
  }

  /**
   * Set the current miner software in config
   */
  async setMinerSoftware(minerSoftware: string): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config) {
        this.loggingService.log(
          '❌ Cannot set miner software: Config not found',
          'ERROR',
          'config',
        );
        return false;
      }

      config.minerSoftware = minerSoftware;
      await fs.promises.writeFile(this.configPath, JSON.stringify(config, null, 2));

      this.loggingService.log(
        `✅ Miner software updated to: ${minerSoftware}`,
        'INFO',
        'config',
      );
      return true;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to set miner software: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Force refresh of config cache - useful when external changes are made
   */
  refreshCache(): void {
    this.configCache = null;
    this.loggingService.log(
      '🔄 Config cache cleared - next access will read from disk',
      'DEBUG',
      'config',
    );
  }

  /**
   * Clear API cache to force fresh API call
   */
  clearApiCache(): void {
    this.apiCache = null;
    this.loggingService.log(
      '🔄 API cache cleared - next sync will fetch fresh data',
      'DEBUG',
      'config',
    );
  }

  /**
   * Ensure config file exists and is valid, restore from backup if necessary
   */
  private async ensureValidConfig(): Promise<boolean> {
    try {
      // First, check if config file exists
      if (!(await this.fileExists(this.configPath))) {
        this.loggingService.log(
          'Config file not found, attempting to restore from backup...',
          'WARN',
          'config',
        );

        if (await this.restoreFromLatestBackup()) {
          this.loggingService.log(
            'Successfully restored config from backup',
            'INFO',
            'config',
          );
          return true;
        } else {
          this.loggingService.log(
            'No valid backup found, creating default config',
            'WARN',
            'config',
          );
          return this.createDefaultConfig();
        }
      }

      // Config file exists, check if it's valid
      try {
        const configContent = (await fs.promises.readFile(this.configPath, 'utf8')).trim();

        // Check if file is empty
        if (!configContent) {
          this.loggingService.log(
            'Config file is empty, attempting to restore from backup...',
            'WARN',
            'config',
          );

          if (await this.restoreFromLatestBackup()) {
            this.loggingService.log(
              'Successfully restored empty config from backup',
              'INFO',
              'config',
            );
            return true;
          } else {
            this.loggingService.log(
              'No valid backup found for empty config, creating default config',
              'WARN',
              'config',
            );
            return this.createDefaultConfig();
          }
        }

        // Try to parse the config
        const config = JSON.parse(configContent);

        if (!this.validateConfigStructure(config)) {
          throw new Error('Config failed schema validation');
        }

        this.loggingService.log(
          'Existing config file is valid',
          'DEBUG',
          'config',
        );

        // Clean up the config to ensure consistent structure
        await this.cleanupConfig();
        return true;
      } catch (parseError) {
        this.loggingService.log(
          `Config file is corrupted: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          'WARN',
          'config',
        );

        // Backup the corrupted file
        const timestamp = Date.now();
        const corruptedBackupPath = `${this.configPath}.corrupted.${timestamp}.bak`;
        try {
          await fs.promises.copyFile(this.configPath, corruptedBackupPath);
          this.loggingService.log(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            'INFO',
            'config',
          );
        } catch (backupError) {
          this.loggingService.log(
            `Failed to backup corrupted config: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
            'WARN',
            'config',
          );
        }

        // Try to restore from backup
        if (await this.restoreFromLatestBackup()) {
          this.loggingService.log(
            'Successfully restored corrupted config from backup',
            'INFO',
            'config',
          );
          return true;
        } else {
          this.loggingService.log(
            'No valid backup found for corrupted config, creating default config',
            'WARN',
            'config',
          );
          return this.createDefaultConfig();
        }
      }
    } catch (error) {
      this.loggingService.log(
        `Failed to ensure valid config: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Restore config from the latest valid backup
   */
  private async restoreFromLatestBackup(): Promise<boolean> {
    try {
      const dirPath = path.dirname(this.configPath);
      const fileName = path.basename(this.configPath);

      // Get all backup files
      const files = await fs.promises.readdir(dirPath);
      const backupFiles = files
        .filter(
          (file) => file.startsWith(`${fileName}.`) && file.endsWith('.bak'),
        )
        .filter((file) => !file.includes('corrupted')) // Exclude corrupted backups
        .map((file) => ({
          name: file,
          path: path.join(dirPath, file),
          timestamp:
            parseInt(
              file.replace(`${fileName}.`, '').replace('.bak', ''),
              10,
            ) || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first

      this.loggingService.log(
        `Found ${backupFiles.length} backup files to check`,
        'DEBUG',
        'config',
      );

      // Try each backup file until we find a valid one
      for (const backupFile of backupFiles) {
        try {
          this.loggingService.log(
            `Attempting to restore from backup: ${backupFile.name}`,
            'DEBUG',
            'config',
          );

          const backupContent = (await fs.promises.readFile(backupFile.path, 'utf8')).trim();

          // Skip empty backups
          if (!backupContent) {
            this.loggingService.log(
              `Backup ${backupFile.name} is empty, trying next...`,
              'DEBUG',
              'config',
            );
            continue;
          }

          // Try to parse the backup
          const backupConfig = JSON.parse(backupContent);

          // Basic validation
          if (!backupConfig || typeof backupConfig !== 'object') {
            this.loggingService.log(
              `Backup ${backupFile.name} is not a valid object, trying next...`,
              'DEBUG',
              'config',
            );
            continue;
          }

          if (!this.validateConfigStructure(backupConfig)) {
            this.loggingService.log(
              `Backup ${backupFile.name} failed schema validation, trying next...`,
              'DEBUG',
              'config',
            );
            continue;
          }

          // This backup looks valid, restore it
          await fs.promises.copyFile(backupFile.path, this.configPath);

          // Clear cache to force reload
          this.configCache = null;

          this.loggingService.log(
            `Successfully restored config from backup: ${backupFile.name}`,
            'INFO',
            'config',
          );

          // Verify the restored config
          const restoredConfig = await this.getConfig();
          if (restoredConfig && restoredConfig.minerId) {
            this.loggingService.log(
              `Restored config contains minerId: ${restoredConfig.minerId}`,
              'INFO',
              'config',
            );
          }

          return true;
        } catch (backupError) {
          this.loggingService.log(
            `Backup ${backupFile.name} is corrupted: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
            'DEBUG',
            'config',
          );
          continue; // Try next backup
        }
      }

      this.loggingService.log(
        'No valid backups found for restoration',
        'WARN',
        'config',
      );
      return false;
    } catch (error) {
      this.loggingService.log(
        `Failed to restore from backup: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Create a default config file
   */
  private async createDefaultConfig(): Promise<boolean> {
    try {
      const defaultConfig: Config = {
        minerId: '',
        rigId: '',
        name: 'Unnamed Rig',
        minerSoftware: undefined, // Will be synced from backend API after registration
        benchmark: false, // Default benchmark mode to false
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
      };

      await this.saveConfig(defaultConfig);

      this.loggingService.log('Created default config file', 'INFO', 'config');

      return true;
    } catch (error) {
      this.loggingService.log(
        `Failed to create default config: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'config',
      );
      return false;
    }
  }

  /**
   * Create a backup if it hasn't been created recently
   */
  private async createBackupIfNeeded(): Promise<void> {
    try {
      if (!(await this.fileExists(this.configPath))) {
        return;
      }

      // Check if we created a backup in the last 5 minutes
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      const dirPath = path.dirname(this.configPath);
      const fileName = path.basename(this.configPath);

      const files = await fs.promises.readdir(dirPath);
      const recentBackups = files.filter((file) => {
        if (!file.startsWith(`${fileName}.`) || !file.endsWith('.bak'))
          return false;

        const timestampMatch = file.match(/\.(\d+)\.bak$/);
        if (!timestampMatch) return false;

        const timestamp = parseInt(timestampMatch[1], 10);
        return timestamp > fiveMinutesAgo;
      });

      if (recentBackups.length === 0) {
        const timestamp = Date.now();
        const backupPath = `${this.configPath}.${timestamp}.bak`;
        await fs.promises.copyFile(this.configPath, backupPath);
        this.loggingService.log(
          `📦 Config backup created: ${backupPath}`,
          'DEBUG',
          'config',
        );

        // Clean up old backups asynchronously to prevent blocking
        setImmediate(() => {
          this.cleanupConfigBackups().catch((error) => {
            this.loggingService.log(
              `Background config backup cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'WARN',
              'config',
            );
          });
        });
      }
    } catch (error) {
      this.loggingService.log(
        `Failed to create config backup: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'config',
      );
    }
  }
}
