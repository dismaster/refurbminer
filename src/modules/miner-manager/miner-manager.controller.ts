import { Controller, Post, Get, Body } from '@nestjs/common';
import { MinerManagerService } from './miner-manager.service';

@Controller('miner')
export class MinerManagerController {
  constructor(private readonly minerManagerService: MinerManagerService) {}

  @Post('start')
  startMiner(@Body() body: { miner?: string }) {
    const result = this.minerManagerService.startMiner();
    return { message: result ? 'Miner started successfully.' : 'Failed to start miner.' };
  }

  @Post('stop')
  stopMiner() {
    const result = this.minerManagerService.stopMiner();
    return { message: result ? 'Miner stopped successfully.' : 'No miner was running.' };
  }

  @Post('restart')
  restartMiner() {
    this.minerManagerService.restartMiner();
    return { message: 'Miner restart command sent.' };
  }
}
