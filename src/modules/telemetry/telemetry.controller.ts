import { Controller, Get } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';

@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get()
  getTelemetry() {
    return this.telemetryService.getTelemetryData();
  }

  @Get('history')
  async getHistory() {
    return this.telemetryService.getHistoricalData();
  }
}