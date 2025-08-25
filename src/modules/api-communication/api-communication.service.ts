import {
  Injectable,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import { LoggingService } from '../logging/logging.service';
import * as dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class ApiCommunicationService {
  private readonly apiUrl: string;
  private readonly rigToken: string;

  constructor(
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => LoggingService))
    private readonly loggingService: LoggingService,
  ) {
    this.apiUrl = process.env.API_URL || 'https://api.refurbminer.de';
    this.rigToken = process.env.RIG_TOKEN || '';
    this.loggingService.log(
      `✅ API Communication Service initialized with URL: ${this.apiUrl}`,
      'INFO',
      'api',
    );
  }

  /** 📝 Get API URL */
  getApiUrl(): string {
    return this.apiUrl;
  }

  /** 📝 Registers the miner if not already registered */
  async registerMiner(metadata: any, minerIp: string): Promise<any> {
    try {
      this.loggingService.log(
        `Registering miner with IP: ${minerIp}`,
        'INFO',
        'api',
      );
      const url = `${this.apiUrl}/api/miners/register`;
      this.loggingService.log(
        `📡 Sending registration to: ${url}`,
        'DEBUG',
        'api',
      );

      // Add timeout protection to prevent hanging
      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.post(
            url,
            {
              rigToken: this.rigToken,
              metadata,
              minerIp,
            },
            {
              timeout: 30000, // 30 second timeout for registration
            },
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Registration timeout after 30 seconds')),
            30000,
          ),
        ),
      ])) as any;

      if (!response.data || !response.data.minerId) {
        this.loggingService.log(
          '⚠️ API registration response missing minerId',
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `✅ Miner registered successfully with ID: ${response.data.minerId}`,
          'INFO',
          'api',
        );
      }

      return response.data;
    } catch (error) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Registration timed out after 30 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Registration failed: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      throw new HttpException(
        'Failed to register miner',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** 📝 Fetch miner configuration (flight sheet, schedules, etc.) */
  async getMinerConfig(): Promise<any> {
    try {
      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.get(
            `${this.apiUrl}/api/miners/config?rigToken=${this.rigToken}`,
            {
              timeout: 15000,
            },
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Config fetch timeout after 15 seconds')),
            15000,
          ),
        ),
      ])) as any;

      return response.data;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Config fetch timed out after 15 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to fetch miner configuration: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      throw new HttpException(
        'Failed to fetch miner configuration',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** 📝 Update telemetry data */
  async updateTelemetry(minerId: string, telemetry: any): Promise<any> {
    try {
      // Log the request URL for debugging
      const url = `${this.apiUrl}/api/miners/update`;
      this.loggingService.log(
        `📡 Sending telemetry to: ${url}`,
        'DEBUG',
        'api',
      );

      // Add timeout protection to prevent hanging
      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.put(
            url,
            {
              rigToken: this.rigToken,
              minerId,
              telemetry,
            },
            {
              timeout: 15000, // 15 second timeout for telemetry
            },
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('Telemetry update timeout after 15 seconds')),
            15000,
          ),
        ),
      ])) as any; // Type assertion for Promise.race result

      if (response.status !== 200) {
        throw new Error(`API returned ${response.status}`);
      }

      // Success - let the calling service handle success logging
      return response.data;
    } catch (error) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Telemetry update timed out after 15 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to update telemetry: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      throw new HttpException(
        'Failed to update telemetry',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
  /** 📝 Fetch flightsheet (mining configuration) */
  async getFlightsheet(minerId?: string): Promise<any> {
    try {
      let url = `${this.apiUrl}/api/miners/flightsheet?rigToken=${this.rigToken}`;
      if (minerId) {
        url += `&minerId=${minerId}`;
      }

      const response = (await Promise.race([
        firstValueFrom(this.httpService.get(url)),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('Flightsheet fetch timeout after 15 seconds')),
            15000,
          ),
        ),
      ])) as any;

      return response.data;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Flightsheet fetch timed out after 15 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to fetch flightsheet: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      throw new HttpException(
        'Failed to fetch flightsheet',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** 📝 Log miner errors */
  async logMinerError(
    minerId: string,
    message: string,
    stack: string,
    additionalInfo?: any,
  ): Promise<any> {
    try {
      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.post(`${this.apiUrl}/api/miners/error`, {
            minerId,
            message,
            stack,
            additionalInfo,
          }),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Error logging timeout after 10 seconds')),
            10000,
          ),
        ),
      ])) as any;

      return response.data;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Error logging timed out after 10 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to log miner error: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      throw new HttpException(
        'Failed to log miner error',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** 📝 Fetch pending miner actions */
  async getPendingMinerActions(minerId: string): Promise<any> {
    try {
      const rigToken = this.getRigToken();
      if (!rigToken) {
        this.loggingService.log(
          '❌ Cannot fetch actions: No rig token found',
          'ERROR',
          'api',
        );
        return [];
      }

      const url = `${this.apiUrl}/miners-actions/miner/${minerId}/pending`;
      this.loggingService.log(
        `📡 Fetching pending actions from: ${url}`,
        'DEBUG',
        'api',
      );

      // Add timeout protection to prevent hanging
      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.get(url, {
            headers: {
              'rig-token': rigToken,
            },
            timeout: 10000, // 10 second timeout
          }),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('API request timeout after 10 seconds')),
            10000,
          ),
        ),
      ])) as any; // Type assertion for Promise.race result

      if (!response.data) {
        return [];
      }

      return response.data;
    } catch (error) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ API request timed out after 10 seconds for actions check`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to fetch pending actions: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      return [];
    }
  }

  /** 📝 Update action status (IN_PROGRESS, COMPLETED, FAILED) */
  async updateMinerActionStatus(
    actionId: string,
    status: string,
    error?: string,
  ): Promise<any> {
    try {
      const rigToken = this.getRigToken();
      if (!rigToken) {
        this.loggingService.log(
          '❌ Cannot update action status: No rig token found',
          'ERROR',
          'api',
        );
        return null;
      }

      const url = `${this.apiUrl}/miners-actions/${actionId}/complete`;
      this.loggingService.log(
        `📡 Updating action status at: ${url}`,
        'DEBUG',
        'api',
      );

      const response = (await Promise.race([
        firstValueFrom(
          this.httpService.put(
            url,
            { status, error },
            {
              headers: {
                'rig-token': rigToken,
              },
            },
          ),
        ),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('Action status update timeout after 10 seconds'),
              ),
            10000,
          ),
        ),
      ])) as any;

      return response.data;
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Action status update timed out after 10 seconds`,
          'WARN',
          'api',
        );
      } else {
        this.loggingService.log(
          `❌ Failed to update action status: ${error.message}`,
          'ERROR',
          'api',
        );
      }
      return null;
    }
  }

  /** 📝 Get rig token for authentication */
  private getRigToken(): string | null {
    try {
      // First try from environment variable
      if (process.env.RIG_TOKEN) {
        return process.env.RIG_TOKEN;
      }

      // Try reading from a config file as fallback
      if (fs.existsSync('config/rig-token.txt')) {
        return fs.readFileSync('config/rig-token.txt', 'utf8').trim();
      }

      this.loggingService.log(
        '⚠️ No rig token found in env or config file',
        'WARN',
        'api',
      );
      return null;
    } catch (error) {
      this.loggingService.log(
        `❌ Error reading rig token: ${error.message}`,
        'ERROR',
        'api',
      );
      return null;
    }
  }
}
