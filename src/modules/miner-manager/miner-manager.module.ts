import { Module } from '@nestjs/common';
import { MinerManagerService } from './miner-manager.service';
import { MinerManagerController } from './miner-manager.controller';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { FlightsheetModule } from '../flightsheet/flightsheet.module';
import { ConfigModule } from '../config/config.module';
import { MinerSoftwareModule } from '../miner-software/miner-software.module';

@Module({
  imports: [
    LoggingModule,
    ApiCommunicationModule,
    FlightsheetModule,
    ConfigModule,
    MinerSoftwareModule,
  ],
  providers: [MinerManagerService],
  controllers: [MinerManagerController],
  exports: [MinerManagerService],
})
export class MinerManagerModule {}
