import { execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryInfoUtil } from './memory-info.util';
import { StorageInfoUtil } from './storage-info.util';

export class HardwareInfoUtil {
  private static readonly VCGENCMD_PATH = path.join(process.cwd(), 'apps', 'vcgencmd', 'vcgencmd');

  /** ✅ Get full hardware info */
  static getDeviceInfo(systemType: string): any {
    const totalMemory = MemoryInfoUtil.getTotalMemory();
    const freeMemory = MemoryInfoUtil.getFreeMemory();
    const totalStorage = StorageInfoUtil.getTotalStorage();
    const freeStorage = StorageInfoUtil.getFreeStorage();
  
    return {
      hwBrand: this.getBrand(systemType),
      hwModel: this.getModel(systemType),
      architecture: this.getArchitecture(),
      os: this.getOsVersion(),
      cpuCount: this.getCpuCount(),
      cpuModel: this.getCpuThreads(),
      cpuTemperature: this.getCpuTemperature(systemType),
      // Add raw values
      totalMemory: totalMemory,
      freeMemory: freeMemory, 
      totalStorage: totalStorage,
      freeStorage: freeStorage,
      adbEnabled: this.isAdbEnabled(systemType),
      suAvailable: this.isSuAvailable(systemType)
    };
  }


  /** ✅ Get hardware brand */
  static getBrand(systemType: string): string {
    try {
      if (systemType === 'termux') {
        return this.runCommandWithSuFallback('getprop ro.product.brand');
      }
      if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
        return execSync("cat /sys/firmware/devicetree/base/model | awk '{print $1}'", { encoding: 'utf8' })
          .trim()
          .toUpperCase();
      }
      return execSync('lsb_release -si', { encoding: 'utf8' }).trim();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Get hardware model */
  static getModel(systemType: string): string {
    try {
      if (systemType === 'termux') {
        return this.runCommandWithSuFallback('getprop ro.product.model');
      }
      if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
        return execSync("cat /sys/firmware/devicetree/base/model | awk '{print $2, $3}'", { encoding: 'utf8' })
          .trim()
          .toUpperCase();
      }
      return os.arch().toUpperCase();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Get CPU architecture */
  static getArchitecture(): string {
    return os.arch();
  }

/** ✅ Get OS version */
static getOsVersion(): string {
  try {
    if (process.env.TERMUX_VERSION) {
      // We're in Termux, get Android version
      const releaseVer = this.runCommandWithSuFallback('getprop ro.build.version.release');
      const sdkVer = this.runCommandWithSuFallback('getprop ro.build.version.sdk');
      return `Android ${releaseVer} (API ${sdkVer})`;
    }

    // Check for /etc/os-release first (Linux/RPi)
    if (fs.existsSync('/etc/os-release')) {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      const prettyName = osRelease
        .split('\n')
        .find(line => line.startsWith('PRETTY_NAME='))
        ?.split('=')[1]
        ?.replace(/"/g, '');
      
      if (prettyName) {
        return prettyName;
      }
    }

    // Fallback to os.version()
    return os.version();
  } catch {
    return 'Unknown';
  }
}

  /** ✅ Get CPU core count */
  static getCpuCount(): number {
    try {
      return parseInt(execSync("lscpu | grep '^CPU(s):' | awk '{print $2}'", { encoding: 'utf8' }).trim());
    } catch {
      return os.cpus().length;
    }
  }

/** ✅ Get CPU thread details (using `lscpu`) */
static getCpuThreads(): Array<any> {
  try {
    // Get raw lscpu output
    const output = execSync('lscpu', { encoding: 'utf8' }).split('\n');
    const threadList: any[] = [];
    
    // Try to get CPU details with better parsing
    const modelNames = output
      .filter(line => line.includes('Model name'))
      .map(line => line.split(':')[1]?.trim())
      .filter(Boolean);

    const maxMHzList = output
      .filter(line => line.includes('CPU max MHz'))
      .map(line => parseFloat(line.split(':')[1]?.trim() || '0'));

    const minMHzList = output
      .filter(line => line.includes('CPU min MHz'))
      .map(line => parseFloat(line.split(':')[1]?.trim() || '0'));

    // Get total CPU count
    const cores = parseInt(
      output.find(l => l.includes('CPU(s):'))?.split(':')[1]?.trim() || 
      os.cpus().length.toString()
    );

    // If we have a heterogeneous CPU (like big.LITTLE)
    if (modelNames.length > 1) {
      const coresPerType = Math.floor(cores / modelNames.length);
      modelNames.forEach((model, typeIndex) => {
        for (let i = 0; i < coresPerType; i++) {
          threadList.push({
            model: model,
            coreId: typeIndex * coresPerType + i,
            maxMHz: maxMHzList[typeIndex] || 0,
            minMHz: minMHzList[typeIndex] || 0,
            khs: 0 // Will be updated with actual mining data
          });
        }
      });
    } else {
      // Single CPU type
      const model = modelNames[0] || this.extractTextValue(output, 'Model name');
      const maxMHz = maxMHzList[0] || this.extractValue(output, 'CPU max MHz');
      const minMHz = minMHzList[0] || this.extractValue(output, 'CPU min MHz');

      for (let i = 0; i < cores; i++) {
        threadList.push({
          model: model || `CPU ${i}`,
          coreId: i,
          maxMHz: maxMHz || 0,
          minMHz: minMHz || 0,
          khs: 0 // Will be updated with actual mining data
        });
      }
    }

    return threadList;
  } catch (error) {
    console.error('Failed to get CPU threads:', error);
    
    // Fallback to basic CPU info
    return os.cpus().map((cpu, index) => ({
      model: cpu.model || `CPU ${index}`,
      coreId: index,
      maxMHz: cpu.speed || 0,
      minMHz: Math.floor((cpu.speed || 0) * 0.3),
      khs: 0
    }));
  }
}

/** ✅ Extract text value from lscpu output */
private static extractTextValue(output: string[], key: string): string {
  try {
    const line = output.find(l => l.trim().startsWith(key + ':'));
    return line ? line.split(':')[1].trim() : '';
  } catch {
    return '';
  }
}

/** ✅ Extract numeric value from lscpu output */
private static extractValue(output: string[], key: string): number {
  try {
    const line = output.find(l => l.trim().startsWith(key + ':'));
    if (!line) return 0;
    const value = line.split(':')[1].trim();
    return parseFloat(value) || 0;
  } catch {
    return 0;
  }
}

  /** ✅ Get CPU Temperature Based on OS */
  static getCpuTemperature(systemType: string): number {
    try {
      switch (systemType) {
        case 'raspberry-pi':
          return this.getVcgencmdTemperature();
        case 'termux':
          return this.getTermuxCpuTemperature();
        case 'linux':
          return this.getLinuxCpuTemperature();
        default:
          return 0;
      }
    } catch (error) {
      console.error(`❌ Failed to get CPU temperature: ${error.message}`);
      return 0;
    }
  }

  /** ✅ Raspberry Pi: Get CPU Temp via vcgencmd */
  private static getVcgencmdTemperature(): number {
    try {
      if (fs.existsSync(this.VCGENCMD_PATH)) {
        execSync(`chmod +x ${this.VCGENCMD_PATH}`);
        const tempOutput = execSync(`${this.VCGENCMD_PATH} measure_temp`, { encoding: 'utf8' });
        const match = tempOutput.match(/temp=([\d.]+)/);
        if (match) return parseFloat(match[1]);
      }
      return this.getLinuxCpuTemperature();
    } catch (error) {
      console.error(`❌ Failed to get Raspberry Pi temperature: ${error.message}`);
      return this.getLinuxCpuTemperature();
    }
  }

  /** ✅ Termux: Try to Use vcgencmd (if root), else fallback */
  private static getTermuxCpuTemperature(): number {
    try {
      // Try vcgencmd with root first
      if (this.isSuAvailable('termux') && fs.existsSync(this.VCGENCMD_PATH)) {
        execSync(`chmod +x ${this.VCGENCMD_PATH}`);
        const tempOutput = execSync(`su -c "${this.VCGENCMD_PATH} measure_temp"`, { encoding: 'utf8' });
        const match = tempOutput.match(/temp=([\d.]+)/);
        if (match) return parseFloat(match[1]);
      }

      // Try thermal zone with root
      if (this.isSuAvailable('termux')) {
        const tempRaw = execSync('su -c "cat /sys/class/thermal/thermal_zone0/temp"', { encoding: 'utf8' }).trim();
        const temp = parseInt(tempRaw) / 1000;
        if (!isNaN(temp)) return temp;
      }

      // Fallback to non-root thermal zone
      return this.getLinuxCpuTemperature();
    } catch (error) {
      console.error(`❌ Failed to get Termux temperature: ${error.message}`);
      return 0;
    }
  }

  /** ✅ Linux: Default Method for CPU Temperature with better fallbacks */
  private static getLinuxCpuTemperature(): number {
    try {
      // Method 1: Try thermal zone (most reliable)
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const tempRaw = execSync('cat /sys/class/thermal/thermal_zone0/temp', { encoding: 'utf8' }).trim();
        const temp = parseInt(tempRaw) / 1000;
        if (!isNaN(temp) && temp > 0 && temp < 150) return temp;
      }

      // Method 2: Try other thermal zones (1-9)
      for (let i = 1; i < 10; i++) {
        const zonePath = `/sys/class/thermal/thermal_zone${i}/temp`;
        if (fs.existsSync(zonePath)) {
          try {
            const tempRaw = execSync(`cat ${zonePath}`, { encoding: 'utf8' }).trim();
            const temp = parseInt(tempRaw) / 1000;
            if (!isNaN(temp) && temp > 0 && temp < 150) return temp;
          } catch {
            continue;
          }
        }
      }

      // Method 3: Try sensors command (lm-sensors package)
      try {
        const sensorsOutput = execSync('sensors', { encoding: 'utf8' }).trim();
        
        // Format 1: "Package id 0:  +45.0°C"
        const packageMatch = sensorsOutput.match(/Package id \d+:\s+\+(\d+\.\d+)°C/);
        if (packageMatch && packageMatch[1]) {
          return parseFloat(packageMatch[1]);
        }
        
        // Format 2: "Core 0:        +39.0°C"
        const coreMatch = sensorsOutput.match(/Core \d+:\s+\+(\d+\.\d+)°C/);
        if (coreMatch && coreMatch[1]) {
          return parseFloat(coreMatch[1]);
        }
      } catch {
        // Silently continue to next method
      }

      // Method 4: Try acpi as fallback (only if we have it installed)
      try {
        // Check if acpi exists before trying to use it
        execSync('command -v acpi > /dev/null 2>&1');
        
        const tempOutput = execSync('acpi -t', { encoding: 'utf8' });
        const match = tempOutput.match(/\d+\.\d+/);
        if (match) return parseFloat(match[0]);
      } catch {
        // Silently continue to next method
      }

      // Method 5: Try /proc/acpi/thermal_zone
      try {
        if (fs.existsSync('/proc/acpi/thermal_zone')) {
          const zones = execSync('ls /proc/acpi/thermal_zone', { encoding: 'utf8' }).trim().split('\n');
          if (zones.length > 0) {
            const tempOutput = execSync(`cat /proc/acpi/thermal_zone/${zones[0]}/temperature`, { encoding: 'utf8' });
            const match = tempOutput.match(/\d+/);
            if (match) return parseInt(match[0]);
          }
        }
      } catch {
        // No more methods to try
      }

      // No temperature data available
      console.log('No CPU temperature sensors detected');
      return 0;
    } catch (error) {
      console.error(`❌ Failed to get Linux temperature: ${error.message}`);
      return 0;
    }
  }

  /** ✅ Check if ADB is enabled (Termux-specific) */
  static isAdbEnabled(systemType: string): boolean {
    if (systemType !== 'termux') return false;
    try {
      const adbOutput = execSync('adb devices', { encoding: 'utf8' });
      const devices = adbOutput
        .split('\n')
        .slice(1) // Skip the "List of devices attached" header
        .filter(line => line.trim().length > 0)
        .map(line => line.trim().split('\t')[0]);
      
      return devices.length > 0;
    } catch (error) {
      // If adb command fails, it means ADB is not available
      console.error(`❌ Failed to check ADB status: ${error.message}`);
      return false;
    }
  }

  /** ✅ Check if SU (root) is available */
  static isSuAvailable(systemType: string): boolean {
    if (systemType !== 'termux') return false;
    try {
      return !!execSync('su -c "echo rooted" 2>/dev/null', { encoding: 'utf8' }).includes('rooted');
    } catch {
      return false;
    }
  }

  /** ✅ Run a command with fallback to `su` in Termux */
  private static runCommandWithSuFallback(command: string): string {
    try {
      return execSync(command, { encoding: 'utf8' }).trim();
    } catch {
      try {
        return execSync(`su -c "${command}"`, { encoding: 'utf8' }).trim();
      } catch {
        return 'Unknown';
      }
    }
  }
}