import { Controller, Post, Get } from '@nestjs/common';
import { MinerManagerService } from './miner-manager.service';
import { ConfigService } from '../config/config.service';
import { execSync } from 'child_process';
import * as fs from 'fs';

@Controller('miner')
export class MinerManagerController {
  constructor(
    private readonly minerManagerService: MinerManagerService,
    private readonly configService: ConfigService,
  ) {}
  @Post('start')
  async startMiner() {
    const result = await Promise.race([
      this.minerManagerService.startMiner(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Miner start timeout after 30 seconds')),
          30000,
        ),
      ),
    ]);
    return {
      message: result
        ? 'Miner started successfully.'
        : 'Failed to start miner.',
    };
  }
  @Post('stop')
  stopMiner() {
    const result = this.minerManagerService.stopMiner(true); // Set manual stop flag
    return {
      message: result ? 'Miner stopped successfully.' : 'No miner was running.',
    };
  }
  @Post('restart')
  async restartMiner() {
    await Promise.race([
      this.minerManagerService.restartMiner(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Miner restart timeout after 30 seconds')),
          30000,
        ),
      ),
    ]);
    return { message: 'Miner restart command sent.' };
  }

  @Get('status')
  getStatus() {
    const isRunning = this.minerManagerService.isMinerRunning();
    const shouldBeMining = this.minerManagerService.shouldBeMining();
    const config = this.configService.getConfig();

    return {
      status: isRunning ? 'running' : 'stopped',
      shouldBeMining,
      benchmark: config?.benchmark ?? false,
      scheduleStatus: this.minerManagerService.getScheduleStatus(),
      rigInfo: {
        rigId: config?.rigId || 'Unknown',
        minerId: config?.minerId || 'Unknown',
        name: config?.name || 'Unknown',
        minerSoftware: config?.minerSoftware || 'Unknown',
      },
      monitoring: {
        apiSyncInterval: '5 minutes',
        scheduleCheckInterval: '1 minute',
        healthCheckInterval: '30 seconds',
        outputMonitoring: 'enabled', // Indicates enhanced health checking
      },
    };
  }

  @Get('health')
  async getHealthStatus() {
    const isRunning = this.minerManagerService.isMinerRunning();
    const shouldBeMining = this.minerManagerService.shouldBeMining();
    
    if (!isRunning) {
      return {
        status: 'stopped',
        healthy: !shouldBeMining,
        message: shouldBeMining ? 'Miner should be running but is stopped' : 'Miner is stopped as expected',
      };
    }

    // Get recent miner output for health assessment
    try {
      const output = await this.getMinerOutput();
      const healthStatus = this.assessMinerHealth(output);
      
      return {
        status: 'running',
        healthy: healthStatus.healthy,
        message: healthStatus.message,
        recentOutput: output.split('\n').slice(-10), // Last 10 lines
        lastActivity: healthStatus.lastActivity,
        connectionStatus: healthStatus.connectionStatus,
      };
    } catch (error) {
      return {
        status: 'running',
        healthy: false,
        message: 'Unable to assess miner health',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ensure storage directory exists and is writable
   */
  private ensureStorageDirectory(): void {
    try {
      if (!fs.existsSync('storage')) {
        fs.mkdirSync('storage', { recursive: true });
      }
    } catch (error) {
      throw new Error(`Failed to create storage directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getMinerOutput(): Promise<string> {
    const hardcopyFile = `storage/miner-health-${Date.now()}.txt`;
    
    try {
      // Ensure storage directory exists
      this.ensureStorageDirectory();
      
      // Create hardcopy of screen session with timeout
      execSync(`screen -S miner-session -X hardcopy ${hardcopyFile}`, {
        timeout: 10000,
      });
      
      // Wait for file to be written
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      if (fs.existsSync(hardcopyFile)) {
        const output = fs.readFileSync(hardcopyFile, 'utf8');
        try {
          fs.unlinkSync(hardcopyFile);
        } catch {
          // Ignore cleanup errors
        }
        return output;
      }
      
      // If hardcopy file doesn't exist, try alternative method
      try {
        // Use a temporary file instead of /dev/stdout for better compatibility
        const tempFile = `storage/temp-output-${Date.now()}.txt`;
        
        execSync(`screen -S miner-session -X hardcopy ${tempFile}`, {
          timeout: 5000,
        });
        
        // Wait for file to be written
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        if (fs.existsSync(tempFile)) {
          const output = fs.readFileSync(tempFile, 'utf8');
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // Ignore cleanup errors
          }
          return output;
        }
      } catch {
        // Fall through to return error message
      }
      
      return 'Unable to capture miner output - screen session may not be responsive';
    } catch (error) {
      return `Error capturing output: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private assessMinerHealth(output: string): {
    healthy: boolean;
    message: string;
    lastActivity?: Date;
    connectionStatus: string;
  } {
    const lines = output.split('\n');
    
    // Detect miner software from output
    const minerSoftware = this.detectMinerFromOutput(output);
    
    // Get miner-specific error patterns
    const errorPatterns = this.getErrorPatterns(minerSoftware);

    let hasErrors = false;
    let lastActivity: Date | undefined;
    let connectionStatus = 'unknown';

    // Check recent lines for errors and activity
    const recentLines = lines.slice(-20);
    
    for (const line of recentLines) {
      // Check for errors
      for (const pattern of errorPatterns) {
        if (pattern.test(line)) {
          hasErrors = true;
          break;
        }
      }

      // Extract timestamp if present - support both ccminer and XMRig formats
      const timestampPatterns = [
        /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/, // XMRig format
        /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/, // XMRig with milliseconds
        /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/, // ccminer format
      ];

      for (const pattern of timestampPatterns) {
        const timestampMatch = line.match(pattern);
        if (timestampMatch) {
          try {
            const timeStr = timestampMatch[1];
            const logTime = new Date(timeStr);
            if (!lastActivity || logTime > lastActivity) {
              lastActivity = logTime;
            }
            break;
          } catch {
            // Ignore date parsing errors
          }
        }
      }

      // Check connection status using miner-specific patterns
      connectionStatus = this.getConnectionStatus(line, minerSoftware, connectionStatus);
    }

    // Determine health status
    let healthy = true;
    let message = `${minerSoftware || 'Miner'} appears to be running normally`;

    if (hasErrors) {
      healthy = false;
      message = `${minerSoftware || 'Miner'} has connection or error issues`;
    } else if (lastActivity) {
      const timeSinceActivity = Date.now() - lastActivity.getTime();
      if (timeSinceActivity > 5 * 60 * 1000) { // 5 minutes
        healthy = false;
        message = `No recent ${minerSoftware || 'mining'} activity detected`;
      }
    }

    return {
      healthy,
      message,
      lastActivity,
      connectionStatus,
    };
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
      /disconnected from pool/i,
      /authentication failed/i,
      /pool rejected/i,
      /no response from pool/i,
    ];

    if (minerSoftware === 'ccminer') {
      return [
        ...commonPatterns,
        /cuda error/i,
        /opencl error/i,
        /gpu error/i,
        /device error/i,
        /stratum authentication failed/i,
      ];
    } else if (minerSoftware === 'xmrig') {
      return [
        ...commonPatterns,
        // XMRig specific errors - exclude normal operational messages
        /randomx init failed/i, // Only if init completely fails
        /pool connection error/i,
        /tls handshake failed/i,
        /job timeout/i,
        /backend error/i,
        /bind failed/i,
        /login failed/i,
        /connect error/i,
        /compilation failed/i,
        /cuda init failed/i,
        /opencl init failed/i,
        // Note: We exclude these normal messages:
        // - "failed to allocate RandomX dataset" (normal when no huge pages)
        // - "switching to slow mode" (normal fallback)
        // - "huge pages disabled" (normal configuration)
        // - "fast RandomX mode disabled" (normal configuration)
      ];
    }

    // Default: return common patterns
    return commonPatterns;
  }

  /**
   * Get connection status using miner-specific patterns
   */
  private getConnectionStatus(
    line: string,
    minerSoftware?: string,
    currentStatus: string = 'unknown',
  ): string {
    if (minerSoftware === 'ccminer') {
      if (line.includes('Starting on stratum')) {
        return 'connected';
      } else if (line.includes('accepted') && line.includes('yes!')) {
        return 'mining';
      } else if (line.includes('connection interrupted') || line.includes('disconnected')) {
        return 'disconnected';
      }
    } else if (minerSoftware === 'xmrig') {
      if (line.includes('use pool')) {
        return 'connected';
      } else if (
        line.includes('new job from') ||
        line.includes('speed') ||
        line.includes('H/s')
      ) {
        return 'mining';
      } else if (line.includes('connection interrupted') || line.includes('disconnected')) {
        return 'disconnected';
      }
    } else {
      // Default patterns for unknown miners
      if (line.includes('Starting on stratum') || line.includes('use pool')) {
        return 'connected';
      } else if (
        (line.includes('accepted') && line.includes('yes!')) ||
        line.includes('new job from') ||
        line.includes('speed') ||
        line.includes('H/s')
      ) {
        return 'mining';
      } else if (line.includes('connection interrupted') || line.includes('disconnected')) {
        return 'disconnected';
      }
    }

    return currentStatus;
  }
}
