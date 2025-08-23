import { Module } from '@nestjs/common';
import { ProcessMonitorService } from './process-monitor.service';
import { LoggingModule } from '../logging/logging.module';

@Module({
  imports: [LoggingModule],
  providers: [ProcessMonitorService],
  exports: [ProcessMonitorService],
})
export class MonitoringModule {}
