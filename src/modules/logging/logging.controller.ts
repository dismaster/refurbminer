import { Controller, Get, Query } from '@nestjs/common';
import { LoggingService } from './logging.service';

@Controller('logs')
export class LoggingController {
  constructor(private readonly loggingService: LoggingService) {}

  @Get()
  getLogs(@Query('limit') limit?: number): string[] {
    return this.loggingService.getLogs(limit ? Number(limit) : 50);
  }
}
