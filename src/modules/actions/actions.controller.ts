import { Controller, Get, Post, Body, BadRequestException } from '@nestjs/common';
import { ActionsService } from './actions.service';
import { ConfigService } from '../config/config.service';

@Controller('actions')
export class ActionsController {
  constructor(
    private readonly actionsService: ActionsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Manually trigger a check for pending actions
   */
  @Post('check')
  async checkActions() {
    await this.actionsService.checkForPendingActions();
    return { success: true, message: 'Action check triggered' };
  }
  
  /**
   * Manually trigger miner restart
   */
  @Post('restart-miner')
  async restartMiner() {
    if (this.configService.getBenchmarkFlag()) {
      throw new BadRequestException('Cannot restart miner during benchmark mode');
    }
    await this.actionsService.restartMiner();
    return { success: true, message: 'Miner restart initiated' };
  }
  
  /**
   * Manually trigger config reload
   */
  @Post('reload-config')
  async reloadConfig() {
    await this.actionsService.reloadConfig();
    return { success: true, message: 'Config reload initiated' };
  }
  
  /**
   * Manually stop mining
   */
  @Post('stop')
  async stopMining() {
    if (this.configService.getBenchmarkFlag()) {
      throw new BadRequestException('Cannot stop mining during benchmark mode');
    }
    await this.actionsService.stopMining();
    return { success: true, message: 'Mining stopped' };
  }
  
  /**
   * Manually start mining
   */
  @Post('start')
  async startMining() {
    if (this.configService.getBenchmarkFlag()) {
      throw new BadRequestException('Cannot start mining during benchmark mode');
    }
    await this.actionsService.startMining();
    return { success: true, message: 'Mining started' };
  }
}
