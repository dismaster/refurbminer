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

/** ✅ Get CPU thread details with better Termux support */
static getCpuThreads(): Array<any> {
  try {
    const lscpuOutput = execSync('lscpu', { encoding: 'utf8' }).split('\n');
    const cpuGroups: Array<{
      model: string;
      maxMHz: number;
      minMHz: number;
      cores: number;
    }> = [];
    
    let currentGroup: any = {};
    
    // Parse lscpu output
    lscpuOutput.forEach(line => {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('Model name:')) {
        // Start new CPU group
        if (currentGroup.model) {
          cpuGroups.push({ ...currentGroup });
        }
        currentGroup = {
          model: trimmed.split(':')[1].trim(),
          maxMHz: 0,
          minMHz: 0,
          cores: 0
        };
      }
      
      if (trimmed.startsWith('CPU max MHz:')) {
        currentGroup.maxMHz = parseFloat(trimmed.split(':')[1].trim());
      }
      
      if (trimmed.startsWith('CPU min MHz:')) {
        currentGroup.minMHz = parseFloat(trimmed.split(':')[1].trim());
      }
      
      if (trimmed.startsWith('Core(s) per socket:')) {
        currentGroup.cores = parseInt(trimmed.split(':')[1].trim());
      }
    });
    
    // Add last group
    if (currentGroup.model) {
      cpuGroups.push(currentGroup);
    }

    // Create CPU thread array
    const cpuThreads = [];
    let coreId = 0;

    cpuGroups.forEach(group => {
      for (let i = 0; i < group.cores; i++) {
        cpuThreads.push({
          model: group.model,
          coreId: coreId++,
          maxMHz: group.maxMHz,
          minMHz: group.minMHz,
          khs: Math.random() * 500 // Simulated mining speed
        });
      }
    });

    return cpuThreads;

  } catch (error) {
    console.error('Failed to get detailed CPU info:', error);
    
    // Fallback to basic CPU info
    return os.cpus().map((cpu, index) => ({
      model: cpu.model || 'Unknown',
      coreId: index,
      maxMHz: cpu.speed || 0,
      minMHz: Math.floor((cpu.speed || 0) * 0.3),
      khs: Math.random() * 500
    }));
  }
}

/** ✅ Extract text value from lscpu output */
private static extractTextValue(output: string[], key: string): string {
  try {
    const line = output.find(l => l.includes(key + ':'));
    return line ? line.split(':')[1].trim() : '';
  } catch {
    return '';
  }
}

/** ✅ Extract numeric value from lscpu output */
private static extractValue(output: string[], key: string): number {
  try {
    const line = output.find(l => l.includes(key + ':'));
    if (!line) return 0;
    const value = line.split(':')[1].trim().split('.')[0]; // Remove decimal part
    return parseInt(value) || 0;
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

  /** ✅ Linux: Default Method for CPU Temperature */
  private static getLinuxCpuTemperature(): number {
    try {
      // Try thermal zone
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const tempRaw = execSync('cat /sys/class/thermal/thermal_zone0/temp', { encoding: 'utf8' }).trim();
        const temp = parseInt(tempRaw) / 1000;
        if (!isNaN(temp)) return temp;
      }

      // Try acpi as fallback
      const tempOutput = execSync('acpi -t', { encoding: 'utf8' });
      const match = tempOutput.match(/\d+\.\d+/);
      if (match) return parseFloat(match[0]);

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