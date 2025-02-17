import { Module } from '@nestjs/common';
import { WebController } from './web.controller';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    TelemetryModule,
    ConfigModule
  ],
  controllers: [WebController],
})
export class WebModule {}