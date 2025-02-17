import { Module } from '@nestjs/common';
import { OsDetectionService } from './os-detection.service';
import { LoggingModule } from '../../logging/logging.module';  // Import LoggingModule

@Module({
  imports: [LoggingModule],  // Import LoggingModule to access LoggingService
  providers: [OsDetectionService],
  exports: [OsDetectionService],
})
export class OsDetectionModule {}
