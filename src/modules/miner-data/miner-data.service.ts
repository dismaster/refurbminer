import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { EnhancedTelemetryService } from '../telemetry/enhanced-telemetry.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { LoggingService } from '../logging/logging.service';
import { ConfigService } from '../config/config.service';

@Injectable()
export class MinerDataService implements OnModuleInit, OnApplicationShutdown {
  private telemetryInterval: NodeJS.Timeout | null = null;
  private minerId: string | null = null;
  private rigToken: string | null = null;

  constructor(
    private readonly telemetryService: EnhancedTelemetryService,
    private readonly apiService: ApiCommunicationService,
    private readonly loggingService: LoggingService,
    private readonly configService: ConfigService,
  ) {
    this.loggingService.log(
      '🎯 MinerDataService constructor called',
      'DEBUG',
      'miner-data',
    );
  }

  async onModuleInit() {
    this.loggingService.log(
      '🚀 MinerDataService started. Sending telemetry every 60s.',
      'INFO',
      'miner-data',
    );

    // ✅ Load minerId from config and rigToken from environment
    const config = this.configService.getConfig();
    this.minerId = config?.minerId || null;
    this.rigToken = this.configService.getRigToken();

    if (!this.minerId || !this.rigToken) {
      this.loggingService.log(
        '❌ Missing minerId or rigToken in config. Telemetry will not be sent.',
        'ERROR',
        'miner-data',
      );
      return;
    }

    if (this.telemetryInterval !== null) {
      this.loggingService.log(
        '⚠️ Telemetry interval already running. Skipping duplicate.',
        'WARN',
        'miner-data',
      );
      return;
    }

    // ✅ Send telemetry immediately on startup
    await this.sendTelemetry();

    // ✅ Send telemetry every 60s
    this.telemetryInterval = setInterval(async () => {
      await this.sendTelemetry();
    }, 60000);
  }

  async sendTelemetry() {
    if (!this.minerId || !this.rigToken) {
      this.loggingService.log(
        '❌ Cannot send telemetry. Missing minerId or rigToken.',
        'ERROR',
        'miner-data',
      );
      return;
    }

    try {
      const telemetryData = await this.telemetryService.getTelemetryData();
      // Debug telemetry logging disabled to reduce noise
      // this.loggingService.log(
      //  `📡 Sending telemetry:\nminerId: ${this.minerId}\nData: ${JSON.stringify(telemetryData, null, 2)}`,
      //  'DEBUG',
      //  'miner-data'
      // );

      await this.apiService.updateTelemetry(this.minerId, telemetryData);
      this.loggingService.log(
        '✅ Telemetry successfully sent to API.',
        'INFO',
        'miner-data',
      );
    } catch (error) {
      // Enhanced error logging
      //this.loggingService.log(
      //  `❌ Failed to send telemetry:\nError: ${error.message}\nStack: ${error.stack}`,
      //  'ERROR',
      //  'miner-data'
      //);

      // Check connection with timeout protection
      try {
        const response = (await Promise.race([
          fetch(this.apiService.getApiUrl()),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error('API connection check timeout after 5 seconds'),
                ),
              5000,
            ),
          ),
        ])) as Response;

        if (!response.ok) {
          this.loggingService.log(
            '⚠️ API endpoint is not responding correctly',
            'ERROR',
            'miner-data',
          );
        }
      } catch (networkError: any) {
        if (networkError.message?.includes('timeout')) {
          this.loggingService.log(
            '⏰ API connection check timed out after 5 seconds',
            'WARN',
            'miner-data',
          );
        } else {
          this.loggingService.log(
            `⚠️ Cannot reach API: ${networkError.message}`,
            'ERROR',
            'miner-data',
          );
        }
      }
    }
  }

  onApplicationShutdown() {
    if (this.telemetryInterval !== null) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
      this.loggingService.log(
        '🛑 Stopped telemetry sending.',
        'INFO',
        'miner-data',
      );
    }
  }
}
