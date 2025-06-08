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

  constructor() {
    this.logLevel = (process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).toUpperCase().trim();
    this.logToConsole = process.env.LOG_TO_CONSOLE === 'true';

    // Debug: Log the resolved paths
    console.log(`[LoggingService] Working directory: ${process.cwd()}`);
    console.log(`[LoggingService] LOGS_DIR: ${LOGS_DIR}`);
    console.log(`[LoggingService] LOG_FILE_PATH: ${LOG_FILE_PATH}`);
    console.log(`[LoggingService] Log level: ${this.logLevel}`);
    console.log(`[LoggingService] Log to console: ${this.logToConsole}`);

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

    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} [${level}] [${module}] ${message}`;

    // Write to file
    this.writeToFile(logEntry);

    // Print to console if enabled
    if (this.logToConsole) {
      this.printToConsole(logEntry, level);
    }
  }
  /** ✅ Write logs to file (keeps last 100 logs) */
  private writeToFile(logEntry: string): void {
    try {
      // Debug: Log that we're attempting to write
      console.log(`[LoggingService] Attempting to write: ${logEntry}`);
      console.log(`[LoggingService] Writing to: ${LOG_FILE_PATH}`);
      
      // Ensure logs directory exists
      if (!fs.existsSync(LOGS_DIR)) {
        console.log(`[LoggingService] Creating directory: ${LOGS_DIR}`);
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }

      // Ensure log file exists
      if (!fs.existsSync(LOG_FILE_PATH)) {
        console.log(`[LoggingService] Creating log file: ${LOG_FILE_PATH}`);
        fs.writeFileSync(LOG_FILE_PATH, '', { flag: 'w' });
      }

      // Read existing logs
      const logs = fs.existsSync(LOG_FILE_PATH)
        ? fs.readFileSync(LOG_FILE_PATH, 'utf8').split('\n').filter(Boolean)
        : [];

      console.log(`[LoggingService] Existing logs count: ${logs.length}`);

      // Add new log entry
      logs.push(logEntry);

      // Keep only last MAX_LOGS entries
      if (logs.length > MAX_LOGS) {
        logs.shift();
      }

      // Write updated logs
      fs.writeFileSync(LOG_FILE_PATH, logs.join('\n') + '\n', 'utf8');
      console.log(`[LoggingService] Successfully wrote log entry to file`);
    } catch (error) {
      console.error(`[ERROR] LoggingService failed to write to log file: ${error instanceof Error ? error.message : String(error)}`);
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
    return fs.existsSync(LOG_FILE_PATH)
      ? fs.readFileSync(LOG_FILE_PATH, 'utf8').split('\n').filter(Boolean).slice(-limit)
      : [];
  }
}
