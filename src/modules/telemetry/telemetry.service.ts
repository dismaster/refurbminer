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

@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly telemetryFilePath: string;
  private readonly historyFilePath: string;
  private updateInterval?: NodeJS.Timeout;
  private readonly MAX_HISTORY_POINTS = 20; // 1 hour of data at 1-minute intervals

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
  }

  private ensureStorageExists(): void {
    const storageDir = path.dirname(this.telemetryFilePath);
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
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

  /** Get telemetry data */
  async getTelemetryData() {
    try {
      const minerRunning = this.minerManagerService.isMinerRunning();
      const systemType = this.osDetectionService.detectOS();
      const previousData = this.getPreviousTelemetry();
    
      const minerSummary = await MinerSummaryUtil.getMinerSummary();
      const poolStats = await MinerPoolUtil.getPoolStatistics();
      
      // Get device info with systemUptime included
      const deviceInfo = HardwareInfoUtil.getDeviceInfo(systemType);
      const threadPerformance = await MinerThreadsUtil.getThreadPerformance();
      
      // Update the CPU model info with hashrates from threads
      if (deviceInfo.cpuModel && deviceInfo.cpuModel.length > 0) {
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
      }
    
      // Create API telemetry object without threads
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
          solvedBlocks: minerSummary.solvedBlocks,
          // Use more detailed status for mining
          miningStatus: this.minerManagerService.isManuallyStoppedByUser 
            ? 'manually_stopped' 
            : (minerRunning ? 'active' : 'stopped'),
        },
        pool: poolStats,
        deviceInfo: deviceInfo, // This now includes systemUptime
        network: NetworkInfoUtil.getNetworkInfo(systemType),
        battery: BatteryInfoUtil.getBatteryInfo(systemType)
      };
    
      // Get mining schedules in the correct format for telemetry
      const scheduleInfo = this.getMiningSchedule();
      
      // Create full telemetry object
      const fullTelemetry = {
        ...apiTelemetry,
        schedules: scheduleInfo, 
        historicalHashrate: this.updateHistoricalHashrate(
          previousData?.historicalHashrate || [],
          minerSummary?.hashrate
        )
      };
    
      // Save telemetry data
      await this.saveTelemetry(fullTelemetry);
      await this.saveHistoricalData(fullTelemetry.historicalHashrate);
    
      return apiTelemetry;
    } catch (error) {
      this.loggingService.log(`❌ Failed to get telemetry data: ${error.message}`, 'ERROR', 'telemetry');
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
        `⚠️ Failed to read previous telemetry: ${error.message}`,
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
    const tenMinutesAgo = now - (10 * 60); // Changed from 60 minutes to 10 minutes
  
    // Filter out data older than 10 minutes
    const filteredHistory = previousHistory.filter(entry => entry.timestamp > tenMinutesAgo);
  
    // Add new data point
    filteredHistory.push({
      timestamp: now,
      khs: currentHashrate
    });
  
    // Ensure we don't exceed maximum points (10 minutes)
    return filteredHistory.slice(-this.MAX_HISTORY_POINTS);
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
      fs.copyFileSync(this.telemetryFilePath, backupPath);
      
      // Clean up old backups - keep only 5 most recent backups
      this.cleanupOldBackups(this.telemetryFilePath, 5);
      
      this.loggingService.log('✅ Telemetry data updated', 'DEBUG', 'telemetry');
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to save telemetry: ${error.message}`,
        'ERROR',
        'telemetry'
      );
    }
  }

  // Removed redundant backupTelemetryFile method - functionality is now in cleanupOldBackups

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
        `❌ Failed to save historical data: ${error.message}`,
        'ERROR',
        'telemetry'
      );
    }
  }

  async getHistoricalData() {
    try {
      // Check if file exists
      if (await fs.promises.access(this.historyFilePath).then(() => true).catch(() => false)) {
        const data = await fs.promises.readFile(this.historyFilePath, 'utf8');
        
        // Try to parse the data
        try {
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
        `⚠️ Failed to read historical data: ${error.message}`,
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
  private cleanupOldBackups(filePath: string, maxBackups: number = 5): void {
    try {
      const dirPath = path.dirname(filePath);
      const fileName = path.basename(filePath);
      
      // Get all files in the directory
      const files = fs.readdirSync(dirPath);
      
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
        backupFiles.slice(maxBackups).forEach(file => {
          try {
            fs.unlinkSync(file.path);
            this.loggingService.log(
              `🗑️ Removed old telemetry backup: ${file.name}`,
              'DEBUG',
              'telemetry'
            );
          } catch (error: any) {
            this.loggingService.log(
              `Failed to delete backup ${file.name}: ${error.message}`,
              'WARN',
              'telemetry'
            );
          }
        });
      }
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to clean up backups: ${error.message}`,
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
      this.loggingService.log(`Failed to get mining schedule: ${error.message}`, 'ERROR', 'telemetry');
      return { mining: { enabled: false, periods: [] }, restarts: [] };
    }
  }
}