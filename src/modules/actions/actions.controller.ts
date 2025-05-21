import { Controller, Get, Post, Body } from '@nestjs/common';
import { ActionsService } from './actions.service';

@Controller('actions')
export class ActionsController {
  constructor(private readonly actionsService: ActionsService) {}

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
    await this.actionsService.stopMining();
    return { success: true, message: 'Mining stopped' };
  }
  
  /**
   * Manually start mining
   */
  @Post('start')
  async startMining() {
    await this.actionsService.startMining();
    return { success: true, message: 'Mining started' };
  }
}
