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

    // Check for WiFi connected but no SSID issue on Termux
    if (osType === 'termux' && this.isWiFiEnabledButNotConnected()) {
      this.loggingService.log(
        '⚠️ WiFi enabled but not connected to any network',
        'WARN',
        'network-monitoring'
      );
      this.reconnectToConfiguredNetworks();
      
      // Wait a bit for reconnection to complete before continuing with other checks
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    
    // Continue with existing connectivity checks
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

  /** ✅ Check if WiFi is enabled but not connected to any network */
  private isWiFiEnabledButNotConnected(): boolean {
    try {
      // Try termux-wifi-connectioninfo first (doesn't require root)
      try {
        const connectionInfo = execSync('termux-wifi-connectioninfo', { encoding: 'utf8' });
        const info = JSON.parse(connectionInfo);
        const wifiInfo = info as { ssid?: string };
        
        // WiFi is likely enabled since termux-wifi-connectioninfo worked
        // But if SSID is empty, we're not connected to a network
        if (wifiInfo && typeof wifiInfo === 'object' && 'ssid' in wifiInfo) {
          return !wifiInfo.ssid || wifiInfo.ssid.trim() === '';
        }
      } catch (termuxError: any) {
        this.loggingService.log(
          `⚠️ termux-wifi-connectioninfo failed: ${termuxError.message}`,
          'DEBUG',
          'network-monitoring',
        );
      }
      
      // Fallback: Check if we have a WiFi interface but no route to the internet
      try {
        // Check if wlan0 interface exists and is up
        const ipAddr = execSync('ip addr show wlan0', { encoding: 'utf8', timeout: 3000 });
        const isUp = ipAddr.includes('state UP');
        
        // If interface is up but we can't ping anything, WiFi is likely on but not connected
        if (isUp) {
          // Try pinging a reliable target
          try {
            execSync('ping -c 1 -W 2 8.8.8.8', { encoding: 'utf8', timeout: 3000 });
            return false; // We can ping, so we are connected
          } catch {
            return true; // We can't ping, which suggests WiFi is on but not connected
          }
        }
      } catch {
        // wlan0 interface check failed, can't determine
      }
      
      // One more fallback - check if NetworkManager shows WiFi is enabled but disconnected
      try {
        const nmcli = execSync('nmcli radio wifi', { encoding: 'utf8', timeout: 3000 }).trim();
        if (nmcli === 'enabled') {
          // WiFi is enabled, now check if we're connected
          try {
            const connections = execSync('nmcli -t -f NAME,DEVICE,STATE c show --active', { encoding: 'utf8', timeout: 3000 });
            return !connections.includes('wlan'); // No active wlan connections
          } catch {
            // Can't check connections
          }
        }
      } catch {
        // nmcli check failed
      }
      
      return false; // Default to false if we couldn't determine state
    } catch (error: any) {
      this.loggingService.log(`⚠️ Error checking WiFi state: ${error.message}`, 'DEBUG', 'network-monitoring');
      return false;
    }
  }

  /** ✅ Attempt to reconnect to configured networks - no root version */
  private reconnectToConfiguredNetworks(): void {
    try {
      this.loggingService.log('🔄 Attempting to reconnect to WiFi...', 'INFO', 'network-monitoring');
      
      // Method 1: Force WiFi reconnection via cycling (requires termux-api but not root)
      try {
        execSync('termux-wifi-enable false', { encoding: 'utf8', timeout: 5000 });
        execSync('sleep 3', { encoding: 'utf8' });
        execSync('termux-wifi-enable true', { encoding: 'utf8', timeout: 5000 });
        this.loggingService.log('🔄 Cycled WiFi to trigger reconnection', 'INFO', 'network-monitoring');
        
        // Wait a bit for Android to reconnect automatically
        execSync('sleep 5', { encoding: 'utf8' });
      } catch (cycleError: any) {
        this.loggingService.log(`⚠️ WiFi cycling failed: ${cycleError.message}`, 'DEBUG', 'network-monitoring');
      }
      
      // Method 2: Scan for networks to trigger auto-reconnect
      try {
        execSync('termux-wifi-scaninfo', { encoding: 'utf8', timeout: 10000 });
        this.loggingService.log('🔍 Triggered WiFi scan to prompt reconnection', 'INFO', 'network-monitoring');
        
        // Wait a bit more
        execSync('sleep 3', { encoding: 'utf8' });
      } catch (scanError: any) {
        this.loggingService.log(`⚠️ WiFi scan failed: ${scanError.message}`, 'DEBUG', 'network-monitoring');
      }
      
      // Method 3: If we have root, use more direct approaches
      if (this.isRootAvailable()) {
        this.reconnectUsingRoot();
      } else {
        // Method 4: If no root, try using Android intent to open WiFi settings
        try {
          // This will open the WiFi settings page which often triggers reconnection
          execSync('am start -n com.android.settings/.wifi.WifiSettings', { encoding: 'utf8', timeout: 3000 });
          this.loggingService.log('📱 Opened WiFi settings to prompt reconnection', 'INFO', 'network-monitoring');
        } catch (amError) {
          try {
            // Alternative intent
            execSync('am start -a android.settings.WIFI_SETTINGS', { encoding: 'utf8', timeout: 3000 });
            this.loggingService.log('📱 Opened WiFi settings (alt method)', 'INFO', 'network-monitoring');
          } catch {
            this.loggingService.log('⚠️ Cannot open WiFi settings', 'WARN', 'network-monitoring');
          }
        }
      }
      
      // Final check if we're reconnected
      try {
        const connectionInfo = execSync('termux-wifi-connectioninfo', { encoding: 'utf8', timeout: 5000 });
        const info = JSON.parse(connectionInfo);
        
        if (info.ssid && info.ssid.trim() !== '') {
          this.loggingService.log(`✅ Successfully connected to: ${info.ssid}`, 'INFO', 'network-monitoring');
        } else {
          this.loggingService.log('⚠️ WiFi still not connected to a network', 'WARN', 'network-monitoring');
        }
      } catch {
        // Can't check final state
      }
    } catch (error: any) {
      this.loggingService.log(`❌ Error reconnecting to WiFi: ${error.message}`, 'ERROR', 'network-monitoring');
    }
  }

  /** ✅ Root-based WiFi reconnection methods */
  private reconnectUsingRoot(): void {
    try {
      this.loggingService.log('🔑 Attempting reconnection with root privileges', 'INFO', 'network-monitoring');
      
      // Force WiFi reconnect via Android framework
      try {
        execSync('su -c "svc wifi disable"', { encoding: 'utf8', timeout: 3000 });
        execSync('sleep 2', { encoding: 'utf8' });
        execSync('su -c "svc wifi enable"', { encoding: 'utf8', timeout: 3000 });
        this.loggingService.log('✅ Cycled WiFi using root privileges', 'INFO', 'network-monitoring');
      } catch {
        // Continue to next method if this fails
      }
      
      // Try to force Android to scan for networks
      try {
        execSync('su -c "cmd wifi force-scan"', { encoding: 'utf8', timeout: 3000 });
        this.loggingService.log('✅ Forced WiFi scan using root privileges', 'INFO', 'network-monitoring');
      } catch {
        // Continue if this fails
      }
      
      // Try to connect to saved networks using wpa_cli if available
      try {
        execSync('su -c "wpa_cli reconfigure"', { encoding: 'utf8', timeout: 3000 });
        this.loggingService.log('✅ Reconfigured wpa_supplicant', 'INFO', 'network-monitoring');
      } catch {
        // Continue if this fails
      }
    } catch (error: any) {
      this.loggingService.log(`⚠️ Root reconnection attempts failed: ${error.message}`, 'WARN', 'network-monitoring');
    }
  }

  /** ✅ Check if root is available */
  private isRootAvailable(): boolean {
    try {
      execSync('su -c "echo test"', { encoding: 'utf8', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}