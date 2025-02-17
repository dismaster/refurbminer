import { Module } from '@nestjs/common';
import { DeviceMonitoringService } from './device-monitoring.service';
import { OsDetectionModule } from './os-detection/os-detection.module';

@Module({
  imports: [OsDetectionModule],
  providers: [DeviceMonitoringService],
  exports: [DeviceMonitoringService],
})
export class DeviceMonitoringModule {}
