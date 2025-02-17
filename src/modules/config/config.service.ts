import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import * as fs from 'fs';
import * as path from 'path';

interface SchedulePeriod {
  start: string;
  end: string;
  days: string[];
}

interface ScheduleRestart {
  time: string;
  days: string[];
}

interface Config {
  minerId: string;
  rigId: string;
  schedules: {
    scheduledMining: {
      enabled: boolean;
      periods: SchedulePeriod[];
    };
    scheduledRestarts: ScheduleRestart[];
  };
}

@Injectable()
export class ConfigService {
  constructor(private readonly loggingService: LoggingService) {}

  getConfig() {
    try {
      const configPath = path.join(process.cwd(), 'config', 'config.json');
      this.loggingService.log(`📂 Reading config from: ${configPath}`, 'DEBUG', 'config');
      
      if (!fs.existsSync(configPath)) {
        throw new Error('Config file not found');
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      this.loggingService.log('✅ Config loaded successfully', 'DEBUG', 'config');
      return config;
    } catch (error) {
      this.loggingService.log(`❌ Failed to load config: ${error.message}`, 'ERROR', 'config');
      return null;
    }
  }

  getRigToken(): string | null {
    const token = process.env.RIG_TOKEN;
    if (!token) {
      this.loggingService.log('❌ RIG_TOKEN not found in environment', 'ERROR', 'config');
    }
    return token || null;
  }
}