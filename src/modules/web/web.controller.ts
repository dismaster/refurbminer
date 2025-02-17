import { Controller, Get } from '@nestjs/common';
import { TelemetryService } from '../telemetry/telemetry.service';

@Controller()
export class WebController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get('api/telemetry')
  async getTelemetry() {
    return await this.telemetryService.getTelemetryData();
  }
}