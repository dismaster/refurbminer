import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { LoggingService } from '../logging/logging.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { OsDetectionService } from '../device-monitoring/os-detection/os-detection.service';
import { ConfigService } from '../config/config.service';
import { HardwareInfoUtil } from './utils/hardware/hardware-info.util';
import { NetworkInfoUtil } from './utils/network-info.util';
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

  constructor(
    private readonly loggingService: LoggingService,
    private readonly minerManagerService: MinerManagerService,
    private readonly osDetectionService: OsDetectionService,
    private readonly configService: ConfigService
  ) {
    this.telemetryFilePath = path.join(process.cwd(), 'storage', 'telemetry.json');
    this.historyFilePath = path.join(process.cwd(), 'storage', 'hashrate-history.json');
    this.ensureStorageExists();
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

    // Update telemetry and historical data every minute
    this.updateInterval = setInterval(async () => {
      await this.getTelemetryData();
    }, 60000);
  }

  /** Get telemetry data with comprehensive error handling */
  async getTelemetryData() {
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
        () => HardwareInfoUtil.getDeviceInfo(systemType),
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
          deviceInfo.cpuModel = deviceInfo.cpuModel.map((cpu, index) => {
            // Find matching thread data by coreId
            const threadData = threadPerformance.find(t => t.coreId === cpu.coreId) ||
                              threadPerformance[index] || 
                              { khs: 0 };
            
            return {
              ...cpu,
              khs: threadData.khs || 0
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
      
      // Create API telemetry object
      const apiTelemetry = {
        status: 'active', // App is running, so always 'active'
        minerSoftware: {
          name: minerSummary.name,
          version: minerSummary.version,
          algorithm: minerSummary.algorithm,
          hashrate: minerSummary.hashrate,
          acceptedShares: minerSummary.acceptedShares,
          rejectedShares: minerSummary.rejectedShares,
          uptime: minerSummary.uptime,
          solvedBlocks: minerSummary.solvedBlocks,          // Use more detailed status for mining
          miningStatus: isManuallyStoppedByUser 
            ? 'manually_stopped' 
            : (minerRunning ? 'active' : 'stopped'),
        },
        pool: poolStats,
        deviceInfo: deviceInfo,
        network: network,
        battery: battery
      };
    
      // Get mining schedules with error handling
      const scheduleInfo = safeExecute(
        () => this.getMiningSchedule(),
        { mining: { enabled: false, periods: [] }, restarts: [] },
        'mining schedule retrieval',
        this.loggingService.log.bind(this.loggingService)
      );
      
      // Create full telemetry object
      const fullTelemetry = {
        ...apiTelemetry,
        schedules: scheduleInfo,
        historicalHashrate: this.updateHistoricalHashrate(
          previousData?.historicalHashrate || [],
          minerSummary?.hashrate
        )
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
    previousHistory: Array<{ timestamp: number; khs: number }>,
    currentHashrate?: number
  ): Array<{ timestamp: number; khs: number }> {
    if (!currentHashrate) return previousHistory;
  
    const now = Math.floor(Date.now() / 1000);
    const sixtyMinutesAgo = now - (60 * 60); // Keep one hour of data for monitoring trends
  
    try {
      // Filter out data older than 60 minutes, keeping latest MAX_HISTORY_POINTS
      const filteredHistory = previousHistory
        .filter(entry => entry.timestamp > sixtyMinutesAgo)
        .slice(-this.MAX_HISTORY_POINTS + 1); // +1 to make room for the new point
    
      // Add new data point
      filteredHistory.push({
        timestamp: now,
        khs: currentHashrate
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
      
      // Create backup with cleanup of old backups
      const timestamp = Date.now();
      const backupPath = `${this.telemetryFilePath}.${timestamp}.bak`;
      
      await fs.promises.copyFile(this.telemetryFilePath, backupPath);
      
      // Clean up old backups using MAX_BACKUPS setting
      await this.cleanupOldBackups(this.telemetryFilePath, this.MAX_BACKUPS);
      
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

  private async saveHistoricalData(data: Array<{ timestamp: number; khs: number }>) {
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
      
      // Get all files in the directory
      const files = await fs.promises.readdir(dirPath);
      
      // Filter for backup files matching our pattern
      const backupFiles = files
        .filter(file => file.startsWith(`${fileName}.`) && file.endsWith('.bak'))
        .map(file => ({
          name: file,
          path: path.join(dirPath, file),
          // Extract timestamp from filename
          timestamp: parseInt(file.replace(`${fileName}.`, '').replace('.bak', ''), 10) || 0
        }))
        .sort((a, b) => b.timestamp - a.timestamp); // Sort newest first
      
      // Remove older backups if we have more than maxBackups
      if (backupFiles.length > maxBackups) {
        for (const file of backupFiles.slice(maxBackups)) {
          try {
            await fs.promises.unlink(file.path);
            this.loggingService.log(
              `🗑️ Removed old telemetry backup: ${file.name}`,
              'DEBUG',
              'telemetry'
            );
          } catch (error) {
            this.loggingService.log(
              `Failed to delete backup ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'WARN',
              'telemetry'
            );
          }
        }
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to clean up backups: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ERROR',
        'telemetry'
      );
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
}
