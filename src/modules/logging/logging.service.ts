import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Define log file paths
const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE_PATH = path.join(LOGS_DIR, 'app.log');
const MAX_LOGS = 100;
const DEFAULT_LOG_LEVEL = 'INFO';

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

  constructor() {
    this.logLevel = (process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).toUpperCase().trim();
    this.logToConsole = process.env.LOG_TO_CONSOLE === 'true';

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
  log(message: string, level: string = 'INFO', module: string = 'General'): void {
    const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level.toUpperCase());
    if (messageLevelIndex > currentLevelIndex) return; // Skip lower-level logs

    // Rate limit debug logs to prevent excessive I/O
    if (level.toUpperCase() === 'DEBUG') {
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

    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} [${level}] [${module}] ${message}`;

    // Add to buffer for batch write
    this.addToBuffer(logEntry);

    // Print to console if enabled
    if (this.logToConsole) {
      this.printToConsole(logEntry, level);
    }
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
  }

  /** ✅ Clear rate limiting cache manually if needed */
  clearCache(): void {
    this.logCache.clear();
  }
}
