import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { ConfigService } from './config.service';
import { LoggingModule } from '../logging/logging.module';
import { HttpModule } from '@nestjs/axios';

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
    NestConfigModule.forRoot(), 
    forwardRef(() => LoggingModule),
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
      httpAgent,
      httpsAgent,
    })
  ],
  providers: [ConfigService],
  exports: [ConfigService]
})
export class ConfigModule {}