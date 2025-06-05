import { Controller, Get } from '@nestjs/common';
import { EnhancedTelemetryService } from '../telemetry/enhanced-telemetry.service';

@Controller()
export class WebController {
  constructor(private readonly telemetryService: EnhancedTelemetryService) {}

  @Get('api/telemetry')
  async getTelemetry() {
    return await this.telemetryService.getTelemetryData();
  }
}