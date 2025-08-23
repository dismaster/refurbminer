import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { LoggingService } from '../logging/logging.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { OsDetectionService } from '../device-monitoring/os-detection/os-detection.service';
import { ConfigService } from '../config/config.service';
import { HardwareInfoUtil } from './utils/hardware/hardware-info.util';
import { NetworkInfoUtil, TelemetryData } from './utils/network-info.util';
import { BatteryInfoUtil } from './utils/battery-info.util';

// Miner utilities
import { MinerSummaryUtil } from './utils/miner/miner-summary.util';
import { MinerPoolUtil } from './utils/miner/miner-pool.util';
import { MinerThreadsUtil } from './utils/miner/miner-threads.util';

// Import safe execution helpers
import { safeExecute, safeExecuteAsync } from './safe-execute';

@Injectable()
export class EnhancedTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly telemetryFilePath: string;
  private readonly historyFilePath: string;
  private updateInterval?: NodeJS.Timeout;
  // Increasing data points to 60 for 1 hour of data (every minute)
  private readonly MAX_HISTORY_POINTS = 60;
  // Added backup limits for telemetry
  private readonly MAX_BACKUPS = 5;
  private readonly appVersion: string;

  constructor(
    private readonly loggingService: LoggingService,
    private readonly minerManagerService: MinerManagerService,
    private readonly osDetectionService: OsDetectionService,
    private readonly configService: ConfigService
  ) {
    this.telemetryFilePath = path.join(process.cwd(), 'storage', 'telemetry.json');
    this.historyFilePath = path.join(process.cwd(), 'storage', 'hashrate-history.json');
    this.ensureStorageExists();
    
    // Load app version from package.json
    this.appVersion = this.getAppVersion();
  }

  async onModuleInit() {
    this.startDataCollection();
  }
  
  onModuleDestroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Cleanup resources used by utility classes
    this.loggingService.log('🧹 Cleaning up telemetry resources', 'DEBUG', 'telemetry');
    
    // Use safe execution to prevent any errors during cleanup
    safeExecute(
      () => NetworkInfoUtil.cleanup(),
      undefined,
      'network cleanup',
      this.loggingService.log.bind(this.loggingService)
    );
  }

  private ensureStorageExists(): void {
    try {
      const storageDir = path.dirname(this.telemetryFilePath);
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to ensure storage directory exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
    }
  }

  private startDataCollection() {
    // Clear existing interval if any
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    // Clear any stale telemetry data on startup
    this.clearStaleData();

    // Collect telemetry data immediately on startup with retry
    this.getTelemetryDataWithRetry().catch(error => {
      this.loggingService.log(
        `❌ Failed to collect initial telemetry data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
    });

    // Update telemetry and historical data every 60 seconds
    this.updateInterval = setInterval(async () => {
      await this.getTelemetryData();
    }, 60000);
  }

  /** Clear stale telemetry data on startup */
  private clearStaleData(): void {
    try {
      const emptyTelemetry = {
        status: 'initializing',
        appVersion: this.appVersion,
        minerSoftware: {
          name: 'unknown',
          version: 'unknown',
          algorithm: 'unknown',
          hashrate: 0,
          acceptedShares: 0,
          rejectedShares: 0,
          uptime: 0,
          solvedBlocks: 0,
          difficulty: 0,
          miningStatus: 'initializing'
        },
        pool: {},
        deviceInfo: {},
        network: {},
        battery: {},
        schedules: { mining: { start: null, stop: null }, restarts: [] },
        historicalHashrate: []
      };
      
      // Ensure directory exists
      this.ensureStorageExists();
      
      // Write fresh empty telemetry
      fs.writeFileSync(
        this.telemetryFilePath,
        JSON.stringify(emptyTelemetry, null, 2),
        'utf8'
      );
      
      this.loggingService.log(
        '🗑️ Cleared stale telemetry data on startup',
        'DEBUG',
        'telemetry'
      );
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to clear stale telemetry data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'telemetry'
      );
    }
  }

  /** Get telemetry data with retry logic and timeout protection */
  private async getTelemetryDataWithRetry(maxRetries: number = 3): Promise<TelemetryData | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add timeout protection to prevent hanging
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Telemetry collection timeout after 30 seconds'));
          }, 30000); // 30 second timeout per attempt
        });

        const telemetryPromise = this.getTelemetryData();
        
        // Race between telemetry collection and timeout
        const data = await Promise.race([telemetryPromise, timeoutPromise]);
        
        if (data) {
          this.loggingService.log(
            `✅ Successfully collected fresh telemetry data (attempt ${attempt}/${maxRetries})`,
            'DEBUG',
            'telemetry'
          );
          return data;
        }
      } catch (error) {
        this.loggingService.log(
          `⚠️ Telemetry collection attempt ${attempt}/${maxRetries} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'WARN',
          'telemetry'
        );
      }
      
      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    
    this.loggingService.log(
      `❌ All telemetry collection attempts failed after ${maxRetries} retries`,
      'ERROR',
      'telemetry'
    );
    return null;
  }

  /** Get telemetry data with comprehensive error handling */
  async getTelemetryData(): Promise<TelemetryData | null> {
    try {
      // Core system data - use safe sync operations
      const minerRunning = safeExecute(
        () => this.minerManagerService.isMinerRunning(),
        false, 
        'miner running check',
        this.loggingService.log.bind(this.loggingService)
      );
      
      const systemType = safeExecute(
        () => this.osDetectionService.detectOS(),
        'unknown',
        'OS detection',
        this.loggingService.log.bind(this.loggingService)
      );
        // Get previous telemetry data with error handling
      const previousData = safeExecute(
        () => this.getPreviousTelemetry(),
        null,
        'previous telemetry retrieval',
        this.loggingService.log.bind(this.loggingService)
      );

      // Get manual stop status safely
      const isManuallyStoppedByUser = safeExecute(
        () => this.minerManagerService.isManuallyStoppedByUser,
        false,
        'manual stop status check',
        this.loggingService.log.bind(this.loggingService)
      );

      // Async data gathering with proper error handling and retries
      const minerSummaryPromise = safeExecuteAsync(
        () => MinerSummaryUtil.getMinerSummary(),
        {
          name: 'Unknown',
          version: '0.0.0',
          hashrate: 0,
          acceptedShares: 0,
          rejectedShares: 0,
          uptime: 0,
          algorithm: 'Unknown',
          solvedBlocks: 0
        },
        'miner summary retrieval',
        3, // 3 retries
        1000, // 1 second between retries
        this.loggingService.log.bind(this.loggingService)
      );
      
      const poolStatsPromise = safeExecuteAsync(
        () => MinerPoolUtil.getPoolStatistics(),
        { name: 'Unknown', hashrate: 0, miners: 0, workers: 0 },
        'pool statistics retrieval',
        3,
        1000,
        this.loggingService.log.bind(this.loggingService)
      );
      
      // Get device info with system uptime using safe execution
      const deviceInfo = safeExecute(
        () => HardwareInfoUtil.getDeviceInfo(systemType, this.loggingService.log.bind(this.loggingService)),
        {
          cpuModel: [],
          cpuUsage: 0,
          cpuTemp: 0,
          memTotal: 0,
          memFree: 0,
          diskTotal: 0,
          diskFree: 0,
          systemUptime: 0
        },
        'hardware info retrieval',
        this.loggingService.log.bind(this.loggingService)
      );
      
      const threadPerformancePromise = safeExecuteAsync(
        () => MinerThreadsUtil.getThreadPerformance(),
        [],
        'thread performance retrieval',
        3,
        1000,
        this.loggingService.log.bind(this.loggingService)
      );
      
      // Wait for all async operations to complete with proper error handling
      const [minerSummary, poolStats, threadPerformance] = await Promise.all([
        minerSummaryPromise,
        poolStatsPromise,
        threadPerformancePromise
      ]);
      
      // Update the CPU model info with hashrates from threads with error handling
      if (deviceInfo.cpuModel && deviceInfo.cpuModel.length > 0) {
        try {
          deviceInfo.cpuModel = deviceInfo.cpuModel.map((cpu, index) => {            // Find matching thread data by coreId
            const threadData = threadPerformance.find(t => t.coreId === cpu.coreId) ||
                              threadPerformance[index] || 
                              { hashrate: 0 };
            
            return {
              ...cpu,
              hashrate: threadData.hashrate || 0
            };
          });
        } catch (err) {
          this.loggingService.log(
            `⚠️ Error updating CPU model with thread performance: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'WARN',
            'telemetry'
          );
        }
      }
    
      // Get network info with error handling
      const network = safeExecute(
        () => NetworkInfoUtil.getNetworkInfo(systemType),
        {
          primaryIp: 'Unknown',
          externalIp: 'Unknown', 
          gateway: 'Unknown',
          interfaces: ['Unknown'],
          ping: { refurbminer: -1 },
          traffic: { rxBytes: 0, txBytes: 0, rxSpeed: 0, txSpeed: 0, timestamp: Date.now() }
        },
        'network info retrieval',
        this.loggingService.log.bind(this.loggingService)
      );
      
      // Get battery info with error handling
      const battery = safeExecute(
        () => BatteryInfoUtil.getBatteryInfo(systemType),
        { level: 0, isCharging: false, temperature: 0 },
        'battery info retrieval',
        this.loggingService.log.bind(this.loggingService)
      );
      // Create API telemetry object with explicit structure to prevent extra variables
      const apiTelemetry = {
        status: 'active',
        appVersion: this.appVersion,
        minerSoftware: {
          name: minerSummary.name,
          version: minerSummary.version,
          algorithm: minerSummary.algorithm,
          hashrate: minerRunning ? (Number(minerSummary.hashrate) || 0) : 0,
          acceptedShares: minerRunning ? minerSummary.acceptedShares : 0,
          rejectedShares: minerRunning ? minerSummary.rejectedShares : 0,
          uptime: minerRunning ? minerSummary.uptime : 0,
          solvedBlocks: minerRunning ? minerSummary.solvedBlocks : 0,
          difficulty: minerRunning ? poolStats.difficulty : 0,
          miningStatus: isManuallyStoppedByUser 
            ? 'manually_stopped' 
            : (minerRunning ? 'active' : 'stopped'),
        },
        pool: {
          name: poolStats.name,
          url: poolStats.url,
          user: poolStats.user,
          acceptedShares: minerRunning ? poolStats.acceptedShares : 0,
          rejectedShares: minerRunning ? poolStats.rejectedShares : 0,
          staleShares: minerRunning ? poolStats.staleShares : 0,
          ping: minerRunning ? poolStats.ping : 0,
          uptime: minerRunning ? poolStats.uptime : 0
        },
        deviceInfo: deviceInfo,
        network: network,
        battery: battery
      };

      // Clean the telemetry object to remove any unwanted root-level variables
      const cleanedTelemetry = this.cleanTelemetryStructure(apiTelemetry);
    
      // Get mining schedules with error handling
      const scheduleInfo = safeExecute(
        () => this.getMiningSchedule(),
        { mining: { enabled: false, periods: [] }, restarts: [] },
        'mining schedule retrieval',
        this.loggingService.log.bind(this.loggingService),
      );
      
      // Create full telemetry object
      const fullTelemetry = {
        ...cleanedTelemetry,
        schedules: scheduleInfo,
        historicalHashrate: this.updateHistoricalHashrate(
          previousData?.historicalHashrate || [],
          minerSummary?.hashrate,
        ),
      };
    
      // Save telemetry data with error handling
      await safeExecuteAsync(
        () => this.saveTelemetry(fullTelemetry),
        undefined,
        'telemetry data saving',
        3,
        1000,
        this.loggingService.log.bind(this.loggingService)
      );
      
      await safeExecuteAsync(
        () => this.saveHistoricalData(fullTelemetry.historicalHashrate),
        undefined,
        'historical data saving',
        3,
        1000,
        this.loggingService.log.bind(this.loggingService)
      );
    
      return apiTelemetry;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to get telemetry data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
      return null;
    }
  }

  /**
   * Clean telemetry structure to remove unwanted root-level variables
   * @param telemetry Raw telemetry object
   * @returns Cleaned telemetry object with only allowed root-level fields
   */
  private cleanTelemetryStructure(telemetry: any): any {
    // Define allowed root-level fields
    const allowedRootFields = [
      'status',
      'appVersion',
      'minerSoftware',
      'pool',
      'deviceInfo',
      'network',
      'battery',
    ];

    // Create clean object with only allowed fields
    const cleanedTelemetry: any = {};

    for (const field of allowedRootFields) {
      if (telemetry[field] !== undefined) {
        cleanedTelemetry[field] = telemetry[field];
      }
    }

    // Log if we removed any unwanted fields
    const originalFields = Object.keys(telemetry);
    const removedFields = originalFields.filter(
      (field) => !allowedRootFields.includes(field),
    );

    if (removedFields.length > 0) {
      this.loggingService.log(
        `🧹 Removed unwanted root-level telemetry fields: ${removedFields.join(', ')}`,
        'DEBUG',
        'telemetry',
      );
    }

    return cleanedTelemetry;
  }

  private getPreviousTelemetry(): any {
    try {
      if (fs.existsSync(this.telemetryFilePath)) {
        const rawData = fs.readFileSync(this.telemetryFilePath, 'utf8');
        
        try {
          // Try to parse and validate the JSON
          const parsedData = JSON.parse(rawData);
          
          // Basic validation of required fields
          if (typeof parsedData === 'object' && parsedData !== null) {
            return parsedData;
          } else {
            throw new Error('Invalid telemetry data structure');
          }
        } catch (parseError) {
          // If JSON is invalid, backup the corrupted file and create new one
          const backupPath = `${this.telemetryFilePath}.${Date.now()}.bak`;
          fs.renameSync(this.telemetryFilePath, backupPath);
          
          this.loggingService.log(
            `📦 Corrupted telemetry file backed up to: ${backupPath}`,
            'WARN',
            'telemetry'
          );
          
          // Create new empty telemetry file
          const emptyTelemetry = {
            status: 'stopped',
            minerSoftware: {},
            pool: {},
            deviceInfo: {},
            network: {},
            battery: {},
            schedules: { mining: { start: null, stop: null }, restarts: [] },
            historicalHashrate: []
          };
          
          fs.writeFileSync(
            this.telemetryFilePath,
            JSON.stringify(emptyTelemetry, null, 2),
            'utf8'
          );
          
          return emptyTelemetry;
        }
      }
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to read previous telemetry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'telemetry'
      );
    }
    return null;
  }
    private updateHistoricalHashrate(
    previousHistory: Array<{ timestamp: number; hashrate: number }>,
    currentHashrate?: number
  ): Array<{ timestamp: number; hashrate: number }> {
    if (currentHashrate === undefined || currentHashrate === null) {
      return previousHistory;
    }
  
    const now = Math.floor(Date.now() / 1000);
    const sixtyMinutesAgo = now - (60 * 60); // Keep one hour of data for monitoring trends
  
    try {
      // Filter out data older than 60 minutes, keeping latest MAX_HISTORY_POINTS
      const filteredHistory = previousHistory
        .filter(entry => entry.timestamp > sixtyMinutesAgo)
        .slice(-this.MAX_HISTORY_POINTS + 1); // +1 to make room for the new point
    
      // Add new data point (currentHashrate should already be in hash/s from CCMiner conversion)
      filteredHistory.push({
        timestamp: now,
        hashrate: currentHashrate // hashrate is now in hash/s for both miners
      });
    
      // Ensure we don't exceed maximum points
      return filteredHistory.slice(-this.MAX_HISTORY_POINTS);
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to update historical hashrate: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'telemetry'
      );
      
      // Return original data in case of error
      return previousHistory;
    }
  }

  private async saveTelemetry(data: any) {
    try {
      await fs.promises.writeFile(
        this.telemetryFilePath,
        JSON.stringify(data, null, 2),
        'utf8'
      );

      // Only create backup if file was successfully written and not too recent
      const shouldCreateBackup = await this.shouldCreateBackup();
      if (shouldCreateBackup) {
        const timestamp = Date.now();
        const backupPath = `${this.telemetryFilePath}.${timestamp}.bak`;
        
        try {
          await fs.promises.copyFile(this.telemetryFilePath, backupPath);
          
          // Clean up old backups asynchronously to prevent blocking
          setImmediate(() => {
            this.cleanupOldBackups(this.telemetryFilePath, this.MAX_BACKUPS).catch(error => {
              this.loggingService.log(
                `Background backup cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'WARN',
                'telemetry'
              );
            });
          });
        } catch (backupError) {
          this.loggingService.log(
            `Failed to create backup: ${backupError instanceof Error ? backupError.message : 'Unknown error'}`,
            'WARN',
            'telemetry'
          );
        }
      }
      
      this.loggingService.log('✅ Telemetry data updated', 'DEBUG', 'telemetry');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to save telemetry: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
      throw error; // Re-throw to allow retry mechanism to work
    }
  }

  private async saveHistoricalData(data: Array<{ timestamp: number; hashrate: number }>) {
    try {
      // Ensure the data is an array
      if (!Array.isArray(data)) {
        throw new Error('Historical data must be an array');
      }
  
      // Ensure the storage directory exists
      await fs.promises.mkdir(path.dirname(this.historyFilePath), { recursive: true });
  
      // Format data for storage
      const formattedData = JSON.stringify(data, null, 2);
  
      // Write to file
      await fs.promises.writeFile(this.historyFilePath, formattedData, 'utf8');
      this.loggingService.log('📊 Historical data updated', 'DEBUG', 'telemetry');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to save historical data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
      throw error; // Re-throw to allow retry mechanism to work
    }
  }

  async getHistoricalData() {
    try {
      // Check if file exists
      if (await fs.promises.access(this.historyFilePath).then(() => true).catch(() => false)) {
        const data = await fs.promises.readFile(this.historyFilePath, 'utf8');
        
        try {
          // Try to parse the data
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed)) {
            throw new Error('Historical data is not an array');
          }
          return parsed;
        } catch (parseError) {
          // If parsing fails, return empty array and create new file
          await this.saveHistoricalData([]);
          return [];
        }
      }
      
      // If file doesn't exist, create it with empty array
      await this.saveHistoricalData([]);
      return [];
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to read historical data: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'telemetry'
      );
      return [];
    }
  }

  /**
   * Cleans up old backup files, keeping only the most recent ones
   * @param filePath Path to the original file (not the backup)
   * @param maxBackups Maximum number of backup files to keep
   */
  private async cleanupOldBackups(filePath: string, maxBackups: number = this.MAX_BACKUPS): Promise<void> {
    try {
      const dirPath = path.dirname(filePath);
      const fileName = path.basename(filePath);
      
      // Check if directory exists first
      if (!await fs.promises.access(dirPath).then(() => true).catch(() => false)) {
        this.loggingService.log(`Directory does not exist: ${dirPath}`, 'DEBUG', 'telemetry');
        return;
      }
      
      // Get all files in the directory with timeout protection
      const files = await Promise.race([
        fs.promises.readdir(dirPath),
        new Promise<string[]>((_, reject) => 
          setTimeout(() => reject(new Error('Directory read timeout')), 5000)
        )
      ]);
      
      // Filter for backup files matching our pattern with better validation
      const backupFiles = files
        .filter(file => {
          // More strict pattern matching
          const pattern = new RegExp(`^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.bak$`);
          return pattern.test(file);
        })
        .map(file => {
          // Extract timestamp more safely
          const timestampMatch = file.match(/\.(\d+)\.bak$/);
          const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : 0;
          
          // Validate timestamp (should be reasonable Unix timestamp)
          const isValidTimestamp = timestamp > 1000000000 && timestamp < Date.now() + 86400000; // Not too old, not in future
          
          return {
            name: file,
            path: path.join(dirPath, file),
            timestamp: isValidTimestamp ? timestamp : 0,
            isValid: isValidTimestamp
          };
        })
        .filter(file => file.isValid) // Only keep files with valid timestamps
        .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first
      
      this.loggingService.log(
        `Found ${backupFiles.length} valid backup files for ${fileName}`,
        'DEBUG',
        'telemetry'
      );
      
      // Remove older backups if we have more than maxBackups
      if (backupFiles.length > maxBackups) {
        const filesToDelete = backupFiles.slice(maxBackups);
        
        // Delete files in parallel with individual error handling
        const deletePromises = filesToDelete.map(async (file) => {
          try {
            // Check if file still exists before attempting to delete
            if (await fs.promises.access(file.path).then(() => true).catch(() => false)) {
              await fs.promises.unlink(file.path);
              this.loggingService.log(
                `🗑️ Removed old telemetry backup: ${file.name}`,
                'DEBUG',
                'telemetry'
              );
              return { success: true, file: file.name };
            } else {
              this.loggingService.log(
                `Backup file already removed: ${file.name}`,
                'DEBUG',
                'telemetry'
              );
              return { success: true, file: file.name, skipped: true };
            }
          } catch (error) {
            this.loggingService.log(
              `Failed to delete backup ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'WARN',
              'telemetry'
            );
            return { success: false, file: file.name, error };
          }
        });
        
        // Wait for all deletions with timeout protection
        const results = await Promise.allSettled(
          deletePromises.map(p => 
            Promise.race([
              p,
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Delete timeout')), 10000)
              )
            ])
          )
        );
        
        // Log summary of cleanup results
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        
        this.loggingService.log(
          `Backup cleanup completed: ${successful} successful, ${failed} failed`,
          failed > 0 ? 'WARN' : 'DEBUG',
          'telemetry'
        );
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to clean up backups: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
      // Don't throw error to prevent blocking the main telemetry process
    }
  }

  /**
   * Check if we should create a backup (prevent too frequent backups)
   */
  private async shouldCreateBackup(): Promise<boolean> {
    try {
      const dirPath = path.dirname(this.telemetryFilePath);
      const fileName = path.basename(this.telemetryFilePath);
      
      // Check if we created a backup in the last 5 minutes
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      
      const files = await fs.promises.readdir(dirPath);
      const recentBackups = files.filter(file => {
        if (!file.startsWith(`${fileName}.`) || !file.endsWith('.bak')) return false;
        
        const timestampMatch = file.match(/\.(\d+)\.bak$/);
        if (!timestampMatch) return false;
        
        const timestamp = parseInt(timestampMatch[1], 10);
        return timestamp > fiveMinutesAgo;
      });
      
      return recentBackups.length === 0;
    } catch (error) {
      // If check fails, allow backup creation
      return true;
    }
  }

  private getMiningSchedule() {
    try {
      const config = this.configService.getConfig();
      if (!config) {
        return { mining: { enabled: false, periods: [] }, restarts: [] };
      }
      
      // Transform config schedules to expected telemetry format
      return {
        mining: {
          enabled: config.schedules.scheduledMining.enabled,
          periods: config.schedules.scheduledMining.periods.map(period => ({
            // Map startTime/endTime to start/end for telemetry format
            start: period.startTime, 
            end: period.endTime,
            days: period.days
          }))
        },
        restarts: config.schedules.scheduledRestarts
      };
    } catch (error) {
      this.loggingService.log(
        `Failed to get mining schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
      return { mining: { enabled: false, periods: [] }, restarts: [] };
    }
  }

  private getAppVersion(): string {
    try {
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || '0.0.0';
      }
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to read app version: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WARN',
        'telemetry'
      );
    }
    return '0.0.0';
  }

  getAppInfo() {
    return {
      version: this.appVersion
    };
  }
}
