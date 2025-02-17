import { Controller, Get } from '@nestjs/common';
import { MinerDataService } from './miner-data.service';

@Controller('miner-data')
export class MinerDataController {
  constructor(private readonly minerDataService: MinerDataService) {
    console.log('🚀 MinerDataController initialized');
  }

  @Get('send-telemetry')
  async sendTelemetry() {
    await this.minerDataService.sendTelemetry();
    return { success: true, message: 'Telemetry sent' };
  }
}