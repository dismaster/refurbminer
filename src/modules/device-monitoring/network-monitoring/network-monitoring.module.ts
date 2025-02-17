import { Module } from '@nestjs/common';
import { NetworkMonitoringService } from './network-monitoring.service';
import { NetworkMonitoringController } from './network-monitoring.controller';
import { OsDetectionModule } from '../os-detection/os-detection.module';
import { ApiCommunicationModule } from '../../api-communication/api-communication.module';
import { LoggingModule } from '../../logging/logging.module';

@Module({
  imports: [OsDetectionModule, ApiCommunicationModule, LoggingModule],
  providers: [NetworkMonitoringService],
  controllers: [NetworkMonitoringController],
  exports: [NetworkMonitoringService],
})
export class NetworkMonitoringModule {}