import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FlightsheetService {
  private flightsheetDir = 'apps';

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly configService: ConfigService
  ) {}
  async updateFlightsheet(): Promise<boolean> {
    try {
      this.loggingService.log('📡 Fetching flightsheet from API...', 'INFO', 'flightsheet');
      
      const minerId = this.configService.getMinerId();
      if (!minerId) {
        this.loggingService.log('❌ Cannot fetch flightsheet: No minerId found', 'ERROR', 'flightsheet');
        return false;
      }
      
      const flightsheet = await this.apiService.getFlightsheet(minerId);

      if (!flightsheet || !flightsheet.minerSoftware) {
        this.loggingService.log('❌ Invalid flightsheet received.', 'ERROR', 'flightsheet');
        return false;
      }

      const miner = flightsheet.minerSoftware;
      const minerConfigPath = path.join(this.flightsheetDir, miner, 'config.json');

      if (!fs.existsSync(path.dirname(minerConfigPath))) {
        fs.mkdirSync(path.dirname(minerConfigPath), { recursive: true });
      }

      if (!this.hasFlightsheetChanged(minerConfigPath, flightsheet)) {
        this.loggingService.log(`⚡ Flightsheet unchanged. Skipping update.`, 'INFO', 'flightsheet');
        return false;
      }

      fs.writeFileSync(minerConfigPath, JSON.stringify(flightsheet, null, 2));
      this.loggingService.log(`✅ Flightsheet updated: ${minerConfigPath}`, 'INFO', 'flightsheet');

      return true;
    } catch (error) {
      this.loggingService.log(`❌ Failed to update flightsheet: ${error.message}`, 'ERROR', 'flightsheet');
      return false;
    }
  }

  private hasFlightsheetChanged(filePath: string, newFlightsheet: any): boolean {
    if (!fs.existsSync(filePath)) return true;

    try {
      const currentFlightsheet = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return JSON.stringify(currentFlightsheet) !== JSON.stringify(newFlightsheet);
    } catch (error) {
      this.loggingService.log(`⚠️ Error reading flightsheet file: ${error.message}`, 'WARN', 'flightsheet');
      return true;
    }
  }

  getFlightsheet(miner: string): any {
    try {
      const minerConfigPath = path.join(this.flightsheetDir, miner, 'config.json');

      if (!fs.existsSync(minerConfigPath)) {
        this.loggingService.log(`🚨 No flightsheet found for miner: ${miner} at ${minerConfigPath}`, 'WARN', 'flightsheet');
        return null;
      }

      const flightsheet = JSON.parse(fs.readFileSync(minerConfigPath, 'utf8'));
      return flightsheet;
    } catch (error) {
      this.loggingService.log(`❌ Failed to retrieve flightsheet: ${error.message}`, 'ERROR', 'flightsheet');
      return null;
    }
  }
}
