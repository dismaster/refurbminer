import { Controller, Get } from '@nestjs/common';
import { EnhancedTelemetryService } from '../telemetry/enhanced-telemetry.service';
import { TelemetryData } from '../telemetry/utils/network-info.util';

@Controller()
export class WebController {
  constructor(private readonly telemetryService: EnhancedTelemetryService) {}

  @Get('api/telemetry')
  async getTelemetry(): Promise<TelemetryData | null> {
    return await Promise.race([
      this.telemetryService.getTelemetryData(),
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error('Telemetry fetch timeout after 15 seconds')),
          15000,
        ),
      ),
    ]);
  }
}