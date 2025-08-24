import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { LoggingModule } from '../logging/logging.module';
import { ApiCommunicationService } from './api-communication.service';
import { ApiCommunicationController } from './api-communication.controller';

// Create HTTP agents with proper connection pooling
const httpAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 30000,
});

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 30000,
});

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
      httpAgent,
      httpsAgent,
    }),
    forwardRef(() => LoggingModule),
  ],
  providers: [ApiCommunicationService],
  controllers: [ApiCommunicationController],
  exports: [ApiCommunicationService],
})
export class ApiCommunicationModule {}