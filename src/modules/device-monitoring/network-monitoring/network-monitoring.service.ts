import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { execSync } from 'child_process';
import { OsDetectionService } from '../os-detection/os-detection.service';
import { ApiCommunicationService } from '../../api-communication/api-communication.service';
import { LoggingService } from '../../logging/logging.service';
import * as fs from 'fs';

@Injectable()
export class NetworkMonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly pingTargets = [
    'google.com',
    '8.8.8.8',
    'cloudflare.com',
    '1.1.1.1',
    'bing.com',
    '208.67.222.222'
  ];
  private wasDisconnected = false;
  private networkMonitoringInterval?: NodeJS.Timeout;
  private retryCount = 0;
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly osDetectionService: OsDetectionService,
    private readonly apiService: ApiCommunicationService,
    private readonly loggingService: LoggingService
  ) {}

  /** 📝 Initialize network monitoring */
  async onModuleInit() {
    this.loggingService.log('🌐 Initializing network monitoring service...', 'INFO', 'network-monitoring');
    try {
      const isConnected = this.checkNetworkConnectivity();
      this.loggingService.log(
        `📡 Initial network status: ${isConnected ? 'Connected' : 'Disconnected'}`,
        'INFO',
        'network-monitoring'
      );
      this.startNetworkMonitoring();
      this.loggingService.log('✅ Network monitoring started successfully', 'INFO', 'network-monitoring');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to initialize network monitoring: ${error.message}`,
        'ERROR',
        'network-monitoring'
      );
    }
  }

  /** 📝 Check network connectivity */
  checkNetworkConnectivity(): boolean {
    const osType = this.osDetectionService.detectOS();
    const pingCommand = osType === 'termux' ? 'ping -c 1 -W 2' : 'ping -c 1 -w 2';

    for (const target of this.pingTargets) {
      try {
        const result = execSync(`${pingCommand} ${target}`, { encoding: 'utf8' });
        if (result.includes('1 received')) {
          this.retryCount = 0;
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  /** 📝 Check DNS resolution */
  checkDNSResolution(): boolean {
    try {
      const result = execSync('nslookup google.com', { encoding: 'utf8' });
      return result.includes('Address');
    } catch {
      return false;
    }
  }

  /** 📝 Check WiFi signal strength (Termux only) */
  checkWiFiSignalStrength(): string {
    try {
      const result = execSync('termux-wifi-connectioninfo', { encoding: 'utf8' });
      const info = JSON.parse(result);
      return `📶 WiFi Signal: ${info.rssi} dBm`;
    } catch {
      return 'WiFi info unavailable';
    }
  }

  /** 📝 Monitor network connectivity */
  private async checkAndHandleConnectivity(): Promise<void> {
    const osType = this.osDetectionService.detectOS();
    let connectivityLost = false;
    let dnsResolutionFailed = false;

    if (!this.checkNetworkConnectivity()) {
      connectivityLost = true;
      this.retryCount++;
      
      this.loggingService.log(
        `⚠️ Network connectivity lost (Attempt ${this.retryCount}/${this.MAX_RETRIES})`, 
        'WARN', 
        'network-monitoring'
      );

      if (this.retryCount >= this.MAX_RETRIES) {
        await this.performRecoveryActions(osType);
      }
    }

    if (!connectivityLost && !this.checkDNSResolution()) {
      dnsResolutionFailed = true;
      this.loggingService.log('⚠️ DNS resolution failed', 'WARN', 'network-monitoring');
    }

    if (osType === 'termux') {
      const wifiSignal = this.checkWiFiSignalStrength();
      this.loggingService.log(wifiSignal, 'INFO', 'network-monitoring');
    }

    if (connectivityLost || dnsResolutionFailed) {
      this.wasDisconnected = true;
    } else if (this.wasDisconnected) {
      this.loggingService.log('✅ Network connectivity restored', 'INFO', 'network-monitoring');
      this.wasDisconnected = false;
      this.retryCount = 0;
      await this.logNetworkRestored();
    }
  }

  /** 📝 Start network monitoring */
  private startNetworkMonitoring(): void {
    if (this.networkMonitoringInterval) {
      clearInterval(this.networkMonitoringInterval);
    }
    this.networkMonitoringInterval = setInterval(() => {
      this.checkAndHandleConnectivity();
    }, 30000); // Check every minute
  }

  /** 📝 Perform recovery actions */
  private async performRecoveryActions(osType: string): Promise<void> {
    try {
      this.enableDisplay();
      this.restartNetworkInterface();

      if (osType === 'termux') {
        await new Promise(resolve => setTimeout(resolve, 5000));
        execSync('termux-wifi-scaninfo', { encoding: 'utf8' });
      }

      this.loggingService.log('✅ Recovery actions completed', 'INFO', 'network-monitoring');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to perform recovery actions: ${error.message}`, 
        'ERROR', 
        'network-monitoring'
      );
    }
  }

  /** 📝 Enable display and wake locks */
  private enableDisplay(): void {
    const osType = this.osDetectionService.detectOS();
    try {
      if (osType === 'termux') {
        // First try Termux API approach
        try {
          execSync('termux-wake-lock');
          execSync('termux-brightness 255'); // Set max brightness
        } catch (termuxError) {
          this.loggingService.log(
            `ℹ️ Termux API wake lock failed: ${termuxError.message}`, 
            'INFO', 
            'network-monitoring'
          );
        }
  
        // Check if ADB is available and try ADB approach
        try {
          const adbAvailable = this.checkAdbAvailability();
          if (adbAvailable) {
            execSync('adb shell input keyevent KEYCODE_POWER');
            execSync('adb shell svc power stayon true');
            this.loggingService.log('✅ Display enabled via ADB', 'INFO', 'network-monitoring');
          }
        } catch (adbError) {
          this.loggingService.log(
            `ℹ️ ADB wake lock failed: ${adbError.message}`, 
            'INFO', 
            'network-monitoring'
          );
        }
  
        // Fallback to basic power management
        try {
          execSync('dumpsys deviceidle disable');
          execSync('dumpsys battery reset');
          execSync('dumpsys battery set status 2'); // Simulate charging
          this.loggingService.log('✅ Basic power management applied', 'INFO', 'network-monitoring');
        } catch (basicError) {
          this.loggingService.log(
            `ℹ️ Basic power management failed: ${basicError.message}`, 
            'INFO', 
            'network-monitoring'
          );
        }
  
      } else if (osType === 'raspberry-pi' || osType === 'linux') {
        execSync('xset dpms force on');
      }
      
      this.loggingService.log('✅ Display and wake locks enabled', 'INFO', 'network-monitoring');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to enable display/wake locks: ${error.message}`, 
        'ERROR', 
        'network-monitoring'
      );
    }
  }

  /** 📝 Check if ADB is available */
  private checkAdbAvailability(): boolean {
    try {
      execSync('adb devices', { encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  }

  /** 📝 Restart network interface */
  private restartNetworkInterface(): void {
    const osType = this.osDetectionService.detectOS();
    try {
      if (osType === 'termux') {
        execSync('termux-wifi-enable false');
        execSync('sleep 2');
        execSync('termux-wifi-enable true');
      } else if (osType === 'raspberry-pi' || osType === 'linux') {
        execSync('sudo systemctl restart networking');
      }
      this.loggingService.log('✅ Network interface restarted', 'INFO', 'network-monitoring');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to restart network interface: ${error.message}`, 
        'ERROR', 
        'network-monitoring'
      );
    }
  }

  /** 📝 Log network restored */
  private async logNetworkRestored(): Promise<void> {
    try {
      const config = JSON.parse(fs.readFileSync('config/config.json', 'utf8'));
      await this.apiService.logMinerError(
        config.minerId,
        'Network connectivity restored after being lost.',
        ''
      );
      this.loggingService.log('✅ Network restored event logged', 'INFO', 'network-monitoring');
    } catch (error) {
      this.loggingService.log(
        `❌ Failed to log network restored: ${error.message}`, 
        'ERROR', 
        'network-monitoring'
      );
    }
  }

  /** 📝 Cleanup on module destroy */
  onModuleDestroy() {
    if (this.networkMonitoringInterval) {
      clearInterval(this.networkMonitoringInterval);
    }
    this.loggingService.log('🛑 Network monitoring service stopped', 'INFO', 'network-monitoring');
  }

}