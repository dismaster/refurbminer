import { Controller, Get } from '@nestjs/common';
import { EnhancedTelemetryService } from './enhanced-telemetry.service';
import { TelemetryData } from './utils/network-info.util';

@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: EnhancedTelemetryService) {}

  @Get()
  async getTelemetry(): Promise<TelemetryData | null> {
    return this.telemetryService.getTelemetrySnapshot();
  }

  @Get('history')
  async getHistory() {
    return this.telemetryService.getHistoricalData();
  }

  @Get('version')
  getVersion() {
    return this.telemetryService.getAppInfo();
  }
}