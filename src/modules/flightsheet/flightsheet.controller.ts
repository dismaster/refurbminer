import { Controller, Get, Post, Param } from '@nestjs/common';
import { FlightsheetService } from './flightsheet.service';

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
}
