import { Injectable } from '@nestjs/common';
import { LoggingService } from '../../logging/logging.service';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

@Injectable()
export class OsDetectionService {
  constructor(private readonly loggingService: LoggingService) {}

  /** ✅ Detects OS type (Raspberry Pi, Termux, Linux) */
  detectOS(): string {
    let detectedOS = 'unknown';

    if (fs.existsSync('/data/data/com.termux/files/usr/bin/termux-info')) {
      detectedOS = 'termux';
    } else if (fs.existsSync('/usr/bin/raspi-config')) {
      detectedOS = 'raspberry-pi';
    } else if (os.platform().includes('linux')) {
      detectedOS = 'linux';
    }

    this.loggingService.log(`Detected OS: ${detectedOS}`, 'INFO', 'os-detection');
    return detectedOS;
  }

  /** ✅ Check if OS is 64-bit */
  is64Bit(): boolean {
    try {
      const arch = execSync('uname -m', { encoding: 'utf8' }).trim();
      const is64 = arch === 'aarch64' || arch === 'x86_64';

      if (!is64) {
        try {
          const bitCheck = execSync('getconf LONG_BIT', { encoding: 'utf8' }).trim();
          return bitCheck === '64';
        } catch {
          return false;
        }
      }

      this.loggingService.log(`System is ${is64 ? '64-bit' : '32-bit'}`, 'INFO', 'os-detection');
      return is64;
    } catch (error) {
      this.loggingService.log(`Error detecting system bitness: ${error.message}`, 'ERROR', 'os-detection');
      return false;
    }
  }

  /** ✅ Detects hardware brand (e.g., Raspberry, Termux, Debian) */
  getHardwareBrand(): string {
    try {
      if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
        return execSync("cat /sys/firmware/devicetree/base/model | awk '{print $1}'", { encoding: 'utf8' })
          .trim()
          .toUpperCase();
      }

      if (this.detectOS() === 'termux') {
        return execSync('getprop ro.product.brand', { encoding: 'utf8' }).trim().toUpperCase();
      }

      return execSync('lsb_release -si', { encoding: 'utf8' }).trim();
    } catch (error) {
      this.loggingService.log(`Failed to detect hardware brand: ${error.message}`, 'WARN', 'os-detection');
      return 'Unknown';
    }
  }

  /** ✅ Detects hardware model (e.g., Pi 5, ARM64) */
  getHardwareModel(): string {
    try {
      if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
        return execSync("cat /sys/firmware/devicetree/base/model | awk '{print $2, $3}'", { encoding: 'utf8' })
          .trim()
          .toUpperCase();
      }

      if (this.detectOS() === 'termux') {
        return execSync('getprop ro.product.model', { encoding: 'utf8' }).trim().toUpperCase();
      }

      return os.arch().toUpperCase();
    } catch (error) {
      this.loggingService.log(`Failed to detect hardware model: ${error.message}`, 'WARN', 'os-detection');
      return 'Unknown';
    }
  }

  /** ✅ Retrieves CPU information with better fallbacks */
  getCPUInfo(): any {
    try {
      let aesSupport = false;
      let pmullSupport = false;
      let architecture = this.is64Bit() ? '64-bit' : '32-bit';
      const cpuModel = os.cpus()[0]?.model || 'Unknown';
      const cores = os.cpus().length;
      
      // Try multiple methods to detect CPU features
      try {
        // Primary method: lscpu
        const lscpuOutput = execSync('lscpu', { encoding: 'utf8' }).toLowerCase();
        aesSupport = lscpuOutput.includes('aes');
        pmullSupport = lscpuOutput.includes('pmull');
      } catch (lscpuError) {
        this.loggingService.log(`lscpu failed: ${lscpuError.message}`, 'DEBUG', 'os-detection');
        
        try {
          // First fallback: /proc/cpuinfo
          const cpuinfoOutput = execSync('cat /proc/cpuinfo', { encoding: 'utf8' }).toLowerCase();
          aesSupport = cpuinfoOutput.includes('aes');
          pmullSupport = cpuinfoOutput.includes('pmull');
        } catch (cpuinfoError) {
          this.loggingService.log(`Failed to read /proc/cpuinfo: ${cpuinfoError.message}`, 'DEBUG', 'os-detection');
          
          // For Intel/AMD CPUs, we can assume AES support for newer models
          if (cpuModel.includes('Intel') || cpuModel.includes('AMD')) {
            // Rough heuristic based on CPU generation
            const cpuGenMatch = cpuModel.match(/i[357]-\d{4,}/i) || cpuModel.match(/i[357] \d{4,}/i);
            if (cpuGenMatch) {
              const genNumber = parseInt(cpuGenMatch[0].replace(/\D/g, ''));
              if (genNumber >= 2000) { // Most Intel CPUs since 2nd gen have AES
                aesSupport = true;
                this.loggingService.log(`Assuming AES support based on CPU model: ${cpuModel}`, 'INFO', 'os-detection');
              }
            } else if (cpuModel.includes('Xeon')) {
              aesSupport = true; // Most Xeons support AES
            }
          }
        }
      }

      const cpuInfo = {
        architecture,
        model: cpuModel,
        cores,
        aesSupport,
        pmullSupport,
      };

      this.loggingService.log(
        `CPU Info - Architecture: ${cpuInfo.architecture}, AES: ${cpuInfo.aesSupport}, PMULL: ${cpuInfo.pmullSupport}, Cores: ${cpuInfo.cores}`,
        'INFO',
        'os-detection',
      );

      return cpuInfo;
    } catch (error) {
      this.loggingService.log(`Failed to fetch CPU details: ${error.message}`, 'WARN', 'os-detection');
      // Return default values that will allow the app to continue
      return {
        architecture: this.is64Bit() ? '64-bit' : '32-bit',
        model: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length,
        aesSupport: true, // Assume AES support to prevent blocking the app
        pmullSupport: false,
      };
    }
  }

  /** ✅ Retrieves system metadata */
  getSystemInfo(): any {
    const systemInfo = {
      osType: this.detectOS(),
      hwBrand: this.getHardwareBrand(),
      hwModel: this.getHardwareModel(),
      os: this.detectOS() === 'termux' ? 'Termux (Linux)' : os.version(),
      cpuInfo: this.getCPUInfo(),
    };

    this.loggingService.log(`System Info: ${JSON.stringify(systemInfo, null, 2)}`, 'INFO', 'os-detection');
    return systemInfo;
  }

  /** ✅ Gets device IP Address */
  getIPAddress(): string {
    try {
      const ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
      this.loggingService.log(`Detected IP Address: ${ip}`, 'INFO', 'os-detection');
      return ip || '127.0.0.1';
    } catch (error) {
      this.loggingService.log(`Failed to fetch IP Address: ${error.message}`, 'ERROR', 'os-detection');
      return '127.0.0.1';
    }
  }
}
