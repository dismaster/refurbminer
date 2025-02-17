import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { BootstrapController } from './bootstrap.controller';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { DeviceMonitoringModule } from '../device-monitoring/device-monitoring.module';
import { MinerManagerModule } from '../miner-manager/miner-manager.module';
import { FlightsheetModule } from '../flightsheet/flightsheet.module';

@Module({
  imports: [
    LoggingModule,
    ApiCommunicationModule,
    DeviceMonitoringModule,
    MinerManagerModule,
    FlightsheetModule,
  ],
  providers: [BootstrapService],
  controllers: [BootstrapController],
  exports: [BootstrapService],
})
export class BootstrapModule {}
