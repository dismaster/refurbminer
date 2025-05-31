import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { FlightsheetService } from '../flightsheet/flightsheet.service';
import { ConfigService } from '../config/config.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';

@Injectable()
export class MinerManagerService
  implements OnModuleInit, OnApplicationShutdown
{
  private static isInitialized = false;
  private minerScreen = 'miner-session';
  private pollingInterval?: NodeJS.Timeout;
  private scheduleInterval?: NodeJS.Timeout;
  private crashMonitorInterval?: NodeJS.Timeout;
  private crashCount = 0;
  private readonly MAX_CRASHES = 3;
  private lastCrashTime?: Date;
  // Add new properties to track manual stop status
  public isManuallyStoppedByUser = false;
  private manualStopTime?: Date;
  private readonly MANUAL_STOP_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly loggingService: LoggingService,
    private readonly flightsheetService: FlightsheetService,
    private readonly configService: ConfigService,
    private readonly apiService: ApiCommunicationService,
  ) {}

  async onModuleInit() {
    if (MinerManagerService.isInitialized) {
      this.loggingService.log(
        '⚠️ MinerManager already initialized, skipping...',
        'WARN',
        'miner-manager',
      );
      return;
    }

    MinerManagerService.isInitialized = true;
    this.loggingService.log(
      '🚀 MinerManager initializing...',
      'INFO',
      'miner-manager',
    );

    this.clearIntervals();
    await this.initializeMiner();
    this.initializeMonitoring();
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
        const error =
          'No miner found from flightsheet. Will try again after flightsheet is fetched.';
        this.loggingService.log(`⚠️ ${error}`, 'WARN', 'miner-manager');
        // Don't log as error since this is expected before flightsheet is fetched
        return;
      }

      this.loggingService.log(
        `✅ Detected miner: ${miner}`,
        'INFO',
        'miner-manager',
      );
      // No longer fetch flightsheet here - it will be triggered after registration
      this.startMiner();
    } catch (error) {
      await this.logMinerError(
        `Initialization failed: ${error.message}`,
        error.stack,
      );
    }
  }
  private initializeMonitoring(): void {
    // Set up polling interval for flightsheet updates - check every minute for faster response to user changes
    this.pollingInterval = setInterval(async () => {
      this.loggingService.log(
        '🔄 Checking for flightsheet updates...',
        'DEBUG',
        'miner-manager',
      );

      // Check flightsheet for changes
      // NOTE: We don't sync config here to avoid race conditions with BootstrapService
      // ConfigService will handle API sync after successful registration
      const updated = await this.fetchAndUpdateFlightsheet();
      if (updated) {
        await this.logMinerError('Flightsheet changed, restarting miner');
        void this.restartMiner();
      }
    }, 60000); // Every minute for faster response to user changes

    // Set up schedule interval - check more frequently (every minute)
    // Also sync config before checking to ensure latest schedule data
    this.scheduleInterval = setInterval(() => {
      // Use local config cache for more frequent checks
      // API sync happens in pollingInterval above
      this.checkSchedules();
    }, 60000);

    // Set up crash monitoring
    this.crashMonitorInterval = setInterval(() => {
      this.checkMinerHealth();
    }, 30000);

    // Run an initial schedule check and dump status
    // DO NOT sync with API here - this causes race condition before registration is complete
    // The BootstrapService will trigger the initial sync after successful registration
    this.checkSchedules();
    this.dumpScheduleStatus();

    // Log configuration for monitoring intervals
    this.loggingService.log(
      '📋 Schedule monitoring configured: Flightsheet check every minute, local schedule check every minute',
      'INFO',
      'miner-manager',
    );
  }

  private async checkMinerHealth(): Promise<void> {
    try {
      // Don't treat as crash if miner was manually stopped
      if (this.isManuallyStoppedByUser) {
        // After certain period (e.g., 10 minutes), reset the manual stop status
        const now = new Date();
        if (
          this.manualStopTime &&
          now.getTime() - this.manualStopTime.getTime() >
            this.MANUAL_STOP_TIMEOUT
        ) {
          this.loggingService.log(
            'ℹ️ Manual stop timeout expired, resuming normal monitoring',
            'INFO',
            'miner-manager',
          );
          this.isManuallyStoppedByUser = false;
          this.manualStopTime = undefined;
        } else {
          // Skip health check during manual stop period
          this.loggingService.log(
            'ℹ️ Miner is manually stopped, skipping health check',
            'DEBUG',
            'miner-manager',
          );
          return;
        }
      }

      if (this.shouldBeMining() && !this.isMinerRunning()) {
        this.crashCount++;
        const error = `Miner crash detected (Attempt ${this.crashCount}/${this.MAX_CRASHES})`;
        this.loggingService.log(`⚠️ ${error}`, 'WARN', 'miner-manager');
        await this.logMinerError(error);

        if (this.crashCount >= this.MAX_CRASHES) {
          const criticalError =
            'Maximum crash count reached. Stopping miner...';
          this.loggingService.log(
            `❌ ${criticalError}`,
            'ERROR',
            'miner-manager',
          );
          await this.logMinerError(criticalError);
          return;
        }

        this.restartMiner();
      } else {
        this.crashCount = 0;
      }
    } catch (error) {
      await this.logMinerError(
        `Health check failed: ${error.message}`,
        error.stack,
      );
    }
  }

  public shouldBeMining(): boolean {
    const config = this.configService.getConfig();
    if (!config) {
      this.loggingService.log(
        'ℹ️ No config available, defaulting to always mining',
        'DEBUG',
        'miner-manager',
      );
      return true;
    }

    if (!config.schedules.scheduledMining.enabled) {
      this.loggingService.log(
        'ℹ️ Scheduled mining disabled, mining allowed at any time',
        'DEBUG',
        'miner-manager',
      );
      return true;
    }

    const now = new Date();
    const currentDay = now
      .toLocaleString('en-US', { weekday: 'long' })
      .toLowerCase();
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    this.loggingService.log(
      `🕒 Checking if mining should run at ${currentTime} on ${currentDay}`,
      'DEBUG',
      'miner-manager',
    );

    // No periods configured means no mining allowed
    if (
      !config.schedules.scheduledMining.periods ||
      config.schedules.scheduledMining.periods.length === 0
    ) {
      this.loggingService.log(
        '⚠️ No mining periods configured, mining not allowed',
        'DEBUG',
        'miner-manager',
      );
      return false;
    }

    const shouldMine = config.schedules.scheduledMining.periods.some(
      (period) => {
        // Skip if period doesn't have required properties
        if (
          !period.days ||
          !Array.isArray(period.days) ||
          !period.startTime ||
          !period.endTime
        ) {
          this.loggingService.log(
            `⚠️ Invalid period configuration: ${JSON.stringify(period)}`,
            'WARN',
            'miner-manager',
          );
          return false;
        }

        const inDay = period.days.includes(currentDay);
        const inTimeRange = this.isTimeInRange(
          currentTime,
          period.startTime,
          period.endTime,
        );

        if (inDay && inTimeRange) {
          this.loggingService.log(
            `✅ Current time ${currentTime} is within schedule ${period.startTime}-${period.endTime} on ${currentDay}`,
            'DEBUG',
            'miner-manager',
          );
          return true;
        }
        return false;
      },
    );

    if (!shouldMine) {
      this.loggingService.log(
        `❌ Current time ${currentTime} is outside of all scheduled mining periods`,
        'DEBUG',
        'miner-manager',
      );
    }

    return shouldMine;
  }

  public getMinerFromFlightsheet(): string | undefined {
    try {
      const minerFolders = fs
        .readdirSync('apps')
        .filter((folder) => fs.existsSync(`apps/${folder}/config.json`));

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
      const output = execSync(`screen -ls | grep ${this.minerScreen}`, {
        encoding: 'utf8',
      });
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
      exec(
        `screen -dmS ${this.minerScreen} ${minerExecutable} -c ${configPath}`,
      );

      this.loggingService.log(
        `✅ Started miner: ${miner} with config ${configPath}`,
        'INFO',
        'miner-manager',
      );
      return true;
    } catch (error) {
      this.logMinerError(
        `Failed to start miner: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  public stopMiner(isManualStop: boolean = false): boolean {
    try {
      if (!this.isMinerRunning()) {
        this.loggingService.log(
          'ℹ️ No miner session found to stop',
          'INFO',
          'miner-manager',
        );
        return true;
      }

      execSync(`screen -X -S ${this.minerScreen} quit`);

      // Set the manual stop flag if applicable
      if (isManualStop) {
        this.isManuallyStoppedByUser = true;
        this.manualStopTime = new Date();
        this.loggingService.log(
          '✋ Miner manually stopped by user',
          'INFO',
          'miner-manager',
        );
      } else {
        this.loggingService.log(
          '✅ Miner stopped successfully',
          'INFO',
          'miner-manager',
        );
      }

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

    this.loggingService.log(
      '✅ Miner restarted successfully',
      'INFO',
      'miner-manager',
    );
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
      await this.logMinerError(
        `Failed to update flightsheet: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Call this after successful registration to trigger initial flightsheet fetch and start miner
   */
  public async triggerInitialFlightsheetFetchAndStart(): Promise<void> {
    try {
      this.loggingService.log(
        '📡 Triggering initial flightsheet fetch after registration...',
        'INFO',
        'miner-manager',
      );

      const updated = await this.fetchAndUpdateFlightsheet();
      if (updated) {
        this.loggingService.log(
          '✅ Flightsheet fetched successfully, attempting to start miner...',
          'INFO',
          'miner-manager',
        );

        const miner = this.getMinerFromFlightsheet();
        if (miner) {
          this.startMiner();
        } else {
          this.loggingService.log(
            '❌ No miner found in flightsheet after fetch',
            'ERROR',
            'miner-manager',
          );
        }
      } else {
        this.loggingService.log(
          '⚠️ Flightsheet fetch did not result in updates',
          'WARN',
          'miner-manager',
        );
      }
    } catch (error) {
      await this.logMinerError(
        `Failed to trigger initial flightsheet fetch: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
    }
  }

  private checkSchedules() {
    const config = this.configService.getConfig();
    if (!config) {
      this.loggingService.log(
        '⚠️ Cannot check schedules: No config found',
        'WARN',
        'miner-manager',
      );
      return;
    }

    const now = new Date();
    const currentDay = now
      .toLocaleString('en-US', { weekday: 'long' })
      .toLowerCase();
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    this.loggingService.log(
      `🕒 Checking schedules at ${currentTime} on ${currentDay}`,
      'DEBUG',
      'miner-manager',
    );

    // Check scheduled mining periods
    if (config.schedules?.scheduledMining?.enabled) {
      const periods = config.schedules.scheduledMining.periods || [];

      let shouldMine = false;

      // First check if we're in any mining period
      for (const period of periods) {
        // Safety check for period properties
        if (
          !period.days ||
          !Array.isArray(period.days) ||
          !period.startTime ||
          !period.endTime
        ) {
          this.loggingService.log(
            `⚠️ Invalid period configuration: ${JSON.stringify(period)}`,
            'WARN',
            'miner-manager',
          );
          continue;
        }

        if (period.days.includes(currentDay)) {
          if (
            this.isTimeInRange(currentTime, period.startTime, period.endTime)
          ) {
            shouldMine = true;
            if (!this.isMinerRunning()) {
              this.loggingService.log(
                `⏰ Starting miner for scheduled period: ${period.startTime} - ${period.endTime} on ${currentDay}`,
                'INFO',
                'miner-manager',
              );
              this.startMiner();
            } else {
              this.loggingService.log(
                `✅ Miner already running as scheduled: ${period.startTime} - ${period.endTime} on ${currentDay}`,
                'DEBUG',
                'miner-manager',
              );
            }
            break;
          }
        }
      }

      // If we shouldn't be mining but miner is running, stop it
      if (!shouldMine && this.isMinerRunning()) {
        this.loggingService.log(
          `⏰ Stopping miner outside scheduled periods on ${currentDay} at ${currentTime}`,
          'INFO',
          'miner-manager',
        );
        this.stopMiner();
      }
    } else {
      // If scheduling is disabled, make sure miner is running
      if (!this.isMinerRunning()) {
        this.loggingService.log(
          'ℹ️ Schedule disabled, ensuring miner is running',
          'DEBUG',
          'miner-manager',
        );
        this.startMiner();
      }
    }

    // Check scheduled restarts - independent of mining schedule
    const restarts = config.schedules?.scheduledRestarts || [];
    for (const restartTime of restarts) {
      // Since scheduledRestarts is now a string array, compare directly with currentTime
      if (currentTime === restartTime) {
        this.loggingService.log(
          `⏰ Restarting miner for scheduled restart at ${restartTime} on ${currentDay}`,
          'INFO',
          'miner-manager',
        );
        // Use void to silence the unhandled promise warning
        void this.restartMiner();
      }
    }
  }

  private isTimeInRange(
    currentTime: string,
    startTime: string,
    endTime: string,
  ): boolean {
    // Convert all times to minutes for easier comparison
    const current = this.timeToMinutes(currentTime);
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);

    // Log the comparison for debugging
    this.loggingService.log(
      `⏱️ Time comparison - Current: ${currentTime}(${current}), Start: ${startTime}(${start}), End: ${endTime}(${end})`,
      'DEBUG',
      'miner-manager',
    );

    // Normal time range (e.g., 08:00-17:00)
    if (start <= end) {
      return current >= start && current <= end;
    }
    // Overnight time range (e.g., 22:00-06:00)
    else {
      return current >= start || current <= end;
    }
  }

  // Helper to convert HH:MM to minutes
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private async logMinerError(message: string, stack?: string): Promise<void> {
    try {
      const config = this.configService.getConfig();
      if (!config?.minerId) {
        this.loggingService.log(
          '❌ Cannot log error: No minerId found',
          'ERROR',
          'miner-manager',
        );
        return;
      }

      const additionalInfo = {
        minerSoftware: this.getMinerFromFlightsheet(),
        wasRunning: this.isMinerRunning(),
        crashCount: this.crashCount,
        lastCrashTime: this.lastCrashTime?.toISOString(),
        timestamp: new Date().toISOString(),
      };

      await this.apiService.logMinerError(
        config.minerId,
        message,
        stack || '',
        additionalInfo,
      );

      this.lastCrashTime = new Date();
      this.loggingService.log(
        '✅ Miner error logged to API',
        'INFO',
        'miner-manager',
      );
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to log miner error to API: ${error.message}`,
        'ERROR',
        'miner-manager',
      );
    }
  }

  /**
   * Debug function to dump current schedule status
   */
  private dumpScheduleStatus(): void {
    try {
      const config = this.configService.getConfig();
      if (!config) {
        this.loggingService.log(
          'No config available for schedule status',
          'DEBUG',
          'miner-manager',
        );
        return;
      }

      const now = new Date();
      const currentDay = now
        .toLocaleString('en-US', { weekday: 'long' })
        .toLowerCase();
      const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

      const schedulingEnabled =
        config.schedules?.scheduledMining?.enabled || false;
      const periods = config.schedules?.scheduledMining?.periods || [];
      const restarts = config.schedules?.scheduledRestarts || [];

      this.loggingService.log(
        `📊 SCHEDULE STATUS - Day: ${currentDay}, Time: ${currentTime}, Enabled: ${schedulingEnabled}, Periods: ${periods.length}, Restarts: ${restarts.length}`,
        'INFO',
        'miner-manager',
      );

      if (periods.length > 0) {
        periods.forEach((period, index) => {
          const inDay = period.days?.includes(currentDay);
          const inTimeRange =
            period.startTime && period.endTime
              ? this.isTimeInRange(
                  currentTime,
                  period.startTime,
                  period.endTime,
                )
              : false;

          this.loggingService.log(
            `📆 Period #${index + 1}: ${period.startTime}-${period.endTime}, Days: ${period.days?.join(',')}, ` +
              `Active: ${inDay && inTimeRange}`,
            'INFO',
            'miner-manager',
          );
        });
      }
    } catch (error) {
      this.loggingService.log(
        `Error dumping schedule status: ${error.message}`,
        'ERROR',
        'miner-manager',
      );
    }
  }

  /**
   * Get current schedule status for debugging
   * @returns Schedule status information
   */
  public getScheduleStatus(): any {
    try {
      const config = this.configService.getConfig();
      if (!config) {
        return {
          status: 'error',
          message: 'No config available',
        };
      }

      const now = new Date();
      const currentDay = now
        .toLocaleString('en-US', { weekday: 'long' })
        .toLowerCase();
      const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);
      const currentMinutes = this.timeToMinutes(currentTime);

      const schedulingEnabled =
        config.schedules?.scheduledMining?.enabled || false;
      const periods = config.schedules?.scheduledMining?.periods || [];
      const restarts = config.schedules?.scheduledRestarts || [];

      // Check each period and determine active status
      const periodStatuses = periods.map((period, index) => {
        const inDay = period.days?.includes(currentDay) || false;
        const start = this.timeToMinutes(period.startTime);
        const end = this.timeToMinutes(period.endTime);

        let inTimeRange = false;
        if (start <= end) {
          // Normal time range
          inTimeRange = currentMinutes >= start && currentMinutes <= end;
        } else {
          // Overnight time range
          inTimeRange = currentMinutes >= start || currentMinutes <= end;
        }

        const isActive = inDay && inTimeRange;

        return {
          id: index + 1,
          startTime: period.startTime,
          endTime: period.endTime,
          days: period.days,
          inDay,
          inTimeRange,
          isActive,
        };
      });

      // Next restart time
      let nextRestart = null;
      if (restarts.length > 0) {
        // Find the next restart time
        const futureRestarts = restarts
          .map((time) => {
            const timeMinutes = this.timeToMinutes(time);
            return {
              time,
              minutes: timeMinutes,
              isToday: timeMinutes > currentMinutes,
              timeUntil:
                timeMinutes > currentMinutes
                  ? timeMinutes - currentMinutes
                  : 24 * 60 - currentMinutes + timeMinutes,
            };
          })
          .sort((a, b) => a.timeUntil - b.timeUntil);

        nextRestart = futureRestarts.length > 0 ? futureRestarts[0] : null;
      }

      return {
        currentDay,
        currentTime,
        schedulingEnabled,
        activePeriod: periodStatuses.find((p) => p.isActive) || null,
        allPeriods: periodStatuses,
        nextRestart,
        restartTimes: restarts,
        shouldMine: this.shouldBeMining(),
        isRunning: this.isMinerRunning(),
      };
    } catch (error) {
      return {
        status: 'error',
        message: `Failed to get schedule status: ${error.message}`,
      };
    }
  }

  onApplicationShutdown() {
    this.clearIntervals();
    MinerManagerService.isInitialized = false;
    this.stopMiner();
    this.loggingService.log(
      '🛑 MinerManager shutdown complete',
      'INFO',
      'miner-manager',
    );
  }
}
