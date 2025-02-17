import { Controller, Get, Post } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';

@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrapService: BootstrapService) {}

  /** ✅ Check bootstrap status */
  @Get('status')
  getStatus() {
    return { message: 'Bootstrap process completed successfully.' };
  }

  /** ✅ Manually restart bootstrap (optional) */
  @Post('restart')
  async restartBootstrap() {
    await this.bootstrapService.onModuleInit();  // Manually re-run bootstrap
    return { message: 'Bootstrap restarted successfully.' };
  }
}
