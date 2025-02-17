import { Module } from '@nestjs/common';
import { FlightsheetService } from './flightsheet.service';
import { FlightsheetController } from './flightsheet.controller';
import { ApiCommunicationModule } from '../api-communication/api-communication.module';
import { LoggingModule } from '../logging/logging.module';

@Module({
  imports: [ApiCommunicationModule, LoggingModule],
  providers: [FlightsheetService],
  controllers: [FlightsheetController],
  exports: [FlightsheetService],
})
export class FlightsheetModule {}
