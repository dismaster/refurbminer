import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggingService } from '../../logging/logging.service';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { HardwareInfoUtil } from '../../telemetry/utils/hardware/hardware-info.util';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class OsDetectionService implements OnModuleInit {
  // Cache detection results to avoid repeated calls
  private cachedOS: string | null = null;
  private cachedIs64Bit: boolean | null = null;
  private cachedHardwareBrand: string | null = null;
  private cachedHardwareModel: string | null = null;
  private cachedCPUInfo: object | null = null;
  private cachedSystemInfo: object | null = null;
  private cachedIPAddress: string | null = null;

  constructor(private readonly loggingService: LoggingService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.cachedOS = await this.detectOSAsync();
    } catch {
      // Ignore init failures; fallback detection will be used
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readFileTrim(filePath: string): Promise<string> {
    const data = await fs.promises.readFile(filePath, 'utf8');
    return data.trim();
  }

  private async execCommand(command: string, timeout?: number): Promise<string> {
    const { stdout } = await execAsync(command, { encoding: 'utf8', timeout });
    return stdout ?? '';
  }
  /** ✅ Detects OS type (Raspberry Pi, Termux, Linux) */
  detectOS(): string {
    if (this.cachedOS !== null) {
      return this.cachedOS;
    }

    let detectedOS = 'unknown';
    if (os.platform().includes('linux')) {
      detectedOS = 'linux';
    }

    this.cachedOS = detectedOS;
    this.loggingService.log(
      `Detected OS: ${detectedOS}`,
      'INFO',
      'os-detection',
    );
    return detectedOS;
  }

  private async detectOSAsync(): Promise<string> {
    if (await this.fileExists('/data/data/com.termux/files/usr/bin/termux-info')) {
      return 'termux';
    }
    if (await this.fileExists('/usr/bin/raspi-config')) {
      return 'raspberry-pi';
    }
    if (os.platform().includes('linux')) {
      return 'linux';
    }
    return 'unknown';
  }
  /** ✅ Check if OS is 64-bit */
  async is64Bit(): Promise<boolean> {
    if (this.cachedIs64Bit !== null) {
      return this.cachedIs64Bit;
    }

    try {
      const arch = (await this.execCommand('uname -m')).trim();
      const is64 = arch === 'aarch64' || arch === 'x86_64';

      if (!is64) {
        try {
          const bitCheck = (await this.execCommand('getconf LONG_BIT')).trim();
          this.cachedIs64Bit = bitCheck === '64';
          return this.cachedIs64Bit;
        } catch {
          this.cachedIs64Bit = false;
          return false;
        }
      }

      this.cachedIs64Bit = is64;
      this.loggingService.log(
        `System is ${is64 ? '64-bit' : '32-bit'}`,
        'INFO',
        'os-detection',
      );
      return is64;
    } catch (error) {
      this.loggingService.log(
        `Error detecting system bitness: ${error.message}`,
        'ERROR',
        'os-detection',
      );
      this.cachedIs64Bit = false;
      return false;
    }
  }
  /** ✅ Detects hardware brand (e.g., Raspberry, Termux, Debian) */
  async getHardwareBrand(): Promise<string> {
    if (this.cachedHardwareBrand !== null) {
      return this.cachedHardwareBrand;
    }

    try {
      if (this.detectOS() === 'termux') {
        // Prefer Android property for brand
        const suspicious = /superuser|rooted|no\s*are/i;
        let brand = '';
        try {
          brand = (await this.execCommand('getprop ro.product.brand')).trim();
        } catch {}
        if (!brand && await this.isSuAvailable()) {
          try {
            brand = (await this.execCommand('su -c "getprop ro.product.brand"')).trim();
          } catch {}
        }
        if (brand && !suspicious.test(brand)) {
          this.cachedHardwareBrand = brand;
          return this.cachedHardwareBrand;
        }
        // Fallback to manufacturer
        let manufacturer = '';
        try {
          manufacturer = (await this.execCommand('getprop ro.product.manufacturer')).trim();
        } catch {}
        if (!manufacturer && await this.isSuAvailable()) {
          try {
            manufacturer = (await this.execCommand('su -c "getprop ro.product.manufacturer"')).trim();
          } catch {}
        }
        if (manufacturer && !suspicious.test(manufacturer)) {
          this.cachedHardwareBrand = manufacturer;
          return this.cachedHardwareBrand;
        }
        this.cachedHardwareBrand = 'android';
        return this.cachedHardwareBrand;
      }
      // Enhanced detection for ARM boards including Radxa
      if (await this.fileExists('/sys/firmware/devicetree/base/model')) {
        try {
          const modelContent = (await this.readFileTrim('/sys/firmware/devicetree/base/model')).replace(/\0/g, '');
          
          // Check for specific board manufacturers
          if (modelContent.toLowerCase().includes('radxa') || modelContent.toLowerCase().includes('rock')) {
            this.cachedHardwareBrand = 'Radxa';
            return this.cachedHardwareBrand;
          }
          
          if (modelContent.toLowerCase().includes('raspberry')) {
            this.cachedHardwareBrand = 'Raspberry Pi Foundation';
            return this.cachedHardwareBrand;
          }
          
          if (modelContent.toLowerCase().includes('orange')) {
            this.cachedHardwareBrand = 'Orange Pi';
            return this.cachedHardwareBrand;
          }
          
          // For unknown SoC identifiers, try alternative detection
          if (modelContent.match(/^[A-Z0-9]+$/)) {
            const altBrand = await this.detectBrandFromSystem();
            if (altBrand !== 'Unknown') {
              this.cachedHardwareBrand = altBrand;
              return this.cachedHardwareBrand;
            }
          }
          
          // Use first word if it looks like a brand name
          const firstWord = modelContent.split(/\s+/)[0].trim();
          if (firstWord.length > 2 && !firstWord.match(/^[A-Z0-9]+$/)) {
            this.cachedHardwareBrand = firstWord;
            return this.cachedHardwareBrand;
          }
        } catch (error) {
          this.loggingService.log(
            `Error reading devicetree model: ${error.message}`,
            'WARN',
            'os-detection',
          );
        }
      }
      
      // Try alternative detection methods
      const altBrand = await this.detectBrandFromSystem();
      if (altBrand !== 'Unknown') {
        this.cachedHardwareBrand = altBrand;
        return this.cachedHardwareBrand;
      }
      
      // Final fallback to lsb_release
      this.cachedHardwareBrand = (await this.execCommand('lsb_release -si')).trim();
      return this.cachedHardwareBrand;
    } catch (error) {
      this.loggingService.log(
        `Failed to detect hardware brand: ${error.message}`,
        'WARN',
        'os-detection',
      );
      this.cachedHardwareBrand = 'Unknown';
      return this.cachedHardwareBrand;
    }
  }

  /** ✅ Alternative brand detection from system files */
  private async detectBrandFromSystem(): Promise<string> {
    try {
      // Try DMI information
      if (await this.fileExists('/sys/class/dmi/id/board_vendor')) {
        const vendor = await this.readFileTrim('/sys/class/dmi/id/board_vendor');
        if (vendor && vendor !== 'To be filled by O.E.M.' && vendor !== 'Unknown') {
          return vendor;
        }
      }
      
      if (await this.fileExists('/sys/class/dmi/id/sys_vendor')) {
        const vendor = await this.readFileTrim('/sys/class/dmi/id/sys_vendor');
        if (vendor && vendor !== 'To be filled by O.E.M.' && vendor !== 'Unknown') {
          return vendor;
        }
      }
      
      return 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Alternative model detection from system files */
  private async detectModelFromSystem(): Promise<string> {
    try {
      // Try DMI product name
      if (await this.fileExists('/sys/class/dmi/id/product_name')) {
        const productName = await this.readFileTrim('/sys/class/dmi/id/product_name');
        if (productName && productName !== 'To be filled by O.E.M.' && productName !== 'Unknown') {
          return productName;
        }
      }
      
      // Try board name
      if (await this.fileExists('/sys/class/dmi/id/board_name')) {
        const boardName = await this.readFileTrim('/sys/class/dmi/id/board_name');
        if (boardName && boardName !== 'To be filled by O.E.M.' && boardName !== 'Unknown') {
          return boardName;
        }
      }
      
      // Final fallback to architecture
      return os.arch().toUpperCase();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Detects hardware model (e.g., Pi 5, ARM64) */
  async getHardwareModel(): Promise<string> {
    if (this.cachedHardwareModel !== null) {
      return this.cachedHardwareModel;
    }
    try {
      if (this.detectOS() === 'termux') {
        // Use hardware-specific properties first for more accurate detection
        // These are less likely to be affected by custom ROMs
        // Ordered by user-friendliness: shorter, cleaner names first
        const hardwareProperties = [
          'ro.boot.product.model',
          'ro.boot.em.model', 
          'ril.product_code',
          'vendor.ril.product_code'
        ];
        
        this.loggingService.log(
          '🔍 Attempting hardware-specific model detection for Termux',
          'DEBUG',
          'os-detection',
        );
        
        for (const prop of hardwareProperties) {
          let model = '';
          try {
            model = (await this.execCommand(`getprop ${prop}`)).trim();
            if (model && model !== '' && !model.includes('no such property')) {
              this.loggingService.log(
                `✅ Found hardware model from ${prop}: ${model}`,
                'INFO',
                'os-detection',
              );
              this.cachedHardwareModel = model;
              return this.cachedHardwareModel;
            }
          } catch {}
          
          // Try with su if available
          if (!model && await this.isSuAvailable()) {
            try {
              model = (await this.execCommand(`su -c "getprop ${prop}"`)).trim();
              if (model && model !== '' && !model.includes('no such property')) {
                this.loggingService.log(
                  `✅ Found hardware model from ${prop} (with su): ${model}`,
                  'INFO',
                  'os-detection',
                );
                this.cachedHardwareModel = model;
                return this.cachedHardwareModel;
              }
            } catch {}
          }
        }
        
        // Fallback to standard Android properties if hardware-specific ones fail
        const standardProperties = [
          'ro.product.model',
          'ro.product.device',
          'ro.product.name'
        ];
        
        this.loggingService.log(
          '⚠️ Hardware-specific properties not found, falling back to standard properties',
          'WARN',
          'os-detection',
        );
        
        const suspicious = /superuser|rooted|no\s*are/i;
        
        for (const prop of standardProperties) {
          let model = '';
          try {
            model = (await this.execCommand(`getprop ${prop}`)).trim();
            if (model && !suspicious.test(model)) {
              this.loggingService.log(
                `✅ Found model from fallback ${prop}: ${model}`,
                'INFO',
                'os-detection',
              );
              this.cachedHardwareModel = model;
              return this.cachedHardwareModel;
            }
          } catch {}
          
          if (!model && await this.isSuAvailable()) {
            try {
              model = (await this.execCommand(`su -c "getprop ${prop}"`)).trim();
              if (model && !suspicious.test(model)) {
                this.loggingService.log(
                  `✅ Found model from fallback ${prop} (with su): ${model}`,
                  'INFO',
                  'os-detection',
                );
                this.cachedHardwareModel = model;
                return this.cachedHardwareModel;
              }
            } catch {}
          }
        }
        
        // Final fallback to architecture
        try {
          const arch = (await this.execCommand('uname -m')).trim();
          this.loggingService.log(
            `⚠️ Using architecture as final fallback: ${arch}`,
            'WARN',
            'os-detection',
          );
          this.cachedHardwareModel = arch || os.arch();
          return this.cachedHardwareModel;
        } catch {
          this.cachedHardwareModel = os.arch();
          return this.cachedHardwareModel;
        }
      }
      // Enhanced ARM board model detection
      if (await this.fileExists('/sys/firmware/devicetree/base/model')) {
        try {
          const modelContent = (await this.readFileTrim('/sys/firmware/devicetree/base/model')).replace(/\0/g, '');
          
          // For Radxa devices, try to extract the specific model
          if (modelContent.toLowerCase().includes('radxa') || modelContent.toLowerCase().includes('rock')) {
            // Try to get more specific model information from compatible string
            if (await this.fileExists('/sys/firmware/devicetree/base/compatible')) {
              const compatible = (await this.readFileTrim('/sys/firmware/devicetree/base/compatible')).replace(/\0/g, '');
              const compatibleParts = compatible.split(',');
              
              // Look for Radxa-specific identifiers
              for (const part of compatibleParts) {
                if (part.includes('radxa') || part.includes('rock')) {
                  // Extract model from compatible string (e.g., "radxa,rock-5a" -> "Rock 5A")
                  const modelMatch = part.match(/radxa,(.+)|rock.?(.+)/i);
                  if (modelMatch) {
                    const model = (modelMatch[1] || modelMatch[2])
                      .replace(/-/g, ' ')
                      .replace(/\b\w/g, l => l.toUpperCase());
                    this.cachedHardwareModel = model;
                    return this.cachedHardwareModel;
                  }
                }
              }
            }
            
            // Try to detect specific Radxa model from SoC identifier
            if (modelContent.includes('SUN55IW3')) {
              this.cachedHardwareModel = 'Cubie A5E';
              return this.cachedHardwareModel;
            }
            
            // Fallback to parsing the model string directly
            if (modelContent.toLowerCase().includes('radxa')) {
              this.cachedHardwareModel = modelContent;
              return this.cachedHardwareModel;
            }
            
            // If we detect it's a Radxa but can't get specific model
            this.cachedHardwareModel = 'Unknown Radxa Model';
            return this.cachedHardwareModel;
          }
          
          // For other devices, clean up the model content
          if (modelContent && !modelContent.match(/^[A-Z0-9]+$/)) {
            this.cachedHardwareModel = modelContent;
            return this.cachedHardwareModel;
          }
          
          // If model content looks like SoC identifier, try alternative detection
          if (modelContent.match(/^[A-Z0-9]+$/)) {
            const altModel = await this.detectModelFromSystem();
            if (altModel !== 'Unknown') {
              this.cachedHardwareModel = altModel;
              return this.cachedHardwareModel;
            }
          }
        } catch (error) {
          this.loggingService.log(
            `Error reading devicetree for model: ${error.message}`,
            'WARN',
            'os-detection',
          );
        }
      }
      
      // Try alternative detection methods
      const altModel = await this.detectModelFromSystem();
      if (altModel !== 'Unknown') {
        this.cachedHardwareModel = altModel;
        return this.cachedHardwareModel;
      }
      this.cachedHardwareModel = os.arch().toUpperCase();
      return this.cachedHardwareModel;
    } catch (error) {
      this.loggingService.log(
        `Failed to detect hardware model: ${error.message}`,
        'WARN',
        'os-detection',
      );
      this.cachedHardwareModel = 'Unknown';
      return this.cachedHardwareModel;
    }
  }

  /** ✅ Retrieves CPU information with better fallbacks */
  async getCPUInfo(): Promise<any> {
    if (this.cachedCPUInfo !== null) {
      return this.cachedCPUInfo;
    }

    try {
      let aesSupport = false;
      let pmullSupport = false;
      const architecture = await this.is64Bit() ? '64-bit' : '32-bit';
      let cpuModel = 'Unknown';
      let cores = 0;

      // Termux and some environments don't work well with os.cpus()
      // So we'll primarily use lscpu and only fall back to os.cpus()
      try {
        // Primary method: lscpu
        const lscpuOutput = (await this.execCommand('lscpu')).toLowerCase();
        aesSupport = lscpuOutput.includes('aes');
        pmullSupport = lscpuOutput.includes('pmull');

        // Parse CPU count from lscpu
        const coreMatch = lscpuOutput.match(/cpu\(s\):\s+(\d+)/i);
        if (coreMatch && coreMatch[1]) {
          cores = parseInt(coreMatch[1], 10);
        }

        // Parse CPU model from lscpu
        const modelMatch = lscpuOutput.match(/model name:\s+(.+)$/im);
        if (modelMatch && modelMatch[1]) {
          cpuModel = modelMatch[1].trim();
        }
      } catch (lscpuError) {
        this.loggingService.log(
          `lscpu failed: ${lscpuError.message}`,
          'DEBUG',
          'os-detection',
        );

        try {
          // First fallback: /proc/cpuinfo
          const cpuinfoOutput = (await this.execCommand('cat /proc/cpuinfo')).toLowerCase();
          aesSupport = cpuinfoOutput.includes('aes');
          pmullSupport = cpuinfoOutput.includes('pmull');
        } catch (cpuinfoError) {
          this.loggingService.log(
            `Failed to read /proc/cpuinfo: ${cpuinfoError.message}`,
            'DEBUG',
            'os-detection',
          );

          // For Intel/AMD CPUs, we can assume AES support for newer models
          if (cpuModel.includes('Intel') || cpuModel.includes('AMD')) {
            // Rough heuristic based on CPU generation
            const cpuGenMatch =
              cpuModel.match(/i[357]-\d{4,}/i) ||
              cpuModel.match(/i[357] \d{4,}/i);
            if (cpuGenMatch) {
              const genNumber = parseInt(cpuGenMatch[0].replace(/\D/g, ''));
              if (genNumber >= 2000) {
                // Most Intel CPUs since 2nd gen have AES
                aesSupport = true;
                this.loggingService.log(
                  `Assuming AES support based on CPU model: ${cpuModel}`,
                  'INFO',
                  'os-detection',
                );
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

      this.cachedCPUInfo = cpuInfo;
      return cpuInfo;
    } catch (error) {
      this.loggingService.log(
        `Failed to fetch CPU details: ${error.message}`,
        'WARN',
        'os-detection',
      );
      // Return default values that will allow the app to continue
      this.cachedCPUInfo = {
        architecture: await this.is64Bit() ? '64-bit' : '32-bit',
        model: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length,
        aesSupport: true, // Assume AES support to prevent blocking the app
        pmullSupport: false,
      };
      return this.cachedCPUInfo;
    }
  }

  /** ✅ Retrieves system metadata */
  async getSystemInfo(): Promise<any> {
    if (this.cachedSystemInfo !== null) {
      return this.cachedSystemInfo;
    }

    const osType = this.detectOS();
    
    // Try to get enhanced hardware info first
    let hwBrand = 'Unknown';
    let hwModel = 'Unknown';
    
    try {
      const enhancedInfo = await HardwareInfoUtil.getDeviceInfo(
        osType,
        this.loggingService.log.bind(this.loggingService),
      );
      
      if (enhancedInfo?.hardwareDetectionMethod === 'lshw') {
        hwBrand = enhancedInfo.hwBrand || await this.getHardwareBrand();
        hwModel = enhancedInfo.hwModel || await this.getHardwareModel();
        
        this.loggingService.log(
          `Using enhanced hardware detection: ${hwBrand} ${hwModel}`,
          'INFO',
          'os-detection',
        );
      } else {
        // Fallback to basic detection
        hwBrand = await this.getHardwareBrand();
        hwModel = await this.getHardwareModel();
        
        this.loggingService.log(
          `Using basic hardware detection: ${hwBrand} ${hwModel}`,
          'INFO',
          'os-detection',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `Enhanced hardware detection failed, using basic: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'os-detection',
      );
      hwBrand = await this.getHardwareBrand();
      hwModel = await this.getHardwareModel();
    }

    const systemInfo = {
      osType,
      hwBrand,
      hwModel,
      os: osType === 'termux' ? 'Termux (Linux)' : os.version(),
      cpuInfo: await this.getCPUInfo(),
    };

    this.loggingService.log(
      `System Info: ${JSON.stringify(systemInfo, null, 2)}`,
      'INFO',
      'os-detection',
    );
    this.cachedSystemInfo = systemInfo;
    return systemInfo;
  }

  /** ✅ Gets device IP Address */
  async getIPAddress(): Promise<string> {
    if (this.cachedIPAddress !== null) {
      return this.cachedIPAddress;
    }

    try {
      let ip = '';
      
      // Method 1: Try ifconfig first (most reliable on Termux)
      try {
        ip = (await this.execCommand("ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -n1 | awk '{print $2}'", 5000)).trim();
        
        if (ip && ip !== '' && ip !== '127.0.0.1' && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          this.loggingService.log(
            `Detected IP Address via ifconfig: ${ip}`,
            'INFO',
            'os-detection',
          );
          this.cachedIPAddress = ip;
          return this.cachedIPAddress;
        }
      } catch (error) {
        // Continue to next method
      }

      // Method 2: Try ip command (alternative)
      try {
        const routeOutput = (await this.execCommand('ip route get 8.8.8.8', 5000)).trim();
        
        // Extract IP from "src X.X.X.X" pattern
        const srcMatch = routeOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (srcMatch && srcMatch[1]) {
          ip = srcMatch[1];
          this.loggingService.log(
            `Detected IP Address via ip route: ${ip}`,
            'INFO',
            'os-detection',
          );
          this.cachedIPAddress = ip;
          return this.cachedIPAddress;
        }
      } catch (error) {
        // Continue to next method
      }

      // Method 3: Try hostname -I (traditional method, may not work on Termux)
      try {
        ip = (await this.execCommand("hostname -I | awk '{print $1}'", 5000)).trim();
        
        if (ip && ip !== '' && ip !== '127.0.0.1') {
          this.loggingService.log(
            `Detected IP Address via hostname: ${ip}`,
            'INFO',
            'os-detection',
          );
          this.cachedIPAddress = ip;
          return this.cachedIPAddress;
        }
      } catch (error) {
        // Continue to fallback
      }

      // Fallback: Use 127.0.0.1
      this.loggingService.log(
        'Unable to detect IP address, using fallback 127.0.0.1',
        'WARN',
        'os-detection',
      );
      this.cachedIPAddress = '127.0.0.1';
      return this.cachedIPAddress;
    } catch (error) {
      this.loggingService.log(
        `Failed to fetch IP Address: ${error.message}`,
        'ERROR',
        'os-detection',
      );
      this.cachedIPAddress = '127.0.0.1';
      return this.cachedIPAddress;
    }
  }

  /** ✅ Check if SU (root) is available */
  async isSuAvailable(): Promise<boolean> {
    try {
      const result = await this.execCommand('su -c "echo rooted" 2>/dev/null');
      return result.includes('rooted');
    } catch {
      return false;
    }
  }

  /** ✅ Gets better OS version string */
  async getOsVersion(): Promise<string> {
    try {
      if (this.detectOS() === 'termux') {
        // Try to get Android version
        try {
          const releaseVer = (await this.execCommand('getprop ro.build.version.release')).trim();
          const sdkVer = (await this.execCommand('getprop ro.build.version.sdk')).trim();
          if (releaseVer && sdkVer) {
            return `Android ${releaseVer} (API ${sdkVer})`;
          }
        } catch (error) {
          // Try with su
          try {
            if (await this.isSuAvailable()) {
              const releaseVer = (await this.execCommand(
                'su -c "getprop ro.build.version.release"',
              )).trim();
              const sdkVer = (await this.execCommand('su -c "getprop ro.build.version.sdk"')).trim();
              if (releaseVer && sdkVer) {
                return `Android ${releaseVer} (API ${sdkVer})`;
              }
            }
          } catch {
            // Continue to fallback
          }
        }
        return 'Termux (Linux)';
      }

      // Check for /etc/os-release
      if (await this.fileExists('/etc/os-release')) {
        const osRelease = await fs.promises.readFile('/etc/os-release', 'utf8');
        const prettyName = osRelease
          .split('\n')
          .find((line) => line.startsWith('PRETTY_NAME='))
          ?.split('=')[1]
          ?.replace(/"/g, '');

        if (prettyName) {
          return prettyName;
        }
      }

      return os.version();
    } catch (error) {
      this.loggingService.log(
        `Failed to get OS version: ${error.message}`,
        'WARN',
        'os-detection',
      );
      return 'Unknown';
    }
  }
}
