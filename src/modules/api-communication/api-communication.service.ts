import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { LoggingService } from '../logging/logging.service';
import * as dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class ApiCommunicationService {
  private readonly apiUrl: string;
  private readonly rigToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly loggingService: LoggingService
  ) {
    this.apiUrl = process.env.API_URL || 'http://localhost:3000';
    this.rigToken = process.env.RIG_TOKEN || '';
    this.loggingService.log('✅ API Communication Service initialized', 'INFO', 'api');
  }

  /** 📝 Get API URL */
  getApiUrl(): string {
    return this.apiUrl;
  }

  /** 📝 Registers the miner if not already registered */
  async registerMiner(metadata: any, minerIp: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.apiUrl}/api/miners/register`, {
          rigToken: this.rigToken,
          metadata,
          minerIp,
        }),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to register miner', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Fetch miner configuration (flight sheet, schedules, etc.) */
  async getMinerConfig(): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiUrl}/api/miners/config?rigToken=${this.rigToken}`),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to fetch miner configuration', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Update telemetry data */
  async updateTelemetry(minerId: string, telemetry: any): Promise<any> {
    try {
      // Log the request URL for debugging
      const url = `${this.apiUrl}/api/miners/update`;
      this.loggingService.log(`📡 Sending telemetry to: ${url}`, 'DEBUG', 'api');
  
      const response = await firstValueFrom(
        this.httpService.put(url, {
          rigToken: this.rigToken,
          minerId,
          telemetry,
        })
      );
  
      if (response.status !== 200) {
        throw new Error(`API returned ${response.status}`);
      }
  
      this.loggingService.log('✅ Telemetry sent successfully', 'INFO', 'api');
      return response.data;
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to update telemetry: ${error.message}\nPayload: ${JSON.stringify(telemetry, null, 2)}`, 
        'ERROR', 
        'api'
      );
      throw new HttpException('Failed to update telemetry', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Fetch flightsheet (mining configuration) */
  async getFlightsheet(): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiUrl}/api/miners/flightsheet?rigToken=${this.rigToken}`),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to fetch flightsheet', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Log miner errors */
  async logMinerError(minerId: string, message: string, stack: string, additionalInfo?: any): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.apiUrl}/api/miners/error`, {
          minerId,
          message,
          stack,
          additionalInfo,
        }),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to log miner error', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Fetch pending miner actions */
  async getPendingMinerActions(minerId: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiUrl}/api/miners-actions/miner/${minerId}/pending`),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to fetch pending miner actions', HttpStatus.BAD_REQUEST);
    }
  }

  /** 📝 Update action status (IN_PROGRESS, COMPLETED, FAILED) */
  async updateMinerActionStatus(actionId: string, status: string, error?: string): Promise<any> {
    try {
      const requestBody: any = { status };
      if (error) requestBody.error = error;

      const response = await firstValueFrom(
        this.httpService.put(`${this.apiUrl}/api/miners-actions/${actionId}/complete`, requestBody),
      );
      return response.data;
    } catch (error) {
      throw new HttpException('Failed to update miner action status', HttpStatus.BAD_REQUEST);
    }
  }
}
