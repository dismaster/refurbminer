import { Module } from '@nestjs/common';
import { MinerDataService } from './miner-data.service';
import { MinerDataController } from './miner-data.controller';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { LoggingModule } from '../logging/logging.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    TelemetryModule,
    ApiCommunicationModule,
    LoggingModule,
    ConfigModule
  ],
  controllers: [MinerDataController],
  providers: [MinerDataService],
  exports: [MinerDataService]
})
export class MinerDataModule {
  constructor() {
    console.log('🚀 MinerDataModule initialized');
  }
}