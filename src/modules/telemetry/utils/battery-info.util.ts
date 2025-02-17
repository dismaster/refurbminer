import * as fs from 'fs';
import { execSync } from 'child_process';

export class BatteryInfoUtil {
  /** ✅ Get battery details based on system type */
  static getBatteryInfo(systemType: string): any {
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
  }

  /** ✅ Get battery info on Termux (Android) */
  private static getTermuxBatteryInfo() {
    try {
      const result = execSync('termux-battery-status', { encoding: 'utf8' });
      const batteryData = JSON.parse(result);

      return {
        health: batteryData.health || 'UNKNOWN',
        percentage: batteryData.percentage || 0,
        plugged: batteryData.plugged || 'UNKNOWN',
        status: batteryData.status || 'UNKNOWN',
        temperature: batteryData.temperature || 0,
        current: batteryData.current || 0
      };
    } catch {
      return this.getDefaultBatteryInfo();
    }
  }

  /** ✅ Get battery info on Linux (ACPI or sysfs) */
  private static getLinuxBatteryInfo() {
    try {
      const acpiOutput = execSync('acpi -b', { encoding: 'utf8' });
      const match = acpiOutput.match(/Battery \d+: (\w+), (\d+)%.*?([-\d.]+)? ?°?C?/);
      if (match) {
        return {
          health: 'GOOD',
          percentage: parseInt(match[2]) || 0,
          plugged: match[1].includes('Charging') ? 'AC' : 'BATTERY',
          status: match[1].toUpperCase(),
          temperature: parseFloat(match[3]) || 0,
          current: 0
        };
      }
    } catch {}

    return this.getDefaultBatteryInfo();
  }

  /** ✅ Get battery info on Raspberry Pi */
  private static getRaspberryBatteryInfo() {
    try {
      const powerStatus = execSync('vcgencmd get_throttled', { encoding: 'utf8' }).trim();
      const underVoltage = (parseInt(powerStatus, 16) & 0x1) !== 0;

      return {
        health: underVoltage ? 'UNDER_VOLTAGE' : 'GOOD',
        percentage: 100,
        plugged: 'AC',
        status: underVoltage ? 'UNDER_VOLTAGE' : 'CHARGING',
        temperature: 0,
        current: 0
      };
    } catch {
      return this.getDefaultBatteryInfo();
    }
  }

  /** ✅ Default fallback */
  private static getDefaultBatteryInfo() {
    return {
      health: 'UNKNOWN',
      percentage: 0,
      plugged: 'UNPLUGGED',
      status: 'UNKNOWN',
      temperature: 0,
      current: 0
    };
  }
}
