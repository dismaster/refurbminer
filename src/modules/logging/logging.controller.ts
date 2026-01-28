import { Controller, Get, Query } from '@nestjs/common';
import { LoggingService } from './logging.service';

@Controller('logs')
export class LoggingController {
  constructor(private readonly loggingService: LoggingService) {}

  @Get()
  async getLogs(@Query('limit') limit?: number): Promise<string[]> {
    return await this.loggingService.getLogs(limit ? Number(limit) : 50);
  }
}
