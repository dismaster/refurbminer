import { Controller, Get } from '@nestjs/common';
import { EnhancedTelemetryService } from './enhanced-telemetry.service';
import { TelemetryData } from './utils/network-info.util';

@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: EnhancedTelemetryService) {}

  @Get()
  getTelemetry(): Promise<TelemetryData | null> {
    return this.telemetryService.getTelemetryData();
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