import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { FlightsheetService } from '../flightsheet/flightsheet.service';
import { ConfigService } from '../config/config.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';

@Injectable()
export class MinerManagerService implements OnModuleInit, OnApplicationShutdown {
  private static isInitialized = false;
  private minerScreen = 'miner-session';
  private pollingInterval?: NodeJS.Timeout;
  private scheduleInterval?: NodeJS.Timeout;
  private crashMonitorInterval?: NodeJS.Timeout;
  private crashCount = 0;
  private readonly MAX_CRASHES = 3;
  private lastCrashTime?: Date;

  constructor(
    private readonly loggingService: LoggingService,
    private readonly flightsheetService: FlightsheetService,
    private readonly configService: ConfigService,
    private readonly apiService: ApiCommunicationService
  ) {}

  async onModuleInit() {
    if (MinerManagerService.isInitialized) {
      this.loggingService.log('⚠️ MinerManager already initialized, skipping...', 'WARN', 'miner-manager');
      return;
    }

    MinerManagerService.isInitialized = true;
    this.loggingService.log('🚀 MinerManager initializing...', 'INFO', 'miner-manager');

    this.clearIntervals();
    await this.initializeMiner();
    await this.initializeMonitoring();
  }

  private clearIntervals(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      this.scheduleInterval = undefined;
    }
    if (this.crashMonitorInterval) {
      clearInterval(this.crashMonitorInterval);
      this.crashMonitorInterval = undefined;
    }
  }

  private async initializeMiner(): Promise<void> {
    try {
      this.stopMiner();

      const miner = this.getMinerFromFlightsheet();
      if (!miner) {
        const error = 'No miner found from flightsheet.';
        this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
        await this.logMinerError(error);
        return;
      }

      this.loggingService.log(`✅ Detected miner: ${miner}`, 'INFO', 'miner-manager');
      await this.fetchAndUpdateFlightsheet();
      this.startMiner();
    } catch (error) {
      await this.logMinerError(`Initialization failed: ${error.message}`, error.stack);
    }
  }

  private async initializeMonitoring(): Promise<void> {
    // Set up polling interval
    this.pollingInterval = setInterval(async () => {
      this.loggingService.log('🔄 Checking for flightsheet updates...', 'DEBUG', 'miner-manager');
      const updated = await this.fetchAndUpdateFlightsheet();
      if (updated) {
        await this.logMinerError('Flightsheet changed, restarting miner');
        this.restartMiner();
      }
    }, 60000);
  
    // Set up schedule interval
    this.scheduleInterval = setInterval(() => {
      this.checkSchedules();
    }, 60000);
  
    // Set up crash monitoring
    this.crashMonitorInterval = setInterval(() => {
      this.checkMinerHealth();
    }, 30000);
  }

  private async checkMinerHealth(): Promise<void> {
    try {
      if (this.shouldBeMining() && !this.isMinerRunning()) {
        this.crashCount++;
        const error = `Miner crash detected (Attempt ${this.crashCount}/${this.MAX_CRASHES})`;
        this.loggingService.log(`⚠️ ${error}`, 'WARN', 'miner-manager');
        await this.logMinerError(error);

        if (this.crashCount >= this.MAX_CRASHES) {
          const criticalError = 'Maximum crash count reached. Stopping miner...';
          this.loggingService.log(`❌ ${criticalError}`, 'ERROR', 'miner-manager');
          await this.logMinerError(criticalError);
          return;
        }

        this.restartMiner();
      } else {
        this.crashCount = 0;
      }
    } catch (error) {
      await this.logMinerError(`Health check failed: ${error.message}`, error.stack);
    }
  }

  private shouldBeMining(): boolean {
      const config = this.configService.getConfig();
      if (!config || !config.schedules.scheduledMining.enabled) return true;

      const now = new Date();
      const currentDay = now.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
      const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

      return config.schedules.scheduledMining.periods.some(period =>
        period.days.includes(currentDay) &&
        this.isTimeInRange(currentTime, period.startTime, period.endTime)
      );
  }

  public getMinerFromFlightsheet(): string | undefined {
    try {
      const minerFolders = fs.readdirSync('apps').filter(folder =>
        fs.existsSync(`apps/${folder}/config.json`)
      );

      if (minerFolders.length === 0) {
        return undefined;
      }

      const flightsheetPath = `apps/${minerFolders[0]}/config.json`;
      const flightsheet = JSON.parse(fs.readFileSync(flightsheetPath, 'utf8'));

      return flightsheet.minerSoftware ?? undefined;
    } catch {
      return undefined;
    }
  }

  public isMinerRunning(): boolean {
    try {
      const output = execSync(`screen -ls | grep ${this.minerScreen}`, { encoding: 'utf8' });
      return output.includes(this.minerScreen);
    } catch {
      return false;
    }
  }

  public startMiner(): boolean {
    try {
      const miner = this.getMinerFromFlightsheet();
      if (!miner) {
        const error = 'Cannot start miner: No miner found in flightsheet';
        this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
        this.logMinerError(error);
        return false;
      }

      const configPath = `apps/${miner}/config.json`;
      const minerExecutable = `apps/${miner}/${miner}`;

      if (!fs.existsSync(configPath) || !fs.existsSync(minerExecutable)) {
        const error = `Cannot start miner: Missing files at ${configPath} or ${minerExecutable}`;
        this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
        this.logMinerError(error);
        return false;
      }

      execSync(`chmod +x ${minerExecutable}`);
      exec(`screen -dmS ${this.minerScreen} ${minerExecutable} -c ${configPath}`);

      this.loggingService.log(`✅ Started miner: ${miner} with config ${configPath}`, 'INFO', 'miner-manager');
      return true;
    } catch (error) {
      this.logMinerError(`Failed to start miner: ${error.message}`, error.stack);
      return false;
    }
  }

  public stopMiner(): boolean {
    try {
      if (!this.isMinerRunning()) {
        this.loggingService.log('ℹ️ No miner session found to stop', 'INFO', 'miner-manager');
        return true;
      }

      execSync(`screen -X -S ${this.minerScreen} quit`);
      this.loggingService.log('✅ Miner stopped successfully', 'INFO', 'miner-manager');
      return true;
    } catch (error) {
      this.logMinerError(`Failed to stop miner: ${error.message}`, error.stack);
      return false;
    }
  }

  public async restartMiner(): Promise<boolean> {
    this.loggingService.log('🔄 Restarting miner...', 'INFO', 'miner-manager');
    const stopped = this.stopMiner();
    if (!stopped) {
      const error = 'Failed to restart: Could not stop miner';
      this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
      await this.logMinerError(error);
      return false;
    }

    const started = this.startMiner();
    if (!started) {
      const error = 'Failed to restart: Could not start miner';
      this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
      await this.logMinerError(error);
      return false;
    }

    this.loggingService.log('✅ Miner restarted successfully', 'INFO', 'miner-manager');
    return true;
  }

  async fetchAndUpdateFlightsheet(): Promise<boolean> {
    try {
      const updated = await this.flightsheetService.updateFlightsheet();
      const miner = this.getMinerFromFlightsheet();

      if (!miner) {
        await this.logMinerError('No miner found from flightsheet.');
        return false;
      }

      return updated;
    } catch (error) {
      await this.logMinerError(`Failed to update flightsheet: ${error.message}`, error.stack);
      return false;
    }
  }

  private checkSchedules() {
    const config = this.configService.getConfig();
    if (!config) return;
    
    const now = new Date();
    const currentDay = now.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    // Check scheduled mining periods
    if (config.schedules.scheduledMining.enabled) {
      const periods = config.schedules.scheduledMining.periods;
      for (const period of periods) {
        if (period.days.includes(currentDay)) {
          if (this.isTimeInRange(currentTime, period.startTime, period.endTime)) {
            if (!this.isMinerRunning()) {
              this.loggingService.log(`⏰ Starting miner for scheduled period: ${period.startTime} - ${period.endTime} on ${currentDay}`, 'INFO', 'miner-manager');
              this.startMiner();
            }
            return;
          }
        }
      }
      if (this.isMinerRunning()) {
        this.loggingService.log(`⏰ Stopping miner outside scheduled periods on ${currentDay}`, 'INFO', 'miner-manager');
        this.stopMiner();
      }
    }

    // Check scheduled restarts
    const restarts = config.schedules.scheduledRestarts;
    for (const restartTime of restarts) {
      // Since scheduledRestarts is now a string array, compare directly with currentTime
      if (currentTime === restartTime) {
        this.loggingService.log(`⏰ Restarting miner for scheduled restart at ${restartTime} on ${currentDay}`, 'INFO', 'miner-manager');
        this.restartMiner();
      }
    }
  }

  private isTimeInRange(currentTime: string, startTime: string, endTime: string): boolean {
    if (startTime < endTime) {
      return currentTime >= startTime && currentTime <= endTime;
    } else {
      return currentTime >= startTime || currentTime <= endTime;
    }
  }

  private async logMinerError(message: string, stack?: string): Promise<void> {
    try {
      const config = this.configService.getConfig();
      if (!config?.minerId) {
        this.loggingService.log('❌ Cannot log error: No minerId found', 'ERROR', 'miner-manager');
        return;
      }

      const additionalInfo = {
        minerSoftware: this.getMinerFromFlightsheet(),
        wasRunning: this.isMinerRunning(),
        crashCount: this.crashCount,
        lastCrashTime: this.lastCrashTime?.toISOString(),
        timestamp: new Date().toISOString()
      };

      await this.apiService.logMinerError(
        config.minerId,
        message,
        stack || '',
        additionalInfo
      );

      this.lastCrashTime = new Date();
      this.loggingService.log('✅ Miner error logged to API', 'INFO', 'miner-manager');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to log miner error to API: ${error.message}`,
        'ERROR',
        'miner-manager'
      );
    }
  }

  onApplicationShutdown() {
    this.clearIntervals();
    MinerManagerService.isInitialized = false;
    this.stopMiner();
    this.loggingService.log('🛑 MinerManager shutdown complete', 'INFO', 'miner-manager');
  }
}