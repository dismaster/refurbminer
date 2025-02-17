import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiCommunicationService } from './api-communication.service';

@Controller('api')
export class ApiCommunicationController {
  constructor(private readonly apiService: ApiCommunicationService) {}

  @Post('register-miner')
  async registerMiner(@Body() body: { metadata: any; minerIp: string }) {
    return this.apiService.registerMiner(body.metadata, body.minerIp);
  }

  @Get('miner-config')
  async getMinerConfig() {
    return this.apiService.getMinerConfig();
  }

  @Get('flightsheet')
  async getFlightsheet() {
    return this.apiService.getFlightsheet();
  }

  @Get('miner-actions/:minerId/pending')
  async getPendingMinerActions(@Param('minerId') minerId: string) {
    return this.apiService.getPendingMinerActions(minerId);
  }

  @Put('miner-actions/:actionId/complete')
  async updateMinerActionStatus(
    @Param('actionId') actionId: string,
    @Body() body: { status: string; error?: string },
  ) {
    return this.apiService.updateMinerActionStatus(actionId, body.status, body.error);
  }
}
