import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import * as path from 'path';
import {
  EnvironmentConfigUtil,
  EnvironmentInfo,
} from './utils/environment-config.util';

interface FlightsheetData {
  [key: string]: unknown;
}

@Injectable()
export class FlightsheetService {
  private flightsheetDir = 'apps';
  private environmentInfo: EnvironmentInfo | null = null;

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly configService: ConfigService,
  ) {}

  async updateFlightsheet(): Promise<boolean> {
    try {
      this.loggingService.log(
        '📡 Fetching flightsheet from API...',
        'INFO',
        'flightsheet',
      );

      // Get miner software from config (synced from backend API)
      const minerSoftware = this.configService.getMinerSoftware();
      if (!minerSoftware) {
        this.loggingService.log(
          '❌ Cannot fetch flightsheet: No minerSoftware found in config. Ensure config is synced with backend.',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      this.loggingService.log(
        `🔍 Using miner software from config: ${minerSoftware}`,
        'INFO',
        'flightsheet',
      );

      const minerId = this.configService.getMinerId();
      if (!minerId) {
        this.loggingService.log(
          '❌ Cannot fetch flightsheet: No minerId found',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      const flightsheet = await this.apiService.getFlightsheet(minerId);

      if (!flightsheet) {
        this.loggingService.log(
          '❌ Invalid flightsheet received.',
          'ERROR',
          'flightsheet',
        );
        return false;
      }

      const minerConfigPath = path.join(
        this.flightsheetDir,
        minerSoftware,
        'config.json',
      );

      if (!fs.existsSync(path.dirname(minerConfigPath))) {
        fs.mkdirSync(path.dirname(minerConfigPath), { recursive: true });
      }

      // Apply environment-specific optimizations for XMRig
      let optimizedFlightsheet = flightsheet;
      if (minerSoftware === 'xmrig') {
        optimizedFlightsheet = await this.applyXMRigOptimizations(flightsheet);
      }

      if (!this.hasFlightsheetChanged(minerConfigPath, optimizedFlightsheet)) {
        this.loggingService.log(
          `⚡ Flightsheet unchanged. Skipping update.`,
          'INFO',
          'flightsheet',
        );
        return false;
      }

      fs.writeFileSync(
        minerConfigPath,
        JSON.stringify(optimizedFlightsheet, null, 2),
      );
      this.loggingService.log(
        `✅ Flightsheet updated: ${minerConfigPath}`,
        'INFO',
        'flightsheet',
      );

      return true;
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to update flightsheet: ${error.message}`,
        'ERROR',
        'flightsheet',
      );
      return false;
    }
  }

  /**
   * Apply environment-specific optimizations for XMRig configuration
   */
  private applyXMRigOptimizations(flightsheet: any): any {
    try {
      // Get or cache environment information
      if (!this.environmentInfo) {
        this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();

        // Log environment detection results
        const envSummary = EnvironmentConfigUtil.getEnvironmentSummary(
          this.environmentInfo,
        );
        this.loggingService.log(
          `🔍 Environment detected: ${envSummary}`,
          'INFO',
          'flightsheet',
        );
      }

      // Generate optimized configuration
      const optimizedConfig = EnvironmentConfigUtil.generateOptimalXMRigConfig(
        flightsheet,
        this.environmentInfo,
      );

      this.loggingService.log(
        `⚡ Applied XMRig optimizations: RandomX=${this.environmentInfo.recommendedRandomXMode}, HugePages=${this.environmentInfo.shouldUseHugePages}`,
        'INFO',
        'flightsheet',
      );

      return optimizedConfig;
    } catch (error: any) {
      this.loggingService.log(
        `⚠️ Failed to apply XMRig optimizations: ${error.message}`,
        'WARN',
        'flightsheet',
      );
      return flightsheet; // Return original on error
    }
  }

  /**
   * Get current environment information
   */
  getEnvironmentInfo(): EnvironmentInfo {
    if (!this.environmentInfo) {
      this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();
    }
    return this.environmentInfo;
  }

  /**
   * Force refresh environment detection
   */
  refreshEnvironmentInfo(): EnvironmentInfo {
    this.environmentInfo = EnvironmentConfigUtil.detectEnvironment();
    return this.environmentInfo;
  }

  private hasFlightsheetChanged(
    filePath: string,
    newFlightsheet: any,
  ): boolean {
    if (!fs.existsSync(filePath)) return true;

    try {
      const currentFlightsheet = JSON.parse(
        fs.readFileSync(filePath, 'utf8'),
      );
      return (
        JSON.stringify(currentFlightsheet) !==
        JSON.stringify(newFlightsheet)
      );
    } catch (error: any) {
      this.loggingService.log(
        `⚠️ Error reading flightsheet file: ${error.message}`,
        'WARN',
        'flightsheet',
      );
      return true;
    }
  }

  getFlightsheet(miner: string): any {
    try {
      const minerConfigPath = path.join(
        this.flightsheetDir,
        miner,
        'config.json',
      );

      if (!fs.existsSync(minerConfigPath)) {
        this.loggingService.log(
          `🚨 No flightsheet found for miner: ${miner} at ${minerConfigPath}`,
          'WARN',
          'flightsheet',
        );
        return null;
      }

      const flightsheet = JSON.parse(
        fs.readFileSync(minerConfigPath, 'utf8'),
      );
      return flightsheet;
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to retrieve flightsheet: ${error.message}`,
        'ERROR',
        'flightsheet',
      );
      return null;
    }
  }

}
