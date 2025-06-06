import { Module } from '@nestjs/common';
import { ActionsService } from './actions.service';
import { ActionsController } from './actions.controller';
import { ConfigModule } from '../config/config.module';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { MinerManagerModule } from '../miner-manager/miner-manager.module';
import { OsDetectionModule } from '../device-monitoring/os-detection/os-detection.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ApiCommunicationModule,
    MinerManagerModule,
    OsDetectionModule,
  ],
  providers: [ActionsService],
  controllers: [ActionsController],
  exports: [ActionsService],
})
export class ActionsModule {}
