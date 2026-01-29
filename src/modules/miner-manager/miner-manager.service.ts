import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { FlightsheetService } from '../flightsheet/flightsheet.service';
import { ConfigService } from '../config/config.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { MinerSoftwareService } from '../miner-software/miner-software.service';
import { exec, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MinerManagerService
  implements OnModuleInit, OnApplicationShutdown
{
  private static isInitialized = false;
  private minerScreen = 'miner-session';
  private minerProcess?: ChildProcess;

  // Consolidated monitoring
  private mainMonitoringInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;

  // Monitoring cycle counters for staggered operations
  private monitoringCycle = 0;
  private monitoringCycleId = 0;
  private healthCheckCycleId = 0;
  private cleanupCycleId = 0;

  // Interval reentrancy guards
  private monitoringInFlight = false;
  private healthCheckInFlight = false;
  private cleanupInFlight = false;

  private isShuttingDown = false;

  private screenAvailabilityCache?: { value: boolean; timestamp: number };
  private readonly SCREEN_AVAILABILITY_TTL = 60000; // 60 seconds

  private minerRunningCache?: { value: boolean; timestamp: number };
  private readonly MINER_RUNNING_TTL = 15000; // 15 seconds

  private lastScheduleCheck: Date | null = null;
  private crashCount = 0;
  private readonly MAX_CRASHES = 3;
  private lastCrashTime?: Date;

  // Add new properties to track manual stop status
  public isManuallyStoppedByUser = false;
  private manualStopTime?: Date;
  private readonly MANUAL_STOP_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  // Add restart cooldown to prevent too frequent restarts
  private lastRestartTime?: Date;
  private readonly RESTART_COOLDOWN = 5 * 60 * 1000; // 5 minutes between restarts

  // Track miner software changes to trigger restarts
  private currentMinerSoftware?: string;

  // Track benchmark mode activation for startup grace period
  private benchmarkStartTime?: Date;
  private lastBenchmarkStatus: boolean = false;
  private readonly BENCHMARK_STARTUP_GRACE = 2 * 60 * 1000; // 2 minutes grace period for benchmark startup

  // Prevent multiple simultaneous auto-starts
  private isAutoStarting: boolean = false;

  private lastMinerStartAt?: string;

  // Startup grace period to avoid false error reports right after restart
  private startupGraceUntil?: number;
  private readonly STARTUP_GRACE_PERIOD = 2 * 60 * 1000; // 2 minutes

  // Smart error tracking to prevent spam to API backend
  private errorTracker = new Map<
    string,
    { count: number; firstSeen: Date; lastSeen: Date; lastReported?: Date }
  >();
  private readonly ERROR_REPORT_THRESHOLD = 3; // Report after 3 consecutive occurrences
  private readonly ERROR_REPORT_COOLDOWN = 5 * 60 * 1000; // 5 minutes between reports of same error
  private readonly ERROR_TRACKER_CLEANUP_INTERVAL = 30 * 60 * 1000; // Clean old errors after 30 minutes

  // Prevent duplicate flightsheet fetches during startup
  private isInitialStartup = true;

  constructor(
    private readonly loggingService: LoggingService,
    private readonly flightsheetService: FlightsheetService,
    private readonly configService: ConfigService,
    private readonly apiService: ApiCommunicationService,
    private readonly minerSoftwareService: MinerSoftwareService,
  ) {}

  async onModuleInit() {
    if (MinerManagerService.isInitialized) {
      this.loggingService.log('⚠️ MinerManager already initialized, skipping...', 'WARN', 'miner-manager');
      return;
    }

    MinerManagerService.isInitialized = true;
    this.startupGraceUntil = Date.now() + this.STARTUP_GRACE_PERIOD;
    this.loggingService.log(
      '🚀 MinerManager initializing...',
      'INFO',
      'miner-manager',
    );

    this.clearIntervals();
    this.initializeMonitoring();
    // The miner will be started by triggerInitialFlightsheetFetchAndStart after bootstrap completes.
  }

  private clearIntervals(): void {
    if (this.mainMonitoringInterval) {
      clearInterval(this.mainMonitoringInterval);
      this.mainMonitoringInterval = undefined;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  private async initializeMiner(): Promise<void> {
    try {
      // Clean up any existing miner sessions first
      this.cleanupAllMinerSessions();

      const miner = await this.getMinerFromFlightsheet();
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
      void this.startMiner();
    } catch (error) {
      await this.logMinerError(
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
    }
  }
  private initializeMonitoring(): void {
    // Consolidated main monitoring interval - staggered operations
    this.mainMonitoringInterval = setInterval(() => {
      void this.runMonitoringCycle();
    }, 60000); // Every 1 minute

    // More frequent health check interval to catch miner crashes quickly
    this.healthCheckInterval = setInterval(() => {
      void this.runHealthCheck();
    }, 30000); // Every 30 seconds for responsive crash detection

    // Cleanup interval - runs every hour
        this.cleanupInterval = setInterval(() => {
          void this.runCleanup();
        }, 3600000); // Every hour

    // Run initial checks
    void this.runMonitoringCycle();
    void this.checkSchedules();
    void this.dumpScheduleStatus();

    // Log configuration for monitoring intervals
    this.loggingService.log(
      '🔧 Monitoring configured: Unified monitoring every 1 minute, health check every 30 seconds, cleanup every hour',
      'INFO',
      'miner-manager',
    );
  }

  /**
   * Perform staggered monitoring operations to reduce resource contention
   */
  private async performStaggeredMonitoring(): Promise<void> {
    try {
      this.monitoringCycle++;
      const cycle = this.monitoringCycle % 3; // 3-minute cycle for additional operations

      // CRITICAL: Always sync config FIRST to get latest miningCpus before flightsheet check
      this.loggingService.log(
        '🔄 Syncing config from backend API...',
        'DEBUG',
        'miner-manager',
      );

      // Add timeout protection for config sync to prevent hanging
      try {
        await Promise.race([
          this.configService.syncConfigWithApi(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Config sync timeout after 30 seconds')),
              30000,
            ),
          ),
        ]);
      } catch (error: any) {
        if (error.message?.includes('timeout')) {
          this.loggingService.log(
            '⏰ Config sync timed out after 30 seconds, continuing with cached config',
            'WARN',
            'miner-manager',
          );
        } else {
          this.loggingService.log(
            `❌ Config sync failed: ${error.message}`,
            'ERROR',
            'miner-manager',
          );
        }
        // Continue with cached config instead of failing completely
      }

      // CRITICAL: Check flightsheet AFTER config sync to use updated miningCpus
      // Skip flightsheet fetch during initial startup - bootstrap will handle it
      if (this.isInitialStartup) {
        this.loggingService.log(
          '🔄 Skipping flightsheet check during initial startup - bootstrap will handle first fetch',
          'DEBUG',
          'miner-manager',
        );
      } else {
        this.loggingService.log(
          '🔄 Checking for flightsheet updates...',
          'DEBUG',
          'miner-manager',
        );
        const updated = await this.fetchAndUpdateFlightsheet();
        if (updated) {
          const config = await this.configService.getConfig();
          if (!config?.benchmark) {
            await this.logMinerError('Flightsheet changed, restarting miner');
          } else {
            this.loggingService.log(
              '🧪 Benchmark active - skipping flightsheet change error report',
              'DEBUG',
              'miner-manager',
            );
          }
          void this.restartMiner();
        }
      }

      // Check if miner software changed and restart if needed
      await this.checkMinerSoftwareChange();

      // CRITICAL: Always check schedules every minute
      await this.checkSchedules();

      // Optional staggered operations to reduce load
      switch (cycle) {
        case 0: {
          // Cycle 0: Additional logging or maintenance
          this.loggingService.log(
            '🔄 Performing cycle 0 maintenance...',
            'DEBUG',
            'miner-manager',
          );
          break;
        }

        case 1: {
          // Cycle 1: Additional checks if needed
          break;
        }

        default: {
          // Other cycles: Reserved for future use
          break;
        }
      }
    } catch (error) {
      this.loggingService.log(
        `⚠️ Monitoring cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'miner-manager',
      );
    }
  }

  private async runMonitoringCycle(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.monitoringCycleId++;
    this.loggingService.log(
      `🔁 Monitoring cycle ${this.monitoringCycleId} started`,
      'DEBUG',
      'miner-manager',
      { cycleId: this.monitoringCycleId },
    );
    if (this.monitoringInFlight) {
      this.loggingService.log(
        '⏳ Monitoring cycle already running, skipping interval tick',
        'DEBUG',
        'miner-manager',
      );
      return;
    }

    this.monitoringInFlight = true;
    try {
      await this.performStaggeredMonitoring();
    } catch (error) {
      this.loggingService.log(
        `❌ Monitoring cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
    } finally {
      this.monitoringInFlight = false;
    }
  }

  /**
   * Perform periodic cleanup to prevent resource leaks
   */
  private async performCleanup(): Promise<void> {
    try {
      // Clear old cache entries in config service
      this.configService.clearApiCache?.();

      // Clean up old log files and storage files
      await this.cleanupOldFiles();

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      this.loggingService.log(
        '🧹 Periodic cleanup completed',
        'DEBUG',
        'miner-manager',
      );
    } catch (error) {
      this.loggingService.log(
        `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'miner-manager',
      );
    }
  }

  private async runCleanup(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.cleanupCycleId++;
    this.loggingService.log(
      `🧹 Cleanup cycle ${this.cleanupCycleId} started`,
      'DEBUG',
      'miner-manager',
    );
    if (this.cleanupInFlight) {
      this.loggingService.log(
        '⏳ Cleanup already running, skipping interval tick',
        'DEBUG',
        'miner-manager',
      );
      return;
    }

    this.cleanupInFlight = true;
        try {
          await this.performCleanup();
    } catch (error) {
      this.loggingService.log(
        `❌ Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
    } finally {
      this.cleanupInFlight = false;
    }
  }

  /**
   * Clean up old storage files
   */
  private async cleanupOldFiles(): Promise<void> {
    try {
      const storageDir = 'storage';
      if (!(await this.fileExists(storageDir))) return;

      const files = await fs.promises.readdir(storageDir);
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      let cleanedCount = 0;
      for (const file of files) {
        if (!file.startsWith('miner-output-')) {
          continue;
        }

        const filePath = path.join(storageDir, file);
        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.mtime.getTime() < oneHourAgo) {
            await fs.promises.unlink(filePath);
            cleanedCount++;
          }
        } catch {
          // Ignore cleanup errors for individual files
        }
      }

      if (cleanedCount > 0) {
        this.loggingService.log(
          `🧹 Cleaned up ${cleanedCount} old miner output files`,
          'DEBUG',
          'miner-manager',
        );
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  /**
   * Check if miner software has changed and restart if needed
   */
  private async checkMinerSoftwareChange(): Promise<void> {
    try {
      const config = await this.configService.getConfig();
      if (!config || !config.minerSoftware) {
        return;
      }

      const newMinerSoftware = config.minerSoftware;

      // If this is the first check, just store the current software
      if (!this.currentMinerSoftware) {
        this.currentMinerSoftware = newMinerSoftware;
        this.loggingService.log(
          `🔧 Initial miner software detected: ${newMinerSoftware}`,
          'DEBUG',
          'miner-manager',
        );
        return;
      }

      // Check if miner software has changed
      if (this.currentMinerSoftware !== newMinerSoftware) {
        this.loggingService.log(
          `🔄 Miner software changed: ${this.currentMinerSoftware} → ${newMinerSoftware}`,
          'INFO',
          'miner-manager',
        );

        // Update the current software
        this.currentMinerSoftware = newMinerSoftware;

        // Stop the current miner and start the new one
        if (await this.isMinerRunningAsync()) {
          this.loggingService.log(
            '⚠️ Stopping current miner due to software change...',
            'INFO',
            'miner-manager',
          );

          const stopped = await this.stopMiner();
          if (!stopped) {
            this.loggingService.log(
              '❌ Failed to stop current miner for software change',
              'ERROR',
              'miner-manager',
            );
            return;
          }
        }

        // Clear any cached endpoints since we're switching miner types
        this.clearMinerApiCache();

        // Start the new miner
        this.loggingService.log(
          `🚀 Starting new miner: ${newMinerSoftware}`,
          'INFO',
          'miner-manager',
        );

        const started = await this.startMiner();
        if (started) {
          this.loggingService.log(
            `✅ Successfully switched to ${newMinerSoftware}`,
            'INFO',
            'miner-manager',
          );
        } else {
          this.loggingService.log(
            `❌ Failed to start new miner: ${newMinerSoftware}`,
            'ERROR',
            'miner-manager',
          );
        }
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Error checking miner software change: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
    }
  }

  /**
   * Clear cached miner API endpoints when switching miners
   */
  private clearMinerApiCache(): void {
    // Cache clearing will be handled by the API utility automatically
    // when it detects a different miner type
    this.loggingService.log(
      '🗑️ Miner API cache will be refreshed on next API call',
      'DEBUG',
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

      const config = await this.configService.getConfig();
      const shouldBeMining = await this.shouldBeMining();
      const isMinerRunning = await this.isMinerRunningAsync();

      // Skip error reporting during startup grace period
      if (this.startupGraceUntil && Date.now() < this.startupGraceUntil) {
        this.loggingService.log(
          '⏳ Startup grace period active - skipping health check errors',
          'DEBUG',
          'miner-manager',
        );
        if (!isMinerRunning && shouldBeMining) {
          // Still attempt to start miner, just avoid error reporting
          const started = await this.startMiner();
          if (started) {
            this.loggingService.log(
              '✅ Miner started during startup grace period',
              'INFO',
              'miner-manager',
            );
            this.startupGraceUntil = undefined;
          }
        }
        return;
      }

      // Track benchmark mode activation for grace period
      const currentBenchmarkStatus = config?.benchmark ?? false;
      if (currentBenchmarkStatus !== this.lastBenchmarkStatus) {
        if (currentBenchmarkStatus) {
          this.benchmarkStartTime = new Date();
          this.loggingService.log(
            '🚀 Benchmark mode activated - starting grace period for miner startup',
            'INFO',
            'miner-manager',
          );
        } else {
          this.benchmarkStartTime = undefined;
          this.loggingService.log(
            '🔴 Benchmark mode deactivated',
            'INFO',
            'miner-manager',
          );
        }
        this.lastBenchmarkStatus = currentBenchmarkStatus;
      }

      // Check if we're in benchmark startup grace period
      const isInBenchmarkGracePeriod =
        this.benchmarkStartTime &&
        Date.now() - this.benchmarkStartTime.getTime() <
          this.BENCHMARK_STARTUP_GRACE;

      this.loggingService.log(
        `🔍 Health check: Should mine=${shouldBeMining}, Is running=${isMinerRunning}, Benchmark grace=${isInBenchmarkGracePeriod}`,
        'DEBUG',
        'miner-manager',
      );

      if (shouldBeMining && !isMinerRunning) {
        // Skip error reporting if we're in benchmark startup grace period
        if (isInBenchmarkGracePeriod) {
          this.loggingService.log(
            '⏳ Benchmark mode startup grace period active - skipping health check errors',
            'DEBUG',
            'miner-manager',
          );
          return;
        }

        this.crashCount++;
        const error = `Miner not running when it should be (Detection ${this.crashCount}/${this.MAX_CRASHES})`;
        this.loggingService.log(`⚠️ ${error}`, 'WARN', 'miner-manager');
        await this.logMinerError(error);

        if (this.crashCount >= this.MAX_CRASHES) {
          const criticalError =
            'Maximum detection count reached. Miner may have persistent issues.';
          this.loggingService.log(
            `❌ ${criticalError}`,
            'ERROR',
            'miner-manager',
          );
          await this.logMinerError(criticalError);
          // Reset crash count to allow future restart attempts
          this.crashCount = 0;
          this.lastCrashTime = new Date();
        }

        // Always try to restart when miner should be running but isn't
        this.loggingService.log(
          '🔄 Attempting to start miner immediately...',
          'INFO',
          'miner-manager',
        );
        const started = await this.startMiner();
        if (started) {
          this.loggingService.log(
            '✅ Miner successfully restarted by health check',
            'INFO',
            'miner-manager',
          );
          // Reset crash count on successful restart
          this.crashCount = 0;
          this.startupGraceUntil = undefined;
        } else {
          this.loggingService.log(
            '❌ Failed to restart miner in health check',
            'ERROR',
            'miner-manager',
          );
        }
      } else if (shouldBeMining && isMinerRunning) {
        // Enhanced health check: Check for errors in miner output
        const hasErrors = await this.checkMinerOutput();
        if (hasErrors) {
          // Check if we're in restart cooldown period
          const now = new Date();
          if (
            this.lastRestartTime &&
            now.getTime() - this.lastRestartTime.getTime() <
              this.RESTART_COOLDOWN
          ) {
            this.loggingService.log(
              '⏳ Restart cooldown active, skipping restart to prevent too frequent restarts',
              'DEBUG',
              'miner-manager',
            );
            return;
          }

          this.loggingService.log(
            '⚠️ Miner errors detected in output, restarting miner',
            'WARN',
            'miner-manager',
          );
          void this.restartMiner();
        } else {
          this.crashCount = 0;
          this.loggingService.log(
            '✅ Health check completed successfully - miner is running normally',
            'DEBUG',
            'miner-manager',
          );
        }
      } else {
        this.crashCount = 0;
      }
    } catch (error) {
      await this.logMinerError(
        `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
    }
  }

  private async runHealthCheck(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.healthCheckCycleId++;
    this.loggingService.log(
      `🩺 Health check ${this.healthCheckCycleId} started`,
      'DEBUG',
      'miner-manager',
      { cycleId: this.healthCheckCycleId },
    );
    if (this.healthCheckInFlight) {
      this.loggingService.log(
        '⏳ Health check already running, skipping interval tick',
        'DEBUG',
        'miner-manager',
      );
      return;
    }

    this.healthCheckInFlight = true;
    try {
      await this.checkMinerHealth();
    } catch (error) {
      this.loggingService.log(
        `❌ Health check failed: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  /**
   * Ensure storage directory exists and is writable
   */
  private async ensureStorageDirectory(): Promise<void> {
    try {
      const storagePath = 'storage';
      const exists = await this.fileExists(storagePath);
      if (!exists) {
        await fs.promises.mkdir(storagePath, { recursive: true });
        this.loggingService.log(
          '📁 Created storage directory for miner output files',
          'DEBUG',
          'miner-manager',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to create storage directory: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
      throw error;
    }
  }

  /**
   * Check miner screen session output for errors and connection issues
   */
  private async checkMinerOutput(): Promise<boolean> {
    try {
      // First, verify the screen session is actually running
      const isRunning = await this.isMinerRunningAsync();
      if (!isRunning) {
        this.loggingService.log(
          '⚠️ Miner screen session not found during health check',
          'DEBUG',
          'miner-manager',
        );
        return false;
      }

      // Detect which miner is running for appropriate health checks
      const minerSoftware = await this.getMinerFromFlightsheet();
      this.loggingService.log(
        `🔍 Performing health check for ${minerSoftware || 'unknown'} miner`,
        'DEBUG',
        'miner-manager',
      );

      // Try in-memory capture first (faster, no disk I/O)
      let output = '';

      try {
        this.loggingService.log(
          `🚀 Attempting in-memory miner output capture`,
          'DEBUG',
          'miner-manager',
        );

        // Method 1: Direct file-based capture using screen hardcopy to temporary file
        const tempOutput1 = `storage/temp-output1-${Date.now()}.txt`;
        try {
          await this.execCommand(
            `screen -S ${this.minerScreen} -X hardcopy ${tempOutput1}`,
            5000,
          );

          // Wait for file to be written
          await new Promise((resolve) => setTimeout(resolve, 500));

          if (await this.fileExists(tempOutput1)) {
            output = await fs.promises.readFile(tempOutput1, 'utf8');
            await this.safeUnlink(tempOutput1);

            this.loggingService.log(
              `✅ Successfully captured miner output via method 1 (${output.length} chars)`,
              'DEBUG',
              'miner-manager',
            );
          }
        } catch (error) {
          // Method 2: Alternative approach with different timeout
          try {
            const tempOutput2 = `storage/temp-output2-${Date.now()}.txt`;
            await this.execCommand(
              `screen -S ${this.minerScreen} -X hardcopy ${tempOutput2}`,
              3000,
            );

            // Wait for file to be written
            await new Promise((resolve) => setTimeout(resolve, 300));

            if (await this.fileExists(tempOutput2)) {
              output = await fs.promises.readFile(tempOutput2, 'utf8');
              await this.safeUnlink(tempOutput2);

              this.loggingService.log(
                `✅ Successfully captured miner output via method 2 (${output.length} chars)`,
                'DEBUG',
                'miner-manager',
              );
            }
          } catch (altError) {
            this.loggingService.log(
              `⚠️ Alternative capture method failed: ${altError instanceof Error ? altError.message : String(altError)}`,
              'DEBUG',
              'miner-manager',
            );
          }
        }
      } catch (screenError) {
        this.loggingService.log(
          `⚠️ Primary capture failed: ${screenError instanceof Error ? screenError.message : String(screenError)}`,
          'DEBUG',
          'miner-manager',
        );
      }

      // Fallback to file-based method if in-memory capture failed
      if (!output) {
        this.loggingService.log(
          `📋 Falling back to file-based hardcopy method`,
          'DEBUG',
          'miner-manager',
        );

        try {
          // Ensure storage directory exists
          await this.ensureStorageDirectory();

          const hardcopyFile = `storage/miner-health-${Date.now()}.txt`;

          // Create hardcopy of screen session with timeout
          await this.execCommand(
            `screen -S ${this.minerScreen} -X hardcopy ${hardcopyFile}`,
            10000,
          );

          // Wait for file to be written
          await new Promise((resolve) => setTimeout(resolve, 1000));

          if (await this.fileExists(hardcopyFile)) {
            output = await fs.promises.readFile(hardcopyFile, 'utf8');
            this.loggingService.log(
              `✅ Successfully captured miner output via file method (${output.length} chars)`,
              'DEBUG',
              'miner-manager',
            );
            await this.safeUnlink(hardcopyFile);
          } else {
            this.loggingService.log(
              `⚠️ Hardcopy file was not created: ${hardcopyFile}`,
              'WARN',
              'miner-manager',
            );
          }
        } catch (fileError) {
          this.loggingService.log(
            `⚠️ File-based hardcopy method failed: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
            'WARN',
            'miner-manager',
          );
        }
      }

      // If file-based also failed, try final alternative approach with timeout
      if (!output) {
        this.loggingService.log(
          '⚠️ Primary methods failed, trying final alternative hardcopy approach',
          'DEBUG',
          'miner-manager',
        );

        try {
          // Alternative: Try to capture output to a temporary file with explicit timeout command
          const altHardcopyFile = `storage/miner-alt-${Date.now()}.txt`;
          await this.execCommand(
            `timeout 5 screen -S ${this.minerScreen} -X hardcopy ${altHardcopyFile} 2>/dev/null`,
            10000,
          );

          // Wait a bit longer for the file
          await new Promise((resolve) => setTimeout(resolve, 1500));

          if (await this.fileExists(altHardcopyFile)) {
            output = await fs.promises.readFile(altHardcopyFile, 'utf8');
            this.loggingService.log(
              `✅ Successfully captured miner output with alternative approach (${output.length} chars)`,
              'DEBUG',
              'miner-manager',
            );
            await this.safeUnlink(altHardcopyFile);
          }
        } catch (altError) {
          this.loggingService.log(
            `⚠️ Alternative hardcopy method failed: ${altError instanceof Error ? altError.message : String(altError)}`,
            'DEBUG',
            'miner-manager',
          );
        }
      }

      // Final fallback: Check if we can at least detect the session is responsive
      if (!output) {
        this.loggingService.log(
          '⚠️ Could not capture miner output, checking session responsiveness',
          'DEBUG',
          'miner-manager',
        );

        // Check if the screen session is responsive by sending a simple command
        try {
          await this.execCommand(`screen -S ${this.minerScreen} -X info`, 5000);
          // If we get here, the session exists but we can't read output
          // This is not necessarily an error, so return false (no errors detected)
          return false;
        } catch {
          // Session is not responsive, this might indicate a problem
          this.loggingService.log(
            '⚠️ Screen session appears unresponsive',
            'WARN',
            'miner-manager',
          );
          return true; // Consider this an error condition
        }
      }

      // If we have output, analyze it for errors
      if (output) {
        return await this.analyzeOutput(output, minerSoftware);
      }

      return false;
    } catch (error) {
      this.loggingService.log(
        `❌ Error checking miner output: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
      return false;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Analyze miner output for errors and issues
   */
  private async analyzeOutput(output: string, minerSoftware?: string): Promise<boolean> {
    try {
      // Detect miner software if not provided
      if (!minerSoftware) {
        minerSoftware =
          this.detectMinerFromOutput(output) || (await this.getMinerFromFlightsheet());
      }

      this.loggingService.log(
        `🔍 Analyzing output for ${minerSoftware || 'unknown'} miner`,
        'DEBUG',
        'miner-manager',
      );

      // Get miner-specific error patterns
      const errorPatterns = this.getErrorPatterns(minerSoftware);

      let hasErrors = false;
      const lines = output.split('\n').slice(-50); // Check last 50 lines

      for (const line of lines) {
        for (const pattern of errorPatterns) {
          if (pattern.test(line)) {
            const errorKey = line.trim();
            this.loggingService.log(
              `🔍 Detected ${minerSoftware} error in output: ${errorKey}`,
              'WARN',
              'miner-manager',
            );

            // Use smart error tracking instead of immediate API logging
            this.trackAndReportError(
              errorKey,
              `${minerSoftware} output error: ${errorKey}`,
            );
            hasErrors = true;
            break;
          }
        }
        if (hasErrors) break;
      }

      // Check for recent activity using miner-specific patterns
      const now = new Date();
      const recentActivity = this.checkForRecentMinerActivity(
        lines,
        now,
        minerSoftware,
      );

      if (!recentActivity) {
        this.loggingService.log(
          `⚠️ No recent ${minerSoftware} activity detected (possible connection issue or pool difficulty adjustment)`,
          'DEBUG',
          'miner-manager',
        );
        // Don't treat lack of activity as an error unless combined with other issues
        // This is especially important for XMRig which may have longer intervals between activities
        // hasErrors = true; // Commented out to be less aggressive
      }

      this.loggingService.log(
        `✅ Output analysis completed for ${minerSoftware} miner (errors: ${hasErrors})`,
        'DEBUG',
        'miner-manager',
      );

      return hasErrors;
    } catch (error) {
      this.loggingService.log(
        `❌ Error analyzing miner output: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
      return false; // Return false to avoid triggering restarts on analysis errors
    }
  }

  /**
   * Detect miner software from output patterns
   */
  private detectMinerFromOutput(output: string): string | null {
    // XMRig patterns
    if (
      output.includes('XMRig/') ||
      output.includes('randomx') ||
      output.includes('new job from') ||
      output.includes('algo rx/')
    ) {
      return 'xmrig';
    }

    // CCMiner patterns
    if (
      output.includes('ccminer') ||
      output.includes('stratum+tcp') ||
      output.includes('accepted') ||
      output.includes('kH/s')
    ) {
      return 'ccminer';
    }

    return null;
  }

  /**
   * Get error patterns specific to each miner
   */
  private getErrorPatterns(minerSoftware?: string): RegExp[] {
    const commonPatterns = [
      /stratum connection interrupted/i,
      /connection failed/i,
      /pool timeout/i,
      /failed to connect/i,
      /socket error/i,
      /network error/i,
      /authentication failed/i,
      /pool rejected/i,
      /no response from pool/i,
      /disconnected from pool/i,
    ];

    if (minerSoftware === 'ccminer') {
      return [
        ...commonPatterns,
        /cuda error/i,
        /opencl error/i,
        /gpu error/i,
        /device error/i,
        /rejected/i,
        /stratum authentication failed/i,
      ];
    } else if (minerSoftware === 'xmrig') {
      return [
        ...commonPatterns,
        /randomx init failed/i,
        /pool connection error/i,
        /tls handshake failed/i,
        /job timeout/i,
        /backend error/i,
        /bind failed/i,
        /login failed/i,
        /connect error/i,
        /donate pool.*error/i, // Only actual donation pool errors, not normal messages
        /thread.*error/i, // Thread-specific errors
        /opencl.*error/i, // OpenCL errors
        /cuda.*error/i, // CUDA errors
      ];
    }

    // Default: return all patterns
    return [
      ...commonPatterns,
      /cuda error/i,
      /opencl error/i,
      /randomx init failed/i,
      /pool connection error/i,
      /tls handshake failed/i,
      /job timeout/i,
      /backend error/i,
      /bind failed/i,
      /login failed/i,
      /connect error/i,
    ];
  }

  /**
   * Check if there's recent mining activity in the output
   */
  private checkForRecentMinerActivity(
    lines: string[],
    now: Date,
    minerSoftware?: string,
  ): boolean {
    // Look for recent timestamps in the output - support both ccminer and XMRig formats
    const timestampPatterns = [
      /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/, // XMRig format: [2025-07-11 21:27:13]
      /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/, // XMRig with milliseconds
      /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/, // ccminer format without brackets
    ];

    for (const line of lines.reverse()) {
      // Check most recent lines first
      let logTime: Date | null = null;

      // Try different timestamp patterns
      for (const pattern of timestampPatterns) {
        const match = line.match(pattern);
        if (match) {
          try {
            // Handle both formats - with and without milliseconds
            const timeStr = match[1];
            if (timeStr.includes('.')) {
              // XMRig format with milliseconds
              logTime = new Date(timeStr);
            } else {
              // Standard format without milliseconds
              logTime = new Date(timeStr);
            }
            break;
          } catch {
            // Ignore date parsing errors and try next pattern
          }
        }
      }

      if (logTime) {
        const timeDiff = now.getTime() - logTime.getTime();

        // Allow up to 20 minutes of inactivity to account for pool difficulty adjustments
        // Mining pools can adjust difficulty causing longer periods between shares
        if (timeDiff < 20 * 60 * 1000) {
          // Check if it's meaningful activity using miner-specific patterns
          const activityPatterns = this.getActivityPatterns(minerSoftware);

          for (const pattern of activityPatterns) {
            if (pattern.test(line)) {
              this.loggingService.log(
                `✅ Recent ${minerSoftware} activity detected: ${line.trim()}`,
                'DEBUG',
                'miner-manager',
              );
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Get activity patterns specific to each miner
   */
  private getActivityPatterns(minerSoftware?: string): RegExp[] {
    if (minerSoftware === 'ccminer') {
      return [
        /accepted/i,
        /kH\/s/i,
        /yes!/i,
        /stratum/i,
        /difficulty/i,
        /target/i,
        /share/i,
        /submit/i,
      ];
    } else if (minerSoftware === 'xmrig') {
      return [
        /new job from/i,
        /speed/i,
        /H\/s/i,
        /use pool/i,
        /net/i,
        /miner/i,
        /randomx/i,
        /cpu/i,
        /accepted/i,
        /job/i,
        /diff/i,
        /algo/i,
      ];
    }

    // Default: return all patterns
    return [
      /accepted/i,
      /kH\/s/i,
      /H\/s/i,
      /yes!/i,
      /stratum/i,
      /difficulty/i,
      /target/i,
      /new job from/i,
      /speed/i,
      /use pool/i,
      /net/i,
      /miner/i,
      /randomx/i,
      /cpu/i,
      /job/i,
      /diff/i,
      /algo/i,
    ];
  }

  public async shouldBeMining(): Promise<boolean> {
    const config = await this.configService.getConfig();
    if (!config) {
      this.loggingService.log(
        'ℹ️ No config available, defaulting to always mining',
        'DEBUG',
        'miner-manager',
      );
      return true;
    }

    // If benchmark is active, bypass all scheduling and always mine
    if (config.benchmark === true) {
      this.loggingService.log(
        '🚀 Benchmark mode active - bypassing schedules and ensuring mining',
        'DEBUG',
        'miner-manager',
      );

      // Auto-start miner if benchmark mode is active but miner is not running
      if (!this.isMinerRunning() && !this.isAutoStarting) {
        this.isAutoStarting = true;
        // Use setTimeout to avoid blocking the shouldBeMining call
        setTimeout(() => {
          this.loggingService.log(
            '🚀 Auto-starting miner for benchmark mode',
            'INFO',
            'miner-manager',
          );
          void this.startMiner().finally(() => {
            this.isAutoStarting = false;
          });
        }, 1000);
      }

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

  public async getMinerFromFlightsheet(): Promise<string | undefined> {
    try {
      // Get the miner software from main config
      const minerSoftware = await this.configService.getMinerSoftware();
      if (minerSoftware) {
        this.loggingService.log(
          `🔍 Using miner from config: ${minerSoftware}`,
          'DEBUG',
          'miner-manager',
        );
        return minerSoftware;
      }

      this.loggingService.log(
        '⚠️ No minerSoftware found in config',
        'WARN',
        'miner-manager',
      );
      return undefined;
    } catch (error) {
      this.loggingService.log(
        `❌ Error getting miner from config: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
      return undefined;
    }
  }

  public isMinerRunning(): boolean {
    const cached = this.getCachedMinerRunning();
    if (cached !== undefined) {
      return cached;
    }
    return false;
  }

  private async execCommand(command: string, timeout: number = 5000): Promise<string> {
    if (process.platform === 'win32' && command.includes('screen')) {
      this.loggingService.log(
        `⚠️ Skipping screen command on Windows: ${command}`,
        'DEBUG',
        'miner-manager',
      );
      return '';
    }

    if (command.includes('screen') && !(await this.isScreenAvailable())) {
      this.loggingService.log(
        `⚠️ Screen not available, skipping command: ${command}`,
        'DEBUG',
        'miner-manager',
      );
      return '';
    }

    return new Promise((resolve, reject) => {
      const child = exec(command, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        if (stderr && stderr.trim().length > 0) {
          // Treat stderr as non-fatal; return stdout for compatibility
          resolve(stdout ?? '');
          return;
        }
        resolve(stdout ?? '');
      });

      child.on('error', (err) => reject(err));
    });
  }

  public async isMinerRunningAsync(): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        const isRunning = !!this.minerProcess && this.minerProcess.exitCode === null;
        this.updateMinerRunningCache(isRunning);
        return isRunning;
      }

      if (!(await this.isScreenAvailable())) {
        this.updateMinerRunningCache(false);
        return false;
      }

      const screenOutput = await this.execCommand('screen -ls', 5000);

      const sessionExists = screenOutput.includes(this.minerScreen);

      if (!sessionExists) {
        this.loggingService.log(
          `📋 No screen session '${this.minerScreen}' found`,
          'DEBUG',
          'miner-manager',
        );
        this.updateMinerRunningCache(false);
        return false;
      }

      const sessionLines = screenOutput.split('\n');
      for (const line of sessionLines) {
        if (line.includes(this.minerScreen)) {
          if (line.includes('(Dead)')) {
            this.loggingService.log(
              `💀 Screen session '${this.minerScreen}' is dead, cleaning up`,
              'WARN',
              'miner-manager',
            );
            await this.cleanupAllMinerSessions();
            this.updateMinerRunningCache(false);
            return false;
          }

          this.loggingService.log(
            `✅ Screen session '${this.minerScreen}' is running: ${line.trim()}`,
            'DEBUG',
            'miner-manager',
          );
          this.updateMinerRunningCache(true);
          return true;
        }
      }

      this.updateMinerRunningCache(false);
      return false;
    } catch (error) {
      this.loggingService.log(
        `❌ Error checking miner status (async): ${error instanceof Error ? error.message : String(error)}`,
        'DEBUG',
        'miner-manager',
      );
      this.updateMinerRunningCache(false);
      return false;
    }
  }

  private updateMinerRunningCache(value: boolean): void {
    this.minerRunningCache = { value, timestamp: Date.now() };
  }

  private getCachedMinerRunning(): boolean | undefined {
    if (!this.minerRunningCache) {
      return undefined;
    }

    if (Date.now() - this.minerRunningCache.timestamp > this.MINER_RUNNING_TTL) {
      return undefined;
    }

    return this.minerRunningCache.value;
  }

  private isScreenAvailabilityCacheValid(): boolean {
    if (!this.screenAvailabilityCache) {
      return false;
    }

    return Date.now() - this.screenAvailabilityCache.timestamp < this.SCREEN_AVAILABILITY_TTL;
  }

  private async isScreenAvailable(): Promise<boolean> {
    if (this.isScreenAvailabilityCacheValid()) {
      return this.screenAvailabilityCache?.value ?? false;
    }

    const available = await new Promise<boolean>((resolve) => {
      exec('command -v screen', { timeout: 2000 }, (error, stdout) => {
        resolve(!error && !!stdout?.trim());
      });
    });

    this.screenAvailabilityCache = { value: available, timestamp: Date.now() };
    return available;
  }

  private isScreenAvailableSync(): boolean {
    if (this.isScreenAvailabilityCacheValid()) {
      return this.screenAvailabilityCache?.value ?? false;
    }

    return false;
  }

  /**
   * Get the count of running miner sessions
   */
  public async getMinerSessionCount(): Promise<number> {
    try {
      if (!(await this.isScreenAvailable())) {
        return 0;
      }

      const output = await this.execCommand(`screen -ls | grep ${this.minerScreen}`, 5000);

      if (!output.trim()) {
        return 0;
      }

      const lines = output.split('\n');
      let count = 0;

      for (const line of lines) {
        if (line.match(/^\s*\d+\.miner-session/)) {
          count++;
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  private async getMinerSessionCountAsync(): Promise<number> {
    try {
      const output = await this.execCommand('screen -ls', 5000);

      if (!output.trim()) {
        return 0;
      }

      const lines = output.split('\n');
      let count = 0;

      const sessionPattern = new RegExp(`^\\s*\\d+\\.${this.minerScreen}`);
      for (const line of lines) {
        if (sessionPattern.test(line)) {
          count++;
        }
      }

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Clean up all miner sessions (useful when multiple sessions exist)
   */
  private async cleanupAllMinerSessions(): Promise<void> {
    try {
      if (!(await this.isScreenAvailable())) {
        this.loggingService.log(
          'ℹ️ Screen not available, skipping session cleanup',
          'DEBUG',
          'miner-manager',
        );
        return;
      }

      const output = await this.execCommand(`screen -ls | grep ${this.minerScreen}`, 5000);

      if (output.trim()) {
        // Extract session IDs from screen -ls output
        const lines = output.split('\n');
        const sessionIds: string[] = [];

        for (const line of lines) {
          const match = line.match(/^\s*(\d+)\.miner-session/);
          if (match) {
            sessionIds.push(match[1]);
          }
        }

        if (sessionIds.length > 0) {
          this.loggingService.log(
            `🧹 Found ${sessionIds.length} miner sessions to clean up: ${sessionIds.join(', ')}`,
            'INFO',
            'miner-manager',
          );

          // Kill all miner sessions
          for (const sessionId of sessionIds) {
            try {
              await this.execCommand(`screen -X -S ${sessionId}.${this.minerScreen} quit`, 5000);
              this.loggingService.log(
                `✅ Cleaned up session: ${sessionId}.${this.minerScreen}`,
                'DEBUG',
                'miner-manager',
              );
            } catch (error) {
              this.loggingService.log(
                `⚠️ Failed to clean up session ${sessionId}.${this.minerScreen}: ${error instanceof Error ? error.message : String(error)}`,
                'WARN',
                'miner-manager',
              );

              // If screen command failed, try to remove the session file manually
              await this.cleanupOrphanedSessionFile(sessionId);
            }
          }
        }
      }
    } catch {
      // No sessions found or other error - this is expected when no sessions exist
      this.loggingService.log(
        'No miner sessions found to clean up',
        'DEBUG',
        'miner-manager',
      );
    }
  }

  private async cleanupAllMinerSessionsAsync(): Promise<void> {
    try {
      const output = await this.execCommand(`screen -ls`, 5000);

      if (output.trim()) {
        const lines = output.split('\n');
        const sessionIds: string[] = [];
        const sessionPattern = new RegExp(`^\\s*(\\d+)\\.${this.minerScreen}`);

        for (const line of lines) {
          const match = line.match(sessionPattern);
          if (match) {
            sessionIds.push(match[1]);
          }
        }

        if (sessionIds.length > 0) {
          this.loggingService.log(
            `🧹 Found ${sessionIds.length} miner sessions to clean up: ${sessionIds.join(', ')}`,
            'INFO',
            'miner-manager',
          );

          for (const sessionId of sessionIds) {
            try {
              await this.execCommand(
                `screen -X -S ${sessionId}.${this.minerScreen} quit`,
                5000,
              );
              this.loggingService.log(
                `✅ Cleaned up session: ${sessionId}.${this.minerScreen}`,
                'DEBUG',
                'miner-manager',
              );
            } catch (error) {
              this.loggingService.log(
                `⚠️ Failed to clean up session ${sessionId}.${this.minerScreen}: ${error instanceof Error ? error.message : String(error)}`,
                'WARN',
                'miner-manager',
              );
              await this.cleanupOrphanedSessionFile(sessionId);
            }
          }
        }
      }
    } catch {
      this.loggingService.log(
        'No miner sessions found to clean up (async)',
        'DEBUG',
        'miner-manager',
      );
    }
  }

  /**
   * Manually remove orphaned screen session files when screen command fails
   */
  private async cleanupOrphanedSessionFile(sessionId: string): Promise<void> {
    try {
      // Screen session files are typically stored in /tmp/uscreens/S-username/ or /var/run/screen/S-username/
      // We'll try common locations
      const username = process.env.USER || process.env.USERNAME || 'root';
      const sessionFileName = `${sessionId}.${this.minerScreen}`;

      const possiblePaths = [
        `/tmp/uscreens/S-${username}/${sessionFileName}`,
        `/var/run/screen/S-${username}/${sessionFileName}`,
        `/tmp/screens/S-${username}/${sessionFileName}`,
        `/run/screen/S-${username}/${sessionFileName}`,
      ];

      let removed = false;
      for (const sessionPath of possiblePaths) {
        try {
          if (await this.fileExists(sessionPath)) {
            await this.safeUnlink(sessionPath);
            this.loggingService.log(
              `🗑️ Manually removed orphaned session file: ${sessionPath}`,
              'INFO',
              'miner-manager',
            );
            removed = true;
            break;
          }
        } catch {
          // Continue trying other paths
          continue;
        }
      }

      if (!removed) {
        // If we couldn't find the file in common locations, try using find command
        try {
          const findResult = await this.execCommand(
            `find /tmp /var/run /run -name "${sessionFileName}" 2>/dev/null || true`,
            3000,
          );

          const foundPaths = findResult
            .trim()
            .split('\n')
            .filter((path) => path.trim());

          for (const foundPath of foundPaths) {
            try {
              if (await this.fileExists(foundPath)) {
                await this.safeUnlink(foundPath);
                this.loggingService.log(
                  `🗑️ Manually removed orphaned session file: ${foundPath}`,
                  'INFO',
                  'miner-manager',
                );
                removed = true;
              }
            } catch {
              continue;
            }
          }
        } catch {
          // Find command failed, that's okay
        }
      }

      if (!removed) {
        this.loggingService.log(
          `⚠️ Could not locate session file for cleanup: ${sessionFileName}`,
          'WARN',
          'miner-manager',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Error during manual session file cleanup: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
    }
  }

  public async startMiner(): Promise<boolean> {
    try {
      const miner = await this.getMinerFromFlightsheet();
      if (!miner) {
        const error = 'Cannot start miner: No miner found in flightsheet';
        this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
        void this.logMinerError(error);
        return false;
      }

      const configPath = `apps/${miner}/config.json`;
      const minerExecutableBase = `apps/${miner}/${miner}`;
      const minerExecutable = process.platform === 'win32'
        ? `${minerExecutableBase}.exe`
        : minerExecutableBase;

      const configExists = await this.fileExists(configPath);
      const execExists = await this.fileExists(minerExecutable);

      if (!configExists || !execExists) {
        this.loggingService.log(
          `⚠️ Miner ${miner} not found. Attempting automatic installation...`,
          'WARN',
          'miner-manager',
        );
        this.loggingService.log(
          `  Initial check - Config: ${configPath} exists: ${configExists}`,
          'INFO',
          'miner-manager',
        );
        this.loggingService.log(
          `  Initial check - Executable: ${minerExecutable} exists: ${execExists}`,
          'INFO',
          'miner-manager',
        );

        // Attempt automatic installation
        const installSuccess = await this.installMinerIfMissing(miner);
        if (!installSuccess) {
          const error = `Cannot start miner: Failed to install ${miner}`;
          this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
          void this.logMinerError(error);
          return false;
        }

        // Check again after installation
        this.loggingService.log(
          `🔍 Post-installation verification for ${miner}...`,
          'INFO',
          'miner-manager',
        );
        const configExistsAfter = await this.fileExists(configPath);
        const execExistsAfter = await this.fileExists(minerExecutable);
        this.loggingService.log(
          `  Config path: ${configPath} - exists: ${configExistsAfter}`,
          'INFO',
          'miner-manager',
        );
        this.loggingService.log(
          `  Executable path: ${minerExecutable} - exists: ${execExistsAfter}`,
          'INFO',
          'miner-manager',
        );

        if (!configExistsAfter || !execExistsAfter) {
          const error = `Cannot start miner: Missing files at ${configPath} or ${minerExecutable} after installation`;
          this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
          void this.logMinerError(error);
          return false;
        }
      }

      // Clean up any existing miner sessions before starting a new one
      await this.cleanupAllMinerSessions();

      if (process.platform === 'win32') {
        this.minerProcess = spawn(minerExecutable, ['-c', configPath], {
          detached: true,
          stdio: 'ignore',
        });
        this.minerProcess.unref();
      } else {
        await this.execCommand(`chmod +x ${minerExecutable}`);
        exec(
          `screen -dmS ${this.minerScreen} ${minerExecutable} -c ${configPath}`,
        );
      }

      this.loggingService.log(
        `✅ Started miner: ${miner} with config ${configPath}`,
        'INFO',
        'miner-manager',
      );
      this.lastMinerStartAt = new Date().toISOString();
      this.updateMinerRunningCache(true);
      return true;
    } catch (error) {
      void this.logMinerError(
        `Failed to start miner: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
      return false;
    }
  }

  public async stopMiner(isManualStop: boolean = false): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        if (this.minerProcess?.pid) {
          try {
            process.kill(this.minerProcess.pid);
          } catch {
            try {
              await this.execCommand(`taskkill /PID ${this.minerProcess.pid} /T /F`, 5000);
            } catch {
              // Ignore taskkill errors
            }
          }
        }

        this.minerProcess = undefined;
        this.updateMinerRunningCache(false);

        if (isManualStop) {
          this.isManuallyStoppedByUser = true;
          this.manualStopTime = new Date();
          this.loggingService.log('✋ Miner manually stopped by user', 'INFO', 'miner-manager');
        } else {
          this.loggingService.log('✅ Miner stopped successfully', 'INFO', 'miner-manager');
        }

        return true;
      }

      if (!(await this.isScreenAvailable())) {
        this.loggingService.log(
          'ℹ️ Screen not available, skipping miner stop',
          'DEBUG',
          'miner-manager',
        );
        return true;
      }

      if (!(await this.isMinerRunningAsync())) {
        this.loggingService.log(
          'ℹ️ No miner session found to stop',
          'INFO',
          'miner-manager',
        );
        return true;
      }

      // Clean up all miner sessions instead of just trying to stop one
      await this.cleanupAllMinerSessions();
      this.updateMinerRunningCache(false);

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
      void this.logMinerError(
        `Failed to stop miner: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
      return false;
    }
  }

  getLastMinerStartAt(): string | undefined {
    return this.lastMinerStartAt;
  }

  public async restartMiner(): Promise<boolean> {
    this.loggingService.log('🔄 Restarting miner...', 'INFO', 'miner-manager');

    // Record restart time for cooldown tracking
    this.lastRestartTime = new Date();

    const stopped = await this.stopMiner();
    if (!stopped) {
      const error = 'Failed to restart: Could not stop miner';
      this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
      await this.logMinerError(error);
      return false;
    }

    const started = await this.startMiner();
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
      // Add timeout protection for flightsheet update to prevent hanging
      const updated = (await Promise.race([
        this.flightsheetService.updateFlightsheet(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('Flightsheet update timeout after 25 seconds')),
            25000,
          ),
        ),
      ])) as boolean;

      const miner = await this.getMinerFromFlightsheet();

      if (!miner) {
        await this.logMinerError('No miner found from flightsheet.');
        return false;
      }

      return updated;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          '⏰ Flightsheet update timed out after 25 seconds',
          'WARN',
          'miner-manager',
        );
      } else {
        await this.logMinerError(
          `Failed to update flightsheet: ${error.message}`,
          error.stack,
        );
      }
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

      // Mark that initial startup is complete and future monitoring should include flightsheet checks
      this.isInitialStartup = false;

      const updated = await this.fetchAndUpdateFlightsheet();
      if (updated) {
        this.loggingService.log(
          '✅ Flightsheet fetched successfully, attempting to start miner...',
          'INFO',
          'miner-manager',
        );

        const miner = await this.getMinerFromFlightsheet();
        if (miner) {
          void this.startMiner();
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
        // Ensure miner is started after bootstrap, even if flightsheet did not change
        if (!this.isMinerRunning()) {
          this.loggingService.log(
            'No miner running after bootstrap, starting miner...',
            'INFO',
            'miner-manager',
          );
          void this.startMiner();
        }
      }
    } catch (error) {
      await this.logMinerError(
        `Failed to trigger initial flightsheet fetch: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
    }
  }

  private async checkSchedules() {
    // First check if benchmark mode is active - if so, skip all schedule logic
    const config = await this.configService.getConfig();
    if (config && config.benchmark === true) {
      this.loggingService.log(
        '🚀 Benchmark mode active - skipping schedule checks',
        'DEBUG',
        'miner-manager',
      );
      return;
    }

    // Optimize schedule checking by caching config and only checking when necessary
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    // Only check schedules if we haven't checked recently (unless it's a schedule boundary time)
    if (this.lastScheduleCheck) {
      const timeSinceLastCheck =
        now.getTime() - this.lastScheduleCheck.getTime();
      const isScheduleBoundary =
        currentTime.endsWith(':00') || currentTime.endsWith(':30'); // Check on hour/half-hour boundaries

      if (timeSinceLastCheck < 60000 && !isScheduleBoundary) {
        // Less than 1 minute and not a boundary
        return; // Skip this check to reduce config reads
      }
    }

    this.lastScheduleCheck = now;

    if (!config) {
      this.loggingService.log(
        '⚠️ Cannot check schedules: No config found',
        'WARN',
        'miner-manager',
      );
      return;
    }

    const currentDay = now
      .toLocaleString('en-US', { weekday: 'long' })
      .toLowerCase();

    // Check for multiple sessions and log warning (only every 5 minutes to reduce noise)
    const sessionCount = await this.getMinerSessionCountAsync();
    if (sessionCount > 1 && currentTime.endsWith(':00')) {
      // Only log on hour boundaries
      this.loggingService.log(
        `⚠️ Multiple miner sessions detected (${sessionCount}). This may indicate session cleanup issues.`,
        'WARN',
        'miner-manager',
      );
    }

    // Only log detailed schedule checks in DEBUG and on boundary times to reduce log noise
    if (currentTime.endsWith(':00') || currentTime.endsWith(':30')) {
      this.loggingService.log(
        `🕒 Checking schedules at ${currentTime} on ${currentDay} (${sessionCount} sessions)`,
        'DEBUG',
        'miner-manager',
      );
    }

    // Check scheduled mining periods
    if (config.schedules?.scheduledMining?.enabled) {
      const periods = config.schedules.scheduledMining.periods || [];

      let shouldMine = false;
      let isRunning = await this.isMinerRunningAsync();

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
            if (!isRunning) {
              this.loggingService.log(
                `⏰ Starting miner for scheduled period: ${period.startTime} - ${period.endTime} on ${currentDay}`,
                'INFO',
                'miner-manager',
              );
              // Use async start to ensure it completes
              const started = await this.startMiner();
              if (!started) {
                this.loggingService.log(
                  `❌ Failed to start miner for scheduled period on ${currentDay}`,
                  'ERROR',
                  'miner-manager',
                );
              } else {
                isRunning = true;
              }
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
      if (!shouldMine && isRunning) {
        this.loggingService.log(
          `⏰ Stopping miner outside scheduled periods on ${currentDay} at ${currentTime}`,
          'INFO',
          'miner-manager',
        );
        await this.stopMiner();
        isRunning = false;
      }
    } else {
      // If scheduling is disabled, make sure miner is running
      const isRunning = await this.isMinerRunningAsync();
      if (!isRunning) {
        this.loggingService.log(
          'ℹ️ Schedule disabled, ensuring miner is running',
          'INFO',
          'miner-manager',
        );
        const started = await this.startMiner();
        if (!started) {
          this.loggingService.log(
            '❌ Failed to start miner when scheduling is disabled',
            'ERROR',
            'miner-manager',
          );
        }
      }
    }

    // Check scheduled restarts - independent of mining schedule
    const restarts = config.schedules?.scheduledRestarts || [];
    for (const restart of restarts) {
      let restartTime: string;
      let restartDays: string[] | undefined;

      // Support both string format (from config) and object format (from API)
      if (typeof restart === 'string') {
        // Simple string format: "03:00"
        restartTime = restart;
        restartDays = undefined; // Apply to all days
      } else if (restart && typeof restart === 'object' && restart.time) {
        // Object format: { time: "03:00", days: ["monday", "tuesday"] }
        restartTime = restart.time;
        restartDays = restart.days;
      } else {
        this.loggingService.log(
          `⚠️ Invalid restart configuration (expected string or object with time property): ${JSON.stringify(restart)}`,
          'WARN',
          'miner-manager',
        );
        continue;
      }

      // Check if restart applies to current day (if days are specified)
      const appliesToday = !restartDays || restartDays.includes(currentDay);

      if (appliesToday && currentTime === restartTime) {
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
    let end = this.timeToMinutes(endTime);

    // Special case: if end time is 00:00, treat it as end of day (24:00 = 1440 minutes)
    // This handles schedules like "08:00-00:00" (8 AM to midnight)
    if (endTime === '00:00' && startTime !== '00:00') {
      end = 1440; // 24:00 in minutes
    }

    // Log the comparison for debugging
    this.loggingService.log(
      `⏱️ Time comparison - Current: ${currentTime}(${current}), Start: ${startTime}(${start}), End: ${endTime}(${end})`,
      'DEBUG',
      'miner-manager',
    );

    // Normal time range (including 08:00-24:00 cases)
    if (start <= end) {
      return current >= start && current < end; // Use < for end to exclude exact end time
    }
    // True overnight time range (e.g., 22:00-06:00)
    else {
      return current >= start || current < end; // Use < for end time
    }
  }

  // Helper to convert HH:MM to minutes
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Smart error tracking to prevent API spam
   * Only reports errors to API after multiple occurrences and with cooldown
   */
  private trackAndReportError(errorKey: string, fullMessage: string): void {
    const now = new Date();

    // Clean up old error entries periodically
    if (Math.random() < 0.1) {
      // 10% chance on each call
      this.cleanupOldErrorEntries(now);
    }

    // Get or create error tracking entry
    let errorEntry = this.errorTracker.get(errorKey);
    if (!errorEntry) {
      errorEntry = {
        count: 0,
        firstSeen: now,
        lastSeen: now,
      };
      this.errorTracker.set(errorKey, errorEntry);
    }

    // Update error tracking
    errorEntry.count++;
    errorEntry.lastSeen = now;

    // Log locally for debugging
    this.loggingService.log(
      `📊 Error tracking: "${errorKey}" - Count: ${errorEntry.count}/${this.ERROR_REPORT_THRESHOLD}`,
      'DEBUG',
      'miner-manager',
    );

    // Check if we should report to API
    const shouldReport = this.shouldReportError(errorEntry, now);

    if (shouldReport) {
      this.loggingService.log(
        `📤 Reporting error to API after ${errorEntry.count} occurrences: ${errorKey}`,
        'INFO',
        'miner-manager',
      );

      errorEntry.lastReported = now;
      // Don't await to avoid blocking health checks
      void this.logMinerError(fullMessage);
    } else {
      this.loggingService.log(
        `⏳ Error not yet reported (${errorEntry.count}/${this.ERROR_REPORT_THRESHOLD}): ${errorKey}`,
        'DEBUG',
        'miner-manager',
      );
    }
  }

  /**
   * Determine if error should be reported to API based on tracking rules
   */
  private shouldReportError(
    errorEntry: {
      count: number;
      firstSeen: Date;
      lastSeen: Date;
      lastReported?: Date;
    },
    now: Date,
  ): boolean {
    // Report if we've reached the threshold
    if (errorEntry.count >= this.ERROR_REPORT_THRESHOLD) {
      // Check cooldown if already reported before
      if (errorEntry.lastReported) {
        const timeSinceLastReport =
          now.getTime() - errorEntry.lastReported.getTime();
        if (timeSinceLastReport < this.ERROR_REPORT_COOLDOWN) {
          return false; // Still in cooldown period
        }
      }
      return true; // Ready to report
    }

    return false; // Haven't reached threshold yet
  }

  /**
   * Clean up old error entries to prevent memory leaks
   */
  private cleanupOldErrorEntries(now: Date): void {
    for (const [errorKey, errorEntry] of this.errorTracker.entries()) {
      const timeSinceLastSeen = now.getTime() - errorEntry.lastSeen.getTime();
      if (timeSinceLastSeen > this.ERROR_TRACKER_CLEANUP_INTERVAL) {
        this.errorTracker.delete(errorKey);
        this.loggingService.log(
          `🧹 Cleaned up old error entry: ${errorKey}`,
          'DEBUG',
          'miner-manager',
        );
      }
    }
  }

  private async logMinerError(message: string, stack?: string): Promise<void> {
    try {
      const config = await this.configService.getConfig();
      if (!config?.minerId) {
        this.loggingService.log(
          '❌ Cannot log error: No minerId found',
          'ERROR',
          'miner-manager',
        );
        return;
      }

      const additionalInfo = {
        minerSoftware: await this.getMinerFromFlightsheet(),
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
  private async dumpScheduleStatus(): Promise<void> {
    try {
      const config = await this.configService.getConfig();
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
  public async getScheduleStatus(): Promise<any> {
    try {
      const config = await this.configService.getConfig();
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
          .map((restart) => {
            // Only support new object format from backend API
            if (!restart || typeof restart !== 'object' || !restart.time) {
              return null; // Invalid format
            }

            const restartTime = restart.time;
            const timeMinutes = this.timeToMinutes(restartTime);
            return {
              time: restartTime,
              minutes: timeMinutes,
              isToday: timeMinutes > currentMinutes,
              timeUntil:
                timeMinutes > currentMinutes
                  ? timeMinutes - currentMinutes
                  : 24 * 60 - currentMinutes + timeMinutes,
            };
          })
          .filter(
            (restart): restart is NonNullable<typeof restart> =>
              restart !== null,
          ) // Remove invalid entries
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
        shouldMine: await this.shouldBeMining(),
        isRunning: this.isMinerRunning(),
      };
    } catch (error) {
      return {
        status: 'error',
        message: `Failed to get schedule status: ${error.message}`,
      };
    }
  }

  async onApplicationShutdown() {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    this.clearIntervals();
    MinerManagerService.isInitialized = false;
    await this.stopMiner();
    this.loggingService.log(
      '🛑 MinerManager shutdown complete',
      'INFO',
      'miner-manager',
    );
  }

  /**
   * Automatically install miner if it's missing
   */
  private async installMinerIfMissing(minerName: string): Promise<boolean> {
    try {
      this.loggingService.log(
        `🔧 Starting automatic installation for ${minerName}...`,
        'INFO',
        'miner-manager',
      );

      // Check system compatibility first with timeout protection
      const compatibility = (await Promise.race([
        this.minerSoftwareService.checkCPUCompatibility(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('CPU compatibility check timeout after 15 seconds'),
              ),
            15000,
          ),
        ),
      ])) as any;

      this.loggingService.log(
        `📋 System compatibility - OS: ${compatibility.os}, Arch: ${compatibility.architecture}, Termux: ${compatibility.isTermux}, AES: ${compatibility.hasAES}`,
        'INFO',
        'miner-manager',
      );

      if (process.platform === 'win32' && !compatibility.is64Bit) {
        this.loggingService.log(
          '❌ Windows 32-bit is not supported by ccminer/XMRig. Please use 64-bit Windows.',
          'ERROR',
          'miner-manager',
        );
        return false;
      }

      if (minerName === 'xmrig') {
        if (process.platform === 'win32') {
          this.loggingService.log(
            '📥 Downloading XMRig Windows binary...',
            'INFO',
            'miner-manager',
          );

          const success = await this.minerSoftwareService.downloadXmrigBinary(compatibility);
          if (success) {
            this.loggingService.log(
              '🎉 XMRig Windows download completed successfully!',
              'INFO',
              'miner-manager',
            );
          } else {
            this.loggingService.log(
              '❌ XMRig Windows download failed',
              'ERROR',
              'miner-manager',
            );
          }

          return success;
        }

        // For XMRig, check prerequisites and compile
        this.loggingService.log(
          '🔍 Checking XMRig compilation prerequisites...',
          'INFO',
          'miner-manager',
        );

        const prerequisites =
          await this.minerSoftwareService.checkXmrigPrerequisites(
            compatibility,
          );

        if (!prerequisites.canCompile) {
          this.loggingService.log(
            `❌ Cannot compile XMRig. Issues: ${prerequisites.issues.join(', ')}`,
            'ERROR',
            'miner-manager',
          );

          if (prerequisites.recommendations.length > 0) {
            this.loggingService.log(
              `💡 Recommendations: ${prerequisites.recommendations.join(', ')}`,
              'INFO',
              'miner-manager',
            );
          }

          return false;
        }

        this.loggingService.log(
          '✅ Prerequisites met. Starting XMRig compilation...',
          'INFO',
          'miner-manager',
        );

        const success =
          await this.minerSoftwareService.compileAndInstallXmrig(compatibility);

        if (success) {
          this.loggingService.log(
            '🎉 XMRig compilation and installation completed successfully!',
            'INFO',
            'miner-manager',
          );
        } else {
          this.loggingService.log(
            '❌ XMRig compilation failed',
            'ERROR',
            'miner-manager',
          );
        }

        return success;
      } else if (minerName === 'ccminer') {
        // For ccminer, download pre-compiled binary
        this.loggingService.log(
          '📥 Downloading optimal ccminer binary...',
          'INFO',
          'miner-manager',
        );

        const success =
          await this.minerSoftwareService.downloadOptimalCcminer(compatibility);

        if (success) {
          this.loggingService.log(
            '🎉 CCMiner download and installation completed successfully!',
            'INFO',
            'miner-manager',
          );
        } else {
          this.loggingService.log(
            '❌ CCMiner download failed',
            'ERROR',
            'miner-manager',
          );
        }

        return success;
      } else {
        this.loggingService.log(
          `❌ Unsupported miner for automatic installation: ${minerName}`,
          'ERROR',
          'miner-manager',
        );
        return false;
      }
    } catch (error) {
      this.loggingService.log(
        `❌ Error during automatic installation of ${minerName}: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'miner-manager',
      );
      return false;
    }
  }
}
