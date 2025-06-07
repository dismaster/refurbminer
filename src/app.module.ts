import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { join } from 'path';
import { LoggingModule } from './modules/logging/logging.module';
import { LoggingService } from './modules/logging/logging.service';
import { ApiCommunicationModule } from './modules/api-communication/api-communication.module';
import { BootstrapModule } from './modules/bootstrap/bootstrap.module';
import { MinerManagerModule } from './modules/miner-manager/miner-manager.module';
import { MinerSoftwareModule } from './modules/miner-software/miner-software.module';
import { DeviceMonitoringModule } from './modules/device-monitoring/device-monitoring.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { FlightsheetModule } from './modules/flightsheet/flightsheet.module';
import { ActionsModule } from './modules/actions/actions.module';
import { MinerDataModule } from './modules/miner-data/miner-data.module';
import { ConfigModule } from './modules/config/config.module';
import { NetworkMonitoringModule } from './modules/device-monitoring/network-monitoring/network-monitoring.module';
import { WebModule } from './modules/web/web.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [    
    // Core modules
    LoggingModule,
    ApiCommunicationModule,

    // Feature modules
    BootstrapModule,
    MinerManagerModule,
    MinerSoftwareModule,
    DeviceMonitoringModule,
    NetworkMonitoringModule,
    TelemetryModule,
    FlightsheetModule,    ActionsModule,
    MinerDataModule,
    ConfigModule,

    // Web interface
    WebModule,
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'dist', 'public'),
      serveRoot: '/',
      exclude: ['/api*'], // Exclude API routes from static serving
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly loggingService: LoggingService) {}
  
  onModuleDestroy() {
    this.loggingService.log('💤 Application shutting down, cleaning up resources', 'INFO', 'app');
    // Any additional global cleanup can be added here
  }

  async onModuleInit() {
    this.loggingService.log('🚀 Application startup', 'INFO', 'app');
    
    try {
      // Log system info
      const nodeVersion = process.version;
      const platform = process.platform;
      const arch = process.arch;
      const memory = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);

      this.loggingService.log(
        `📊 System Info:
         Node Version: ${nodeVersion}
         Platform: ${platform}
         Architecture: ${arch}
         Memory: ${memory}MB`,
        'INFO',
        'app'
      );

      // Log module initialization
      this.loggingService.log('✅ All modules initialized successfully', 'INFO', 'app');
    } catch (error) {
      this.loggingService.log(
        `❌ Error during application initialization: ${error.message}`,
        'ERROR',
        'app'
      );
      throw error;
    }
  }
}