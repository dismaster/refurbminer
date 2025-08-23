import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationService } from './api-communication.service';
import { ApiCommunicationController } from './api-communication.controller';

@Module({
  imports: [
    HttpModule,
    forwardRef(() => LoggingModule)
  ],
  providers: [ApiCommunicationService],
  controllers: [ApiCommunicationController],
  exports: [ApiCommunicationService],
})
export class ApiCommunicationModule {}