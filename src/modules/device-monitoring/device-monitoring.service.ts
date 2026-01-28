import { Injectable } from '@nestjs/common';
import { OsDetectionService } from '../device-monitoring/os-detection/os-detection.service';

@Injectable()
export class DeviceMonitoringService {
  constructor(private readonly osDetectionService: OsDetectionService) {}

  /** 📝 Returns OS type */
  getOS(): string {
    return this.osDetectionService.detectOS();
  }

  /** 📝 Returns hardware and OS metadata */
  async getSystemInfo(): Promise<any> {
    return this.osDetectionService.getSystemInfo();
  }

  /** 📝 Returns device IP Address */
  async getIPAddress(): Promise<string> {
    return this.osDetectionService.getIPAddress();
  }
}
