import { Module } from '@nestjs/common';
import { MinerSoftwareService } from './miner-software.service';
import { MinerSoftwareController } from './miner-software.controller';
import { LoggingModule } from '../logging/logging.module';
import { DeviceMonitoringModule } from '../device-monitoring/device-monitoring.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [LoggingModule, DeviceMonitoringModule, ConfigModule],
  providers: [MinerSoftwareService],
  controllers: [MinerSoftwareController],
  exports: [MinerSoftwareService],
})
export class MinerSoftwareModule {}
