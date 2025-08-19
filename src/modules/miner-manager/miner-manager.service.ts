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
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MinerManagerService
  implements OnModuleInit, OnApplicationShutdown
{
  private static isInitialized = false;
  private minerScreen = 'miner-session';
  
  // Consolidated monitoring
  private mainMonitoringInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  
  // Monitoring cycle counters for staggered operations
  private monitoringCycle = 0;
  
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

  constructor(
    private readonly loggingService: LoggingService,
    private readonly flightsheetService: FlightsheetService,
    private readonly configService: ConfigService,
    private readonly apiService: ApiCommunicationService,
    private readonly minerSoftwareService: MinerSoftwareService,
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
      void this.performStaggeredMonitoring();
    }, 60000); // Every 1 minute

    // More frequent health check interval to catch miner crashes quickly
    this.healthCheckInterval = setInterval(() => {
      void this.checkMinerHealth();
    }, 30000); // Every 30 seconds for responsive crash detection

    // Cleanup interval - runs every hour
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, 3600000); // Every hour

    // Run initial checks
    void this.performStaggeredMonitoring();
    void this.checkSchedules();
    this.dumpScheduleStatus();

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
      await this.configService.syncConfigWithApi();

      // CRITICAL: Check flightsheet AFTER config sync to use updated miningCpus
      this.loggingService.log(
        '🔄 Checking for flightsheet updates...',
        'DEBUG',
        'miner-manager',
      );
      const updated = await this.fetchAndUpdateFlightsheet();
      if (updated) {
        await this.logMinerError('Flightsheet changed, restarting miner');
        void this.restartMiner();
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

  /**
   * Perform periodic cleanup to prevent resource leaks
   */
  private performCleanup(): void {
    try {
      // Clear old cache entries in config service
      this.configService.clearApiCache?.();

      // Clean up old log files and storage files
      this.cleanupOldFiles();

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

  /**
   * Clean up old storage files
   */
  private cleanupOldFiles(): void {
    try {
      const storageDir = 'storage';
      if (!fs.existsSync(storageDir)) return;

      const files = fs.readdirSync(storageDir);
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      let cleanedCount = 0;
      files.forEach((file: string) => {
        if (file.startsWith('miner-output-')) {
          const filePath = path.join(storageDir, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.mtime.getTime() < oneHourAgo) {
              fs.unlinkSync(filePath);
              cleanedCount++;
            }
          } catch {
            // Ignore cleanup errors for individual files
          }
        }
      });

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
      const config = this.configService.getConfig();
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
        if (this.isMinerRunning()) {
          this.loggingService.log(
            '⚠️ Stopping current miner due to software change...',
            'INFO',
            'miner-manager',
          );
          
          const stopped = this.stopMiner();
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

      const shouldBeMining = this.shouldBeMining();
      const isMinerRunning = this.isMinerRunning();

      this.loggingService.log(
        `🔍 Health check: Should mine=${shouldBeMining}, Is running=${isMinerRunning}`,
        'DEBUG',
        'miner-manager',
      );

      if (shouldBeMining && !isMinerRunning) {
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
          if (this.lastRestartTime && 
              now.getTime() - this.lastRestartTime.getTime() < this.RESTART_COOLDOWN) {
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

  /**
   * Ensure storage directory exists and is writable
   */
  private ensureStorageDirectory(): void {
    try {
      if (!fs.existsSync('storage')) {
        fs.mkdirSync('storage', { recursive: true });
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
      if (!this.isMinerRunning()) {
        this.loggingService.log(
          '⚠️ Miner screen session not found during health check',
          'DEBUG',
          'miner-manager',
        );
        return false;
      }

      // Detect which miner is running for appropriate health checks
      const minerSoftware = this.getMinerFromFlightsheet();
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
        
        // Method 1: Direct in-memory capture using screen hardcopy to stdout
        const screenOutput = execSync(
          `timeout 5 screen -S ${this.minerScreen} -X hardcopy /dev/stdout 2>/dev/null || echo "screen_capture_failed"`,
          {
            encoding: 'utf8',
            timeout: 10000,
          },
        );
        
        if (screenOutput && !screenOutput.includes('screen_capture_failed')) {
          output = screenOutput;
          this.loggingService.log(
            `✅ Successfully captured miner output in-memory (${output.length} chars)`,
            'DEBUG',
            'miner-manager',
          );
        } else {
          // Method 2: Alternative in-memory approach using screen -p to print buffer
          try {
            const altOutput = execSync(
              `timeout 3 screen -S ${this.minerScreen} -X eval 'hardcopy -h /dev/stdout' 2>/dev/null || echo "alt_capture_failed"`,
              {
                encoding: 'utf8',
                timeout: 8000,
              },
            );
            
            if (altOutput && !altOutput.includes('alt_capture_failed')) {
              output = altOutput;
              this.loggingService.log(
                `✅ Successfully captured miner output with alternative in-memory method (${output.length} chars)`,
                'DEBUG',
                'miner-manager',
              );
            }
          } catch (altError) {
            this.loggingService.log(
              `⚠️ Alternative in-memory capture method failed: ${altError instanceof Error ? altError.message : String(altError)}`,
              'DEBUG',
              'miner-manager',
            );
          }
        }
      } catch (screenError) {
        this.loggingService.log(
          `⚠️ In-memory capture failed: ${screenError instanceof Error ? screenError.message : String(screenError)}`,
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
          this.ensureStorageDirectory();
          
          const hardcopyFile = `storage/miner-health-${Date.now()}.txt`;
          
          // Create hardcopy of screen session with timeout
          execSync(`screen -S ${this.minerScreen} -X hardcopy ${hardcopyFile}`, {
            timeout: 10000,
          });
          
          // Wait for file to be written
          await new Promise((resolve) => setTimeout(resolve, 1000));
          
          if (fs.existsSync(hardcopyFile)) {
            output = fs.readFileSync(hardcopyFile, 'utf8');
            this.loggingService.log(
              `✅ Successfully captured miner output via file method (${output.length} chars)`,
              'DEBUG',
              'miner-manager',
            );
            try {
              fs.unlinkSync(hardcopyFile);
            } catch {
              // Ignore cleanup errors
            }
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
          execSync(
            `timeout 5 screen -S ${this.minerScreen} -X hardcopy ${altHardcopyFile} 2>/dev/null`,
            {
              timeout: 10000,
            },
          );
          
          // Wait a bit longer for the file
          await new Promise((resolve) => setTimeout(resolve, 1500));
          
          if (fs.existsSync(altHardcopyFile)) {
            output = fs.readFileSync(altHardcopyFile, 'utf8');
            this.loggingService.log(
              `✅ Successfully captured miner output with alternative approach (${output.length} chars)`,
              'DEBUG',
              'miner-manager',
            );
            try {
              fs.unlinkSync(altHardcopyFile);
            } catch {
              // Ignore cleanup errors
            }
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
          execSync(`screen -S ${this.minerScreen} -X info`, { timeout: 5000 });
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
        return this.analyzeOutput(output, minerSoftware);
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

  /**
   * Analyze miner output for errors and issues
   */
  private async analyzeOutput(output: string, minerSoftware?: string): Promise<boolean> {
    // Detect miner software if not provided
    if (!minerSoftware) {
      minerSoftware = this.detectMinerFromOutput(output) || this.getMinerFromFlightsheet();
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
          this.loggingService.log(
            `🔍 Detected ${minerSoftware} error in output: ${line.trim()}`,
            'WARN',
            'miner-manager',
          );
          await this.logMinerError(`${minerSoftware} output error: ${line.trim()}`);
          hasErrors = true;
          break;
        }
      }
      if (hasErrors) break;
    }

    // Check for recent activity using miner-specific patterns
    const now = new Date();
    const recentActivity = this.checkForRecentMinerActivity(lines, now, minerSoftware);
    
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

    return hasErrors;
  }

  /**
   * Detect miner software from output patterns
   */
  private detectMinerFromOutput(output: string): string | null {
    // XMRig patterns
    if (output.includes('XMRig/') || 
        output.includes('randomx') || 
        output.includes('new job from') ||
        output.includes('algo rx/')) {
      return 'xmrig';
    }
    
    // CCMiner patterns
    if (output.includes('ccminer') || 
        output.includes('stratum+tcp') ||
        output.includes('accepted') ||
        output.includes('kH/s')) {
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
      // Get the miner software from main config
      const minerSoftware = this.configService.getMinerSoftware();
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
    try {
      // First check if screen session exists
      const screenOutput = execSync(`screen -ls`, {
        encoding: 'utf8',
        timeout: 5000,
      });
      
      // Look for our specific session name
      const sessionExists = screenOutput.includes(this.minerScreen);
      
      if (!sessionExists) {
        this.loggingService.log(
          `📋 No screen session '${this.minerScreen}' found`,
          'DEBUG',
          'miner-manager',
        );
        return false;
      }

      // Additional check: verify the session is actually attached/detached (not dead)
      const sessionLines = screenOutput.split('\n');
      for (const line of sessionLines) {
        if (line.includes(this.minerScreen)) {
          // Check if session shows as Dead, Detached, or Attached
          if (line.includes('(Dead)')) {
            this.loggingService.log(
              `💀 Screen session '${this.minerScreen}' is dead, cleaning up`,
              'WARN',
              'miner-manager',
            );
            this.cleanupAllMinerSessions();
            return false;
          }
          
          // Session exists and is not dead
          this.loggingService.log(
            `✅ Screen session '${this.minerScreen}' is running: ${line.trim()}`,
            'DEBUG',
            'miner-manager',
          );
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.loggingService.log(
        `❌ Error checking miner status: ${error instanceof Error ? error.message : String(error)}`,
        'DEBUG',
        'miner-manager',
      );
      return false;
    }
  }

  /**
   * Get the count of running miner sessions
   */
  public getMinerSessionCount(): number {
    try {
      const output = execSync(`screen -ls | grep ${this.minerScreen}`, {
        encoding: 'utf8',
      });

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

  /**
   * Clean up all miner sessions (useful when multiple sessions exist)
   */
  private cleanupAllMinerSessions(): void {
    try {
      const output = execSync(`screen -ls | grep ${this.minerScreen}`, {
        encoding: 'utf8',
      });

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
              execSync(`screen -X -S ${sessionId}.${this.minerScreen} quit`, {
                timeout: 5000,
              });
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
              this.cleanupOrphanedSessionFile(sessionId);
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

  /**
   * Manually remove orphaned screen session files when screen command fails
   */
  private cleanupOrphanedSessionFile(sessionId: string): void {
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
          if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
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
          const findResult = execSync(
            `find /tmp /var/run /run -name "${sessionFileName}" 2>/dev/null || true`,
            {
              encoding: 'utf8',
              timeout: 3000,
            },
          );

          const foundPaths = findResult
            .trim()
            .split('\n')
            .filter((path) => path.trim());
          
          for (const foundPath of foundPaths) {
            try {
              if (fs.existsSync(foundPath)) {
                fs.unlinkSync(foundPath);
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
      const miner = this.getMinerFromFlightsheet();
      if (!miner) {
        const error = 'Cannot start miner: No miner found in flightsheet';
        this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
        void this.logMinerError(error);
        return false;
      }

      const configPath = `apps/${miner}/config.json`;
      const minerExecutable = `apps/${miner}/${miner}`;

      if (!fs.existsSync(configPath) || !fs.existsSync(minerExecutable)) {
        this.loggingService.log(
          `⚠️ Miner ${miner} not found. Attempting automatic installation...`,
          'WARN',
          'miner-manager',
        );
        this.loggingService.log(
          `  Initial check - Config: ${configPath} exists: ${fs.existsSync(configPath)}`,
          'INFO',
          'miner-manager',
        );
        this.loggingService.log(
          `  Initial check - Executable: ${minerExecutable} exists: ${fs.existsSync(minerExecutable)}`,
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
        this.loggingService.log(
          `  Config path: ${configPath} - exists: ${fs.existsSync(configPath)}`,
          'INFO',
          'miner-manager',
        );
        this.loggingService.log(
          `  Executable path: ${minerExecutable} - exists: ${fs.existsSync(minerExecutable)}`,
          'INFO',
          'miner-manager',
        );
        
        if (!fs.existsSync(configPath) || !fs.existsSync(minerExecutable)) {
          const error = `Cannot start miner: Missing files at ${configPath} or ${minerExecutable} after installation`;
          this.loggingService.log(`❌ ${error}`, 'ERROR', 'miner-manager');
          void this.logMinerError(error);
          return false;
        }
      }

      // Clean up any existing miner sessions before starting a new one
      this.cleanupAllMinerSessions();

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
      void this.logMinerError(
        `Failed to start miner: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
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

      // Clean up all miner sessions instead of just trying to stop one
      this.cleanupAllMinerSessions();

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

  public async restartMiner(): Promise<boolean> {
    this.loggingService.log('🔄 Restarting miner...', 'INFO', 'miner-manager');
    
    // Record restart time for cooldown tracking
    this.lastRestartTime = new Date();
    
    const stopped = this.stopMiner();
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
      }
    } catch (error) {
      await this.logMinerError(
        `Failed to trigger initial flightsheet fetch: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack || '' : '',
      );
    }
  }

  private async checkSchedules() {
    // Optimize schedule checking by caching config and only checking when necessary
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);
    
    // Only check schedules if we haven't checked recently (unless it's a schedule boundary time)
    if (this.lastScheduleCheck) {
      const timeSinceLastCheck = now.getTime() - this.lastScheduleCheck.getTime();
      const isScheduleBoundary = currentTime.endsWith(':00') || currentTime.endsWith(':30'); // Check on hour/half-hour boundaries
      
      if (timeSinceLastCheck < 60000 && !isScheduleBoundary) { // Less than 1 minute and not a boundary
        return; // Skip this check to reduce config reads
      }
    }
    
    this.lastScheduleCheck = now;
    
    const config = this.configService.getConfig();
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
    const sessionCount = this.getMinerSessionCount();
    if (sessionCount > 1 && currentTime.endsWith(':00')) { // Only log on hour boundaries
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
              // Use async start to ensure it completes
              const started = await this.startMiner();
              if (!started) {
                this.loggingService.log(
                  `❌ Failed to start miner for scheduled period on ${currentDay}`,
                  'ERROR',
                  'miner-manager',
                );
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

      // Check system compatibility first
      const compatibility =
        await this.minerSoftwareService.checkCPUCompatibility();

      this.loggingService.log(
        `📋 System compatibility - OS: ${compatibility.os}, Arch: ${compatibility.architecture}, Termux: ${compatibility.isTermux}, AES: ${compatibility.hasAES}`,
        'INFO',
        'miner-manager',
      );

      if (minerName === 'xmrig') {
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
