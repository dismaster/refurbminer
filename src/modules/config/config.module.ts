import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigService } from './config.service';
import { LoggingModule } from '../logging/logging.module';

@Module({
  imports: [NestConfigModule.forRoot(), LoggingModule],
  providers: [ConfigService],
  exports: [ConfigService]
})
export class ConfigModule {
  constructor() {
    console.log('🚀 ConfigModule initialized');
  }
}