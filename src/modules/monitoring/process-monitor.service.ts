import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';

@Injectable()
export class ProcessMonitorService implements OnModuleInit, OnApplicationShutdown {
  private watchdogInterval?: NodeJS.Timeout;
  private lastHeartbeat: number = Date.now();
  private readonly HEARTBEAT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly loggingService: LoggingService) {}

  onModuleInit() {
    this.startWatchdog();
    this.loggingService.log('🐕 Process watchdog initialized', 'INFO', 'process-monitor');
  }

  onApplicationShutdown() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
  }

  /**
   * Update heartbeat to indicate the application is still responsive
   */
  heartbeat(): void {
    this.lastHeartbeat = Date.now();
  }

  /**
   * Start watchdog timer that checks for application responsiveness
   */
  private startWatchdog(): void {
    this.watchdogInterval = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
      
      if (timeSinceLastHeartbeat > this.HEARTBEAT_TIMEOUT) {
        this.loggingService.log(
          `🚨 Application appears to be stuck! Last heartbeat was ${Math.round(timeSinceLastHeartbeat / 1000)}s ago`,
          'ERROR',
          'process-monitor'
        );
        
        // Log current process state for debugging
        this.logProcessState();
        
        // Reset heartbeat to prevent spam
        this.lastHeartbeat = Date.now();
      }
    }, 60000); // Check every minute
  }

  /**
   * Log current process state for debugging
   */
  private logProcessState(): void {
    try {
      const memUsage = process.memoryUsage();
      const uptime = process.uptime();
      
      this.loggingService.log(
        `📊 Process State - Uptime: ${Math.round(uptime)}s, Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        'INFO',
        'process-monitor'
      );
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to log process state: ${error.message}`,
        'ERROR',
        'process-monitor'
      );
    }
  }
}
