import { Module, forwardRef } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { LoggingController } from './logging.controller';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    forwardRef(() => ApiCommunicationModule),
    ConfigModule,
  ],
  providers: [LoggingService],
  exports: [LoggingService],
  controllers: [LoggingController],
})
export class LoggingModule {}
