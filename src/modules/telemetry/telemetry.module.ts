import { Module } from '@nestjs/common';
//import { TelemetryService } from './telemetry.service';
import { EnhancedTelemetryService } from './enhanced-telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { LoggingModule } from '../logging/logging.module';
import { ConfigModule } from '../config/config.module';
import { FlightsheetModule } from '../flightsheet/flightsheet.module';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { MinerManagerModule } from '../miner-manager/miner-manager.module';
import { OsDetectionModule } from '../device-monitoring/os-detection/os-detection.module';

// Utils imports
import { HardwareInfoUtil } from './utils/hardware/hardware-info.util';
import { NetworkInfoUtil } from './utils/network-info.util';
import { BatteryInfoUtil } from './utils/battery-info.util';
import { MinerSummaryUtil } from './utils/miner/miner-summary.util';
import { MinerPoolUtil } from './utils/miner/miner-pool.util';
import { MinerThreadsUtil } from './utils/miner/miner-threads.util';
import { MemoryInfoUtil } from './utils/hardware/memory-info.util';
import { StorageInfoUtil } from './utils/hardware/storage-info.util';

@Module({
  imports: [
    LoggingModule,
    ConfigModule,
    FlightsheetModule,
    ApiCommunicationModule,
    MinerManagerModule,
    OsDetectionModule
  ],
  controllers: [TelemetryController],
  providers: [
    //TelemetryService,
    EnhancedTelemetryService,
    HardwareInfoUtil,
    NetworkInfoUtil,
    BatteryInfoUtil,
    MinerSummaryUtil,
    MinerPoolUtil,
    MinerThreadsUtil,
    MemoryInfoUtil,
    StorageInfoUtil
  ],
  //exports: [TelemetryService]
  exports: [EnhancedTelemetryService]
})
export class TelemetryModule {}