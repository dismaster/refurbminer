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
  getSystemInfo(): any {
    return this.osDetectionService.getSystemInfo();
  }

  /** 📝 Returns device IP Address */
  getIPAddress(): string {
    return this.osDetectionService.getIPAddress();
  }
}
