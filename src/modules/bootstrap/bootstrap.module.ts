import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { BootstrapController } from './bootstrap.controller';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { DeviceMonitoringModule } from '../device-monitoring/device-monitoring.module';
import { MinerManagerModule } from '../miner-manager/miner-manager.module';
import { FlightsheetModule } from '../flightsheet/flightsheet.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    LoggingModule,
    ApiCommunicationModule,
    DeviceMonitoringModule,
    MinerManagerModule,
    FlightsheetModule,
    ConfigModule,
  ],
  providers: [BootstrapService],
  controllers: [BootstrapController],
  exports: [BootstrapService],
})
export class BootstrapModule {}
