import { Controller, Get, Post, Param } from '@nestjs/common';
import { FlightsheetService } from './flightsheet.service';
import { EnvironmentConfigUtil } from './utils/environment-config.util';

@Controller('flightsheet')
export class FlightsheetController {
  constructor(private readonly flightsheetService: FlightsheetService) {}

  /** ✅ Trigger flightsheet update from API */
  @Post('update')
  async updateFlightsheet() {
    const success = await this.flightsheetService.updateFlightsheet();
    return success ? { message: 'Flightsheet updated successfully.' } : { error: 'Flightsheet update failed.' };
  }

  /** ✅ Get flightsheet for specific miner */
  @Get(':miner')
  getFlightsheet(@Param('miner') miner: string) {
    const flightsheet = this.flightsheetService.getFlightsheet(miner);
    return flightsheet ? flightsheet : { error: 'Flightsheet not found.' };
  }

  /** ✅ Get current environment information */
  @Get('environment/info')
  getEnvironmentInfo() {
    return this.flightsheetService.getEnvironmentInfo();
  }

  /** ✅ Refresh environment detection */
  @Post('environment/refresh')
  refreshEnvironmentInfo() {
    const environmentInfo = this.flightsheetService.refreshEnvironmentInfo();
    return {
      message: 'Environment information refreshed successfully.',
      environmentInfo,
    };
  }

  /** ✅ Get environment summary for debugging */
  @Get('environment/summary')  getEnvironmentSummary() {
    const environmentInfo = this.flightsheetService.getEnvironmentInfo();
    return {
      summary: EnvironmentConfigUtil.getEnvironmentSummary(environmentInfo),
      details: environmentInfo,
    };
  }
}
