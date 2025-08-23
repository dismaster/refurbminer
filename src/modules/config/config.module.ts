import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigService } from './config.service';
import { LoggingModule } from '../logging/logging.module';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    NestConfigModule.forRoot(), 
    forwardRef(() => LoggingModule),
    HttpModule
  ],
  providers: [ConfigService],
  exports: [ConfigService]
})
export class ConfigModule {
  constructor() {
    console.log('🚀 ConfigModule initialized');
  }
}