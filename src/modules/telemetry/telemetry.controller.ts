import { Controller, Get } from '@nestjs/common';
import { EnhancedTelemetryService } from './enhanced-telemetry.service';

@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: EnhancedTelemetryService) {}

  @Get()
  getTelemetry() {
    return this.telemetryService.getTelemetryData();
  }

  @Get('history')
  async getHistory() {
    return this.telemetryService.getHistoricalData();
  }
}