import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class BatteryInfoUtil {
  private static batteryInfoCache: { data: any; timestamp: number } | null = null;
  private static readonly BATTERY_INFO_TTL = 30000; // 30 seconds

  private static async execCommand(command: string, timeout?: number): Promise<string> {
    const { stdout } = await execAsync(command, { encoding: 'utf8', timeout });
    return stdout ?? '';
  }
  /** ✅ Get battery details based on system type */
  static async getBatteryInfo(systemType: string): Promise<any> {
    const now = Date.now();
    if (
      this.batteryInfoCache &&
      now - this.batteryInfoCache.timestamp < this.BATTERY_INFO_TTL
    ) {
      return this.batteryInfoCache.data;
    }

    if (process.platform === 'win32') {
      const data = await this.getWindowsBatteryInfo();
      this.batteryInfoCache = { data, timestamp: Date.now() };
      return data;
    }

    const data = await (async () => {
      switch (systemType) {
        case 'termux':
          return this.getTermuxBatteryInfo();
        case 'raspberry-pi':
          return this.getRaspberryBatteryInfo();
        case 'linux':
          return this.getLinuxBatteryInfo();
        default:
          return this.getDefaultBatteryInfo();
      }
    })();

    this.batteryInfoCache = { data, timestamp: Date.now() };
    return data;
  }

  /** ✅ Get battery info on Windows via WMI (if available) */
  private static async getWindowsBatteryInfo() {
    try {
      const result = (await this.execCommand(
        'powershell -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 | ConvertTo-Json -Compress"',
        5000,
      )).trim();

      if (!result) {
        return this.getDefaultBatteryInfo();
      }

      const batteryData = JSON.parse(result);
      const percentage = parseInt(batteryData.EstimatedChargeRemaining || '0', 10) || 0;
      const statusCode = parseInt(batteryData.BatteryStatus || '0', 10) || 0;

      const statusMap: Record<number, string> = {
        1: 'DISCHARGING',
        2: 'AC',
        3: 'FULL',
        4: 'LOW',
        5: 'CRITICAL',
        6: 'CHARGING',
        7: 'CHARGING_HIGH',
        8: 'CHARGING_LOW',
        9: 'CHARGING_CRITICAL',
        10: 'UNDEFINED',
        11: 'PARTIALLY_CHARGED',
      };

      const status = statusMap[statusCode] || 'UNKNOWN';
      const plugged = [2, 3, 6, 7, 8, 9, 11].includes(statusCode) ? 'AC' : 'BATTERY';

      return {
        health: 'GOOD',
        percentage,
        plugged,
        status,
        temperature: 0,
        current: 0,
        voltage: 0,
        powerUsageWatts: 0,
        powerUsageMilliWatts: 0,
        estimatedMiningPowerWatts: 0,
      };
    } catch {
      return this.getDefaultBatteryInfo();
    }
  }

  /** ✅ Get battery info on Termux (Android) */
  private static async getTermuxBatteryInfo() {
    try {
      const result = await this.execCommand('termux-battery-status');
      const batteryData = JSON.parse(result);

      // Get enhanced power consumption data
      const powerData = await this.getEnhancedPowerData();

      return {
        health: batteryData.health || 'UNKNOWN',
        percentage: batteryData.percentage || 0,
        plugged: batteryData.plugged || 'UNKNOWN',
        status: batteryData.status || 'UNKNOWN',
        temperature: batteryData.temperature || 0,
        current: batteryData.current || powerData.currentMicroAmps || 0,
        voltage: powerData.voltageMicroVolts || 0,
        powerUsageWatts: powerData.batteryPowerWatts || 0,
        powerUsageMilliWatts: powerData.batteryPowerMilliWatts || 0,
        // Mining power estimate
        estimatedMiningPowerWatts: powerData.estimatedMiningPowerWatts || 0,
      };
    } catch {
      return this.getDefaultBatteryInfo();
    }
  }

  /** ✅ Get enhanced power consumption data */
  private static async getEnhancedPowerData() {
    const result = {
      currentMicroAmps: 0,
      voltageMicroVolts: 0,
      batteryPowerWatts: 0,
      batteryPowerMilliWatts: 0,
      estimatedMiningPowerWatts: 0,
    };

    // Get battery current/voltage with su -c
    try {
      const currentResult = (await this.execCommand(
        `su -c "cat /sys/class/power_supply/battery/current_now" 2>/dev/null`,
        2000,
      )).trim();

      const voltageResult = (await this.execCommand(
        `su -c "cat /sys/class/power_supply/battery/voltage_now" 2>/dev/null`,
        2000,
      )).trim();

      result.currentMicroAmps = Math.abs(parseInt(currentResult) || 0);
      result.voltageMicroVolts = parseInt(voltageResult) || 0;

      if (result.currentMicroAmps > 0 && result.voltageMicroVolts > 0) {
        result.batteryPowerWatts =
          (result.currentMicroAmps / 1000000) *
          (result.voltageMicroVolts / 1000000);
        result.batteryPowerMilliWatts = result.batteryPowerWatts * 1000;
      }
    } catch {
      // Battery method failed
    }

    // Estimate mining power based on CPU frequency
    try {
      const freqResult = (await this.execCommand(
        `su -c "cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null | head -8"`,
        2000,
      )).trim();

      if (freqResult) {
        const frequencies = freqResult
          .split('\n')
          .map((f) => parseInt(f.trim()) || 0)
          .filter((f) => f > 0);

        if (frequencies.length > 0) {
          const avgFreq =
            frequencies.reduce((a, b) => a + b, 0) / frequencies.length;

          // Power estimate: 0.4-0.6W per core at full frequency
          // Scale based on actual frequency vs max (assume 2.4GHz max)
          const maxFreq = 2400000;
          const freqRatio = Math.min(avgFreq / maxFreq, 1);
          result.estimatedMiningPowerWatts = frequencies.length * 0.5 * freqRatio;
        }
      }
    } catch {
      // CPU frequency method failed
    }

    // Fallback - estimate based on device capabilities
    if (result.estimatedMiningPowerWatts === 0) {
      // Try to detect device type and set appropriate estimate
      try {
        const cpuInfo = (await this.execCommand('cat /proc/cpuinfo 2>/dev/null | head -20', 1000)).toLowerCase();
        
        if (cpuInfo.includes('raspberry') || cpuInfo.includes('bcm')) {
          result.estimatedMiningPowerWatts = 15.0; // Raspberry Pi (your data: 6mhs at 15W)
        } else if (
          cpuInfo.includes('cortex-a') ||
          cpuInfo.includes('snapdragon')
        ) {
          result.estimatedMiningPowerWatts = 4.0; // Mobile/ARM devices (your data: 4mhs at 4W)
        } else {
          result.estimatedMiningPowerWatts = 2.0; // Conservative fallback for unknown devices
        }
      } catch {
        result.estimatedMiningPowerWatts = 2.0; // Conservative fallback for unknown devices
      }
    }

    return result;
  }

  /** ✅ Get battery info on Linux (ACPI or sysfs) */
  private static async getLinuxBatteryInfo() {
    try {
      const acpiOutput = await this.execCommand('acpi -b');
      const match = acpiOutput.match(/Battery \d+: (\w+), (\d+)%.*?([-\d.]+)? ?°?C?/);
      
      if (match) {
        const powerData = await this.getEnhancedPowerData();
        
        return {
          health: 'GOOD',
          percentage: parseInt(match[2]) || 0,
          plugged: match[1].includes('Charging') ? 'AC' : 'BATTERY',
          status: match[1].toUpperCase(),
          temperature: parseFloat(match[3]) || 0,
          current: powerData.currentMicroAmps || 0,
          voltage: powerData.voltageMicroVolts || 0,
          powerUsageWatts: powerData.batteryPowerWatts || 0,
          powerUsageMilliWatts: powerData.batteryPowerMilliWatts || 0,
          estimatedMiningPowerWatts: powerData.estimatedMiningPowerWatts || 0,
        };
      }
    } catch {
      // ACPI failed
    }

    return this.getDefaultBatteryInfo();
  }

  /** ✅ Get battery info on Raspberry Pi */
  private static async getRaspberryBatteryInfo() {
    try {
      const powerStatus = (await this.execCommand('vcgencmd get_throttled')).trim();
      const underVoltage = (parseInt(powerStatus, 16) & 0x1) !== 0;

      return {
        health: underVoltage ? 'UNDER_VOLTAGE' : 'GOOD',
        percentage: 100,
        plugged: 'AC',
        status: underVoltage ? 'UNDER_VOLTAGE' : 'CHARGING',
        temperature: 0,
        current: 0,
        voltage: 0,
        powerUsageWatts: 0,
        powerUsageMilliWatts: 0,
        estimatedMiningPowerWatts: 2.5, // Conservative Pi estimate
      };
    } catch {
      return this.getDefaultBatteryInfo();
    }
  }

  /** ✅ Default fallback */
  private static async getDefaultBatteryInfo() {
    // Get a reasonable power estimate based on system context
    let defaultPowerEstimate = 2.0; // Updated conservative fallback
    
    try {
      // Try to get some system info for better estimate
      const cpuInfo = (await this.execCommand('cat /proc/cpuinfo 2>/dev/null | head -10', 1000)).toLowerCase();
      
      if (cpuInfo.includes('raspberry') || cpuInfo.includes('bcm')) {
        defaultPowerEstimate = 15.0; // Raspberry Pi (6mhs at 15W)
      } else if (cpuInfo.includes('cortex-a') || cpuInfo.includes('snapdragon') || cpuInfo.includes('exynos')) {
        defaultPowerEstimate = 4.0; // Mobile/ARM devices (4mhs at 4W)
      } else if (cpuInfo.includes('intel') || cpuInfo.includes('amd')) {
        defaultPowerEstimate = 8.0; // x86/x64 systems (estimated higher)
      }
    } catch {
      // Keep ultra-conservative fallback
    }

    return {
      health: 'UNKNOWN',
      percentage: 0,
      plugged: 'UNPLUGGED',
      status: 'UNKNOWN',
      temperature: 0,
      current: 0,
      voltage: 0,
      powerUsageWatts: 0,
      powerUsageMilliWatts: 0,
      estimatedMiningPowerWatts: defaultPowerEstimate,
    };
  }
}