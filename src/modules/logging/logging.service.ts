import { Injectable, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { ConfigService } from '../config/config.service';

// Load environment variables
dotenv.config();

// Define log file paths
const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE_PATH = path.join(LOGS_DIR, 'app.log');
const MAX_LOGS = 100;
const DEFAULT_LOG_LEVEL = 'INFO';

// Log levels for backend sending
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  SUCCESS: 4,
  VERBOSE: 5
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

interface PendingLog {
  message: string;
  level: LogLevel;
  module: string;
  timestamp: Date;
  stack?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class LoggingService {
  private logLevel: string;
  private logToConsole: boolean;
  
  // Rate limiting for debug logs to prevent I/O overload
  private logCache = new Map<string, number>();
  private readonly LOG_RATE_LIMIT = 30000; // 30 seconds for duplicate debug logs
  
  // In-memory buffer for batch writes
  private logBuffer: string[] = [];
  private bufferTimer?: NodeJS.Timeout;
  private readonly BUFFER_SIZE = 10;
  private readonly BUFFER_TIMEOUT = 5000; // 5 seconds

  // Backend logging configuration
  private sendToBackend: boolean;
  private backendLogLevel: string;
  private pendingLogs: PendingLog[] = [];
  private backendSendTimer?: NodeJS.Timeout;
  private readonly BACKEND_BATCH_SIZE = 5;
  private readonly BACKEND_BATCH_TIMEOUT = 30000; // 30 seconds
  private readonly IMMEDIATE_SEND_LEVELS: LogLevel[] = ['ERROR', 'WARN'];

  // API service for sending logs (will be injected)
  private apiService: ApiCommunicationService;
  private configService: ConfigService;

  constructor(
    @Inject(forwardRef(() => ApiCommunicationService))
    apiService: ApiCommunicationService,
    configService: ConfigService,
  ) {
    this.apiService = apiService;
    this.configService = configService;
    
    this.logLevel = (process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).toUpperCase().trim();
    this.logToConsole = process.env.LOG_TO_CONSOLE === 'true';
    
    // Backend logging configuration
    this.sendToBackend = process.env.SEND_LOGS_TO_BACKEND === 'true';
    this.backendLogLevel = (process.env.BACKEND_LOG_LEVEL || 'WARN').toUpperCase().trim();

    this.ensureLogFileExists();
  }

  /** ✅ Ensure logs directory and file exist */
  private ensureLogFileExists(): void {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    if (!fs.existsSync(LOG_FILE_PATH)) {
      fs.writeFileSync(LOG_FILE_PATH, '', { flag: 'w' });
    }
  }

  /** ✅ Log message with level & module name */
  log(message: string, level: string = 'INFO', module: string = 'General', metadata?: Record<string, any>): void {
    const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE', 'SUCCESS'];
    const normalizedLevel = level.toUpperCase();
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(normalizedLevel);
    if (messageLevelIndex > currentLevelIndex) return; // Skip lower-level logs

    // Rate limit debug logs to prevent excessive I/O
    if (normalizedLevel === 'DEBUG') {
      const key = `${module}:${message.substring(0, 50)}`; // Use first 50 chars as key
      const now = Date.now();
      const lastLog = this.logCache.get(key);

      if (lastLog && now - lastLog < this.LOG_RATE_LIMIT) {
        return; // Skip duplicate debug logs
      }

      this.logCache.set(key, now);

      // Clean old cache entries periodically
      if (this.logCache.size > 100) {
        const oldKeys = Array.from(this.logCache.entries())
          .filter(([, timestamp]) => now - timestamp > this.LOG_RATE_LIMIT * 2)
          .map(([key]) => key);
        oldKeys.forEach((key) => this.logCache.delete(key));
      }
    }

    const timestamp = new Date();
    const logEntry = `${timestamp.toISOString()} [${normalizedLevel}] [${module}] ${message}`;

    // Add to buffer for batch write
    this.addToBuffer(logEntry);

    // Print to console if enabled
    if (this.logToConsole) {
      this.printToConsole(logEntry, normalizedLevel);
    }

    // Send to backend if enabled and level qualifies
    if (this.sendToBackend && this.shouldSendToBackend(normalizedLevel)) {
      this.addToBackendQueue({
        message,
        level: normalizedLevel as LogLevel,
        module,
        timestamp,
        metadata,
      });
    }
  }

  /**
   * Enhanced log methods with metadata support
   */
  error(message: string, module: string = 'General', metadata?: Record<string, any>): void {
    this.log(message, 'ERROR', module, metadata);
  }

  warn(message: string, module: string = 'General', metadata?: Record<string, any>): void {
    this.log(message, 'WARN', module, metadata);
  }

  info(message: string, module: string = 'General', metadata?: Record<string, any>): void {
    this.log(message, 'INFO', module, metadata);
  }

  debug(message: string, module: string = 'General', metadata?: Record<string, any>): void {
    this.log(message, 'DEBUG', module, metadata);
  }

  success(message: string, module: string = 'General', metadata?: Record<string, any>): void {
    this.log(message, 'SUCCESS', module, metadata);
  }

  /** ✅ Add log to buffer for batch writing */
  private addToBuffer(logEntry: string): void {
    this.logBuffer.push(logEntry);

    // Write immediately if buffer is full
    if (this.logBuffer.length >= this.BUFFER_SIZE) {
      this.flushBuffer();
    } else {
      // Set timer to flush buffer after timeout
      if (!this.bufferTimer) {
        this.bufferTimer = setTimeout(() => {
          this.flushBuffer();
        }, this.BUFFER_TIMEOUT);
      }
    }
  }

  /** ✅ Flush buffer to file */
  private flushBuffer(): void {
    if (this.logBuffer.length === 0) return;

    try {
      // Read existing logs
      const logs = fs.existsSync(LOG_FILE_PATH)
        ? fs.readFileSync(LOG_FILE_PATH, 'utf8').split('\n').filter(Boolean)
        : [];

      // Add buffered logs
      logs.push(...this.logBuffer);

      // Keep only last MAX_LOGS entries
      if (logs.length > MAX_LOGS) {
        logs.splice(0, logs.length - MAX_LOGS);
      }

      // Write updated logs
      fs.writeFileSync(LOG_FILE_PATH, logs.join('\n') + '\n', 'utf8');

      // Clear buffer and timer
      this.logBuffer = [];
      if (this.bufferTimer) {
        clearTimeout(this.bufferTimer);
        this.bufferTimer = undefined;
      }
    } catch (error) {
      console.error(
        `[ERROR] LoggingService failed to write to log file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** ✅ Print logs to console */
  private printToConsole(logEntry: string, level: string): void {
    switch (level) {
      case 'ERROR':
        console.error(logEntry);
        break;
      case 'WARN':
        console.warn(logEntry);
        break;
      default:
        console.log(logEntry);
        break;
    }
  }

  /** ✅ Retrieve last N logs */
  getLogs(limit: number = 50): string[] {
    // Flush any pending logs first
    this.flushBuffer();
    
    return fs.existsSync(LOG_FILE_PATH)
      ? fs.readFileSync(LOG_FILE_PATH, 'utf8').split('\n').filter(Boolean).slice(-limit)
      : [];
  }

  /** ✅ Clean up resources on shutdown */
  onApplicationShutdown(): void {
    this.flushBuffer();
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
    }
    
    // Send any pending backend logs
    this.flushBackendLogs();
    if (this.backendSendTimer) {
      clearTimeout(this.backendSendTimer);
    }
  }

  /** ✅ Clear rate limiting cache manually if needed */
  clearCache(): void {
    this.logCache.clear();
  }

  /**
   * Check if log level should be sent to backend
   * Supports both hierarchical (e.g., "WARN") and explicit list (e.g., "ERROR,SUCCESS,INFO")
   */
  private shouldSendToBackend(level: string): boolean {
    // Check if backendLogLevel contains comma (explicit list mode)
    if (this.backendLogLevel.includes(',')) {
      const allowedLevels = this.backendLogLevel
        .split(',')
        .map(l => l.trim().toUpperCase())
        .filter(l => l.length > 0);
      return allowedLevels.includes(level.toUpperCase());
    }
    
    // Traditional hierarchical mode
    const backendLevels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'SUCCESS'];
    const backendLevelIndex = backendLevels.indexOf(this.backendLogLevel.toUpperCase());
    const messageLevelIndex = backendLevels.indexOf(level.toUpperCase());
    
    // If backendLogLevel is not found, default to ERROR only
    if (backendLevelIndex === -1) {
      return level.toUpperCase() === 'ERROR';
    }
    
    return messageLevelIndex <= backendLevelIndex;
  }

  /**
   * Add log to backend sending queue
   */
  private addToBackendQueue(logData: PendingLog): void {
    this.pendingLogs.push(logData);

    // Send immediately for critical levels
    if (this.IMMEDIATE_SEND_LEVELS.includes(logData.level)) {
      this.flushBackendLogs();
    } else {
      // Batch send for other levels
      if (this.pendingLogs.length >= this.BACKEND_BATCH_SIZE) {
        this.flushBackendLogs();
      } else if (!this.backendSendTimer) {
        this.backendSendTimer = setTimeout(() => {
          this.flushBackendLogs();
        }, this.BACKEND_BATCH_TIMEOUT);
      }
    }
  }

  /**
   * Send all pending logs to backend
   */
  private async flushBackendLogs(): Promise<void> {
    if (this.pendingLogs.length === 0) return;
    if (!this.apiService || !this.configService) return;

    const logsToSend = [...this.pendingLogs];
    this.pendingLogs = [];

    // Clear timer
    if (this.backendSendTimer) {
      clearTimeout(this.backendSendTimer);
      this.backendSendTimer = undefined;
    }

    try {
      const config = this.configService.getConfig();
      if (!config?.minerId) return;

      // Send each log individually to match your backend's expected format
      for (const logData of logsToSend) {
        try {
          await this.sendLogToBackend(config.minerId, logData);
        } catch (error) {
          // Don't log to avoid infinite loops, just queue for retry
          console.error(`Failed to send log to backend: ${error.message}`);
        }
      }
    } catch (error) {
      // Re-queue logs for retry on next flush
      this.pendingLogs.unshift(...logsToSend);
      console.error(`Backend log flush failed: ${error.message}`);
    }
  }

  /**
   * Send individual log to backend using existing error endpoint
   */
  private async sendLogToBackend(minerId: string, logData: PendingLog): Promise<void> {
    try {
      const additionalInfo = {
        level: logData.level.toLowerCase(),
        module: logData.module,
        timestamp: logData.timestamp.toISOString(),
        ...logData.metadata,
      };

      // Use the existing logMinerError method with correct parameters
      await this.apiService.logMinerError(
        minerId,
        logData.message,
        logData.stack || 'No stack trace',
        additionalInfo
      );
    } catch (error) {
      throw new Error(`API call failed: ${error.message}`);
    }
  }
}
