import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryInfoUtil } from './memory-info.util';
import { StorageInfoUtil } from './storage-info.util';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class HardwareInfoUtil {
  private static readonly VCGENCMD_PATH = path.join(
    process.cwd(),
    'apps',
    'vcgencmd',
    'vcgencmd',
  );

  private static deviceInfoCache: { systemType: string; data: any; timestamp: number } | null = null;
  private static readonly DEVICE_INFO_TTL = 30000; // 30 seconds
  private static lastTemperatureLogAt?: number;
  private static readonly TEMPERATURE_LOG_TTL = 30000; // 30 seconds

  private static async execCommand(command: string, timeout?: number): Promise<string> {
    const { stdout } = await execAsync(command, { encoding: 'utf8', timeout });
    return stdout ?? '';
  }

  private static async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private static async readFile(filePath: string): Promise<string> {
    return await fs.promises.readFile(filePath, 'utf8');
  }

  private static async readFileTrim(filePath: string): Promise<string> {
    const data = await fs.promises.readFile(filePath, 'utf8');
    return data.trim();
  }

  private static async readDir(dirPath: string): Promise<string[]> {
    return await fs.promises.readdir(dirPath);
  }

  /** ✅ Get full hardware info with enhanced detection */
  static async getDeviceInfo(systemType: string, logger?: (message: string, level: string, category: string) => void): Promise<any> {
    const log = logger || (() => {});

    const now = Date.now();
    if (
      this.deviceInfoCache &&
      this.deviceInfoCache.systemType === systemType &&
      now - this.deviceInfoCache.timestamp < this.DEVICE_INFO_TTL
    ) {
      return this.deviceInfoCache.data;
    }
    
    // For non-Termux systems, try enhanced detection first
    if (systemType !== 'termux') {
      const enhancedInfo = await this.getEnhancedDeviceInfo(systemType, log);
      if (enhancedInfo.hardwareDetectionMethod === 'lshw') {
        return enhancedInfo;
      }
    }
    
    // Fallback to basic detection
    const totalMemory = MemoryInfoUtil.getTotalMemory();
    const freeMemory = MemoryInfoUtil.getFreeMemory();
    const totalStorage = StorageInfoUtil.getTotalStorage();
    const freeStorage = StorageInfoUtil.getFreeStorage();

    const data = {
      hwBrand: await this.getBrand(systemType),
      hwModel: await this.getModel(systemType),
      architecture: this.getArchitecture(),
      os: await this.getOsVersion(),
      cpuCount: await this.getCpuCount(),
      cpuModel: await this.getCpuThreads(),
      cpuTemperature: await this.getCpuTemperature(systemType, logger),
      systemUptime: await this.getSystemUptime(systemType),
      totalMemory: totalMemory,
      freeMemory: freeMemory,
      totalStorage: totalStorage,
      freeStorage: freeStorage,
      adbEnabled: await this.isAdbEnabled(systemType),
      suAvailable: await this.isSuAvailable(systemType),
      hardwareDetectionMethod: 'basic'
    };

    this.deviceInfoCache = { systemType, data, timestamp: Date.now() };
    return data;
  }

  /** ✅ Get enhanced hardware info using lshw */
  static async getEnhancedDeviceInfo(systemType: string, logger: (message: string, level: string, category: string) => void): Promise<any> {
    const log = logger;
    
    try {
      log('Attempting to get enhanced hardware info using lshw...', 'DEBUG', 'hardware');
      
      // Check if lshw is available
      await this.execCommand('command -v lshw > /dev/null 2>&1');
      
      const lshwOutput = await this.execCommand('lshw -short -quiet 2>/dev/null', 10000);
      
      const enhancedInfo = this.parseLshwOutput(lshwOutput, log);
      
      // Get basic info for fallback values
      const totalMemory = MemoryInfoUtil.getTotalMemory();
      const freeMemory = MemoryInfoUtil.getFreeMemory();
      const totalStorage = StorageInfoUtil.getTotalStorage();
      const freeStorage = StorageInfoUtil.getFreeStorage();
      
      // Merge with basic info, preferring lshw data
      return {
        hwBrand: enhancedInfo.hwBrand || await this.getBrand(systemType),
        hwModel: enhancedInfo.hwModel || await this.getModel(systemType),
        detailedCpuModel: enhancedInfo.detailedCpuModel,
        detailedSystemInfo: enhancedInfo.systemDescription,
        primaryStorage: enhancedInfo.primaryStorage,
        graphicsCard: enhancedInfo.graphicsCard,
        networkController: enhancedInfo.networkController,
        memoryDescription: enhancedInfo.memoryDescription,
        architecture: this.getArchitecture(),
        os: await this.getOsVersion(),
        cpuCount: await this.getCpuCount(),
        cpuModel: await this.getCpuThreads(),
        cpuTemperature: await this.getCpuTemperature(systemType, logger),
        systemUptime: await this.getSystemUptime(systemType),
        totalMemory: enhancedInfo.detailedTotalMemory || totalMemory,
        freeMemory: freeMemory,
        totalStorage: totalStorage,
        freeStorage: freeStorage,
        adbEnabled: await this.isAdbEnabled(systemType),
        suAvailable: await this.isSuAvailable(systemType),
        hardwareDetectionMethod: 'lshw'
      };
      
    } catch (error) {
      const now = Date.now();
      if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
        log(
          `lshw not available or failed, using basic detection: ${error instanceof Error ? error.message : String(error)}`,
          'WARN',
          'hardware',
        );
        this.lastTemperatureLogAt = now;
      }
      return {
        hardwareDetectionMethod: 'basic'
      };
    }
  }

  /** ✅ Parse lshw output for enhanced hardware info */
  private static parseLshwOutput(lshwOutput: string, log: (message: string, level: string, category: string) => void): any {
    const lines = lshwOutput.split('\n');
    const hwInfo: any = {};
    
    log(`Parsing lshw output with ${lines.length} lines`, 'DEBUG', 'hardware');
    
    lines.forEach(line => {
      const trimmedLine = line.trim();
      
      // System info (motherboard/laptop model)
      if (trimmedLine.includes('system') && !hwInfo.hwModel) {
        const systemMatch = trimmedLine.match(/system\s+(.+)/);
        if (systemMatch && systemMatch[1]) {
          const systemInfo = systemMatch[1].trim();
          hwInfo.systemDescription = systemInfo;
          
          // Extract brand and model from system string
          if (systemInfo.includes('LENOVO')) {
            hwInfo.hwBrand = 'Lenovo';
            // Extract model number (20EGS01T08 from "20EGS01T08 (LENOVO_MT_20EG)")
            const modelMatch = systemInfo.match(/^([A-Z0-9]+)/);
            if (modelMatch) {
              hwInfo.hwModel = modelMatch[1];
            } else {
              hwInfo.hwModel = systemInfo.replace(/LENOVO[_\s]*MT[_\s]*/, '').replace(/[()]/g, '').trim();
            }
          } else if (systemInfo.includes('DELL')) {
            hwInfo.hwBrand = 'Dell';
            hwInfo.hwModel = systemInfo.replace('DELL', '').trim();
          } else if (systemInfo.includes('HP')) {
            hwInfo.hwBrand = 'HP';
            hwInfo.hwModel = systemInfo.replace('HP', '').trim();
          } else {
            // Try to extract brand from first word
            const parts = systemInfo.split(/[\s_()]+/).filter(p => p.length > 0);
            if (parts.length > 1) {
              hwInfo.hwBrand = parts[0];
              hwInfo.hwModel = parts.slice(1).join(' ');
            } else {
              hwInfo.hwModel = systemInfo;
            }
          }
          
          log(`Detected system: Brand=${hwInfo.hwBrand}, Model=${hwInfo.hwModel}`, 'DEBUG', 'hardware');
        }
      }
      
      // Processor info
      if (trimmedLine.includes('processor') && !hwInfo.detailedCpuModel) {
        const cpuMatch = trimmedLine.match(/processor\s+(.+)/);
        if (cpuMatch && cpuMatch[1]) {
          hwInfo.detailedCpuModel = cpuMatch[1].trim();
          log(`Detected processor: ${hwInfo.detailedCpuModel}`, 'DEBUG', 'hardware');
        }
      }
      
      // Memory info - look for "System Memory"
      if (trimmedLine.includes('System Memory')) {
        const memoryMatch = trimmedLine.match(/(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB)/);
        if (memoryMatch) {
          const value = parseFloat(memoryMatch[1]);
          const unit = memoryMatch[2];
          
          // Convert to bytes
          let memoryBytes = value;
          switch (unit) {
            case 'KiB': memoryBytes *= 1024; break;
            case 'MiB': memoryBytes *= 1024 * 1024; break;
            case 'GiB': memoryBytes *= 1024 * 1024 * 1024; break;
            case 'TiB': memoryBytes *= 1024 * 1024 * 1024 * 1024; break;
          }
          
          hwInfo.detailedTotalMemory = Math.round(memoryBytes);
          hwInfo.memoryDescription = `${value} ${unit}`;
          log(`Detected memory: ${hwInfo.memoryDescription}`, 'DEBUG', 'hardware');
        }
      }
      
      // Storage info (primary disk)
      if (trimmedLine.includes('/dev/sda') && trimmedLine.includes('disk') && !hwInfo.primaryStorage) {
        const storageMatch = trimmedLine.match(/disk\s+(.+)/);
        if (storageMatch && storageMatch[1]) {
          hwInfo.primaryStorage = storageMatch[1].trim();
          log(`Detected primary storage: ${hwInfo.primaryStorage}`, 'DEBUG', 'hardware');
        }
      }
      
      // Graphics info - look for display devices
      if (trimmedLine.includes('display') && !hwInfo.graphicsCard) {
        const gpuMatch = trimmedLine.match(/display\s+(.+)/);
        if (gpuMatch && gpuMatch[1]) {
          hwInfo.graphicsCard = gpuMatch[1].trim();
          log(`Detected graphics: ${hwInfo.graphicsCard}`, 'DEBUG', 'hardware');
        }
      }
      
      // Network info - look for network devices
      if (trimmedLine.includes('network') && !hwInfo.networkController) {
        const networkMatch = trimmedLine.match(/network\s+(.+)/);
        if (networkMatch && networkMatch[1]) {
          hwInfo.networkController = networkMatch[1].trim();
          log(`Detected network: ${hwInfo.networkController}`, 'DEBUG', 'hardware');
        }
      }
    });
    
    return hwInfo;
  }

  /** ✅ Get system uptime in seconds */
  static async getSystemUptime(systemType: string): Promise<number> {
    try {
      // Method 1: Use Node.js os.uptime() (works on most systems)
      const nodeUptime = os.uptime();

      // For most systems, Node's os.uptime() is reliable
      if (nodeUptime > 0) {
        return Math.floor(nodeUptime);
      }

      // Method 2: For Termux/Linux, try using the 'uptime' command
      if (
        systemType === 'termux' ||
        systemType === 'linux' ||
        systemType === 'raspberry-pi'
      ) {
        // Get uptime in seconds from 'uptime -s' which returns the boot time
        const uptimeOutput = (await this.execCommand('uptime -p')).trim();

        // Parse "up X days, Y hours, Z minutes" format
        const days = uptimeOutput.match(/(\d+) day/);
        const hours = uptimeOutput.match(/(\d+) hour/);
        const minutes = uptimeOutput.match(/(\d+) minute/);

        let totalSeconds = 0;
        if (days) totalSeconds += parseInt(days[1]) * 86400;
        if (hours) totalSeconds += parseInt(hours[1]) * 3600;
        if (minutes) totalSeconds += parseInt(minutes[1]) * 60;

        if (totalSeconds > 0) {
          return totalSeconds;
        }
      }

      // Method 3: For Linux/RPi, try reading /proc/uptime
      if (await this.fileExists('/proc/uptime')) {
        const uptimeContent = (await this.readFile('/proc/uptime')).split(' ')[0];
        const uptime = parseFloat(uptimeContent);
        if (!isNaN(uptime)) {
          return Math.floor(uptime);
        }
      }

      // If all methods fail, return Node's uptime or 0
      return Math.floor(nodeUptime) || 0;
    } catch (error) {
      console.error(`❌ Failed to get system uptime: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to Node.js uptime
      return Math.floor(os.uptime()) || 0;
    }
  }

  /** ✅ Get hardware brand */
  static async getBrand(systemType: string): Promise<string> {
    try {
      if (process.platform === 'win32') {
        const output = (await this.execCommand(
          'powershell -Command "Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object -First 1 -ExpandProperty Manufacturer"',
          5000,
        )).trim();
        return output || 'Unknown';
      }
      if (systemType === 'termux') {
        return await this.runCommandWithSuFallback('getprop ro.product.brand');
      }
      
      // Enhanced Allwinner/Radxa detection using device-tree compatible
      if (await this.fileExists('/proc/device-tree/compatible')) {
        try {
          const compatibleData = await this.readFile('/proc/device-tree/compatible');
          const compatibleEntries = compatibleData.split('\0').filter(entry => entry.length > 0);
          
          for (const entry of compatibleEntries) {
            if (entry.includes('allwinner')) {
              // Check if it's a Radxa device with Allwinner chip
              if (await this.fileExists('/proc/device-tree/model')) {
                const modelData = await this.readFileTrim('/proc/device-tree/model');
                // For Radxa devices, even with Allwinner chips, we want to identify as Radxa
                if (process.env.HOSTNAME && process.env.HOSTNAME.includes('radxa')) {
                  return 'Radxa';
                }
                // Check for sun55iw3 which indicates Allwinner H618 used in some Radxa boards
                if (modelData.includes('sun55iw3')) {
                  return 'Radxa'; // Radxa device with Allwinner H618
                }
              }
              return 'Allwinner';
            }
            if (entry.includes('rockchip')) {
              return 'Rockchip';
            }
            if (entry.includes('broadcom')) {
              return 'Broadcom';
            }
          }
        } catch (e) {
          // Continue with other detection methods if this fails
        }
      }
      
      // Enhanced Radxa and ARM board detection
      if (await this.fileExists('/sys/firmware/devicetree/base/model')) {
        const modelContent = (await this.readFileTrim('/sys/firmware/devicetree/base/model')).replace(/\0/g, '');
        
        // Check for Radxa devices
        if (modelContent.toLowerCase().includes('radxa') || modelContent.toLowerCase().includes('rock')) {
          return 'Radxa';
        }
        
        // Check for Raspberry Pi
        if (modelContent.toLowerCase().includes('raspberry')) {
          return 'Raspberry Pi Foundation';
        }
        
        // Check for Orange Pi
        if (modelContent.toLowerCase().includes('orange')) {
          return 'Orange Pi';
        }
        
        // Check for other common ARM board manufacturers
        if (modelContent.toLowerCase().includes('rockchip')) {
          return 'Rockchip';
        }
        
        // For unknown SoC identifiers like SUN55IW3, try other detection methods
        if (modelContent.match(/^[A-Z0-9]+$/)) {
          // This looks like a SoC identifier, try alternative detection
          return await this.detectBrandFromSystem();
        }
        
        // Fallback to first word if it looks like a brand name
        const firstWord = modelContent.split(/\s+/)[0].trim();
        if (firstWord.length > 2 && !firstWord.match(/^[A-Z0-9]+$/)) {
          return firstWord;
        }
      }
      
      // Try alternative detection methods
      return await this.detectBrandFromSystem();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Alternative brand detection from system files and commands */
  private static async detectBrandFromSystem(): Promise<string> {
    try {
      // Try DMI information (works on many x86 and some ARM systems)
      if (await this.fileExists('/sys/class/dmi/id/board_vendor')) {
        const vendor = await this.readFileTrim('/sys/class/dmi/id/board_vendor');
        if (vendor && vendor !== 'To be filled by O.E.M.' && vendor !== 'Unknown') {
          return vendor;
        }
      }
      
      // Try system vendor
      if (await this.fileExists('/sys/class/dmi/id/sys_vendor')) {
        const vendor = await this.readFileTrim('/sys/class/dmi/id/sys_vendor');
        if (vendor && vendor !== 'To be filled by O.E.M.' && vendor !== 'Unknown') {
          return vendor;
        }
      }
      
      // Try lsb_release as final fallback
      return (await this.execCommand('lsb_release -si')).trim();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Get hardware model */
  static async getModel(systemType: string): Promise<string> {
    try {
      if (process.platform === 'win32') {
        const output = (await this.execCommand(
          'powershell -Command "Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object -First 1 -ExpandProperty Model"',
          5000,
        )).trim();
        return output || 'Unknown';
      }
      if (systemType === 'termux') {
        // Use hardware-specific properties first for more accurate detection
        // These are less likely to be affected by custom ROMs
        // Ordered by user-friendliness: shorter, cleaner names first
        const hardwareProperties = [
          'ro.boot.product.model',
          'ro.boot.em.model',
          'ril.product_code',
          'vendor.ril.product_code'
        ];
        
        // Try hardware-specific properties first
        for (const prop of hardwareProperties) {
          try {
            const model = await this.runCommandWithSuFallback(`getprop ${prop}`);
            if (model && model !== '' && !model.includes('no such property')) {
              return model;
            }
          } catch {
            // Continue to next property
          }
        }
        
        // Fallback to standard properties if hardware-specific ones fail
        const standardProperties = [
          'ro.product.model',
          'ro.product.device',
          'ro.product.name'
        ];
        
        for (const prop of standardProperties) {
          try {
            const model = await this.runCommandWithSuFallback(`getprop ${prop}`);
            if (model && model !== '') {
              return model;
            }
          } catch {
            // Continue to next property
          }
        }
        
        // Final fallback
        return 'Unknown Android Device';
      }
      
      // Enhanced Allwinner device model detection using device-tree compatible
      if (await this.fileExists('/proc/device-tree/compatible')) {
        try {
          const compatibleData = await this.readFile('/proc/device-tree/compatible');
          const compatibleEntries = compatibleData.split('\0').filter(entry => entry.length > 0);
          
          for (const entry of compatibleEntries) {
            if (entry.includes('allwinner')) {
              // Check the model file for specific SoC information
              if (await this.fileExists('/proc/device-tree/model')) {
                const modelData = await this.readFileTrim('/proc/device-tree/model');
                
                // Map Allwinner SoC identifiers to proper model names
                if (modelData.includes('sun55iw3')) {
                  // H618 SoC - check for specific board
                  if (process.env.HOSTNAME && process.env.HOSTNAME.includes('radxa')) {
                    return 'Cubie A5E'; // Radxa board with H618
                  }
                  return 'H618'; // Generic H618 board
                }
                
                // Check for other Allwinner SoCs
                if (entry.includes('sun50i')) {
                  return 'H6/H616 Series';
                }
                if (entry.includes('sun8i')) {
                  return 'H3/H5 Series';
                }
                
                // If we have a proper model name in the entry, use it
                const allwinnerMatch = entry.match(/allwinner,(.+)/);
                if (allwinnerMatch) {
                  const modelName = allwinnerMatch[1].replace(/-/g, ' ').toUpperCase();
                  return modelName;
                }
              }
            }
          }
        } catch (e) {
          // Continue with other detection methods if this fails
        }
      }
      
      // Enhanced ARM board model detection
      if (await this.fileExists('/sys/firmware/devicetree/base/model')) {
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
                  return model;
                }
              }
            }
          }
          
          // Fallback to parsing the model string directly
          if (modelContent.toLowerCase().includes('radxa')) {
            return modelContent;
          }
          
          // If we detect it's a Radxa but can't get specific model, try alternative detection
          return await this.detectRadxaModel();
        }
        
        // For other devices, clean up the model content
        if (modelContent && !modelContent.match(/^[A-Z0-9]+$/)) {
          return modelContent;
        }
        
        // If model content looks like SoC identifier, try alternative detection
        if (modelContent.match(/^[A-Z0-9]+$/)) {
          return await this.detectModelFromSystem();
        }
      }
      
      // Try alternative detection methods
      return await this.detectModelFromSystem();
    } catch {
      return 'Unknown';
    }
  }

  /** ✅ Detect Radxa model from system information */
  private static async detectRadxaModel(): Promise<string> {
    try {
      // Enhanced detection for Allwinner-based Radxa devices
      if (await this.fileExists('/proc/cpuinfo')) {
        const cpuInfo = await this.readFile('/proc/cpuinfo');
        
        // Look for CPU part information to identify specific ARM cores
        const cpuPartMatch = cpuInfo.match(/CPU part\s*:\s*0x([a-fA-F0-9]+)/);
        if (cpuPartMatch) {
          const cpuPart = cpuPartMatch[1].toLowerCase();
          // 0xd05 is Cortex-A55, commonly used in Allwinner H618 (Radxa Cubie A5E)
          if (cpuPart === 'd05') {
            // Check for sun55iw3 identifier which is specific to H618
            if (await this.fileExists('/proc/device-tree/model')) {
              const modelData = await this.readFileTrim('/proc/device-tree/model');
              if (modelData.includes('sun55iw3')) {
                return 'Cubie A5E'; // H618-based Radxa board
              }
            }
            
            // Check device-tree compatible for Allwinner confirmation
            if (await this.fileExists('/proc/device-tree/compatible')) {
              const compatibleData = await this.readFile('/proc/device-tree/compatible');
              if (compatibleData.includes('allwinner')) {
                return 'Cubie A5E'; // Allwinner H618 in Radxa device
              }
            }
          }
        }
        
        // Legacy hardware field check
        const hardwareMatch = cpuInfo.match(/Hardware\s*:\s*(.+)/i);
        if (hardwareMatch) {
          const hardware = hardwareMatch[1].trim();
          // Map common Radxa SoC identifiers to models
          if (hardware.includes('SUN55IW3')) {
            return 'Cubie A5E'; // Based on your telemetry data
          }
        }
      }
      
      // Try board name from DMI
      if (await this.fileExists('/sys/class/dmi/id/board_name')) {
        const boardName = await this.readFileTrim('/sys/class/dmi/id/board_name');
        if (boardName && boardName !== 'Unknown') {
          return boardName;
        }
      }
      
      return 'Unknown Radxa Model';
    } catch {
      return 'Unknown Radxa Model';
    }
  }

  /** ✅ Alternative model detection from system files */
  private static async detectModelFromSystem(): Promise<string> {
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

  /** ✅ Get CPU architecture */
  static getArchitecture(): string {
    return os.arch();
  }

  /** ✅ Get OS version */
  static async getOsVersion(): Promise<string> {
    try {
      if (process.platform === 'win32') {
        const output = (await this.execCommand(
          'powershell -Command "Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1 | ConvertTo-Json -Compress"',
          5000,
        )).trim();
        if (output) {
          const data = JSON.parse(output);
          const caption = data.Caption || 'Windows';
          const version = data.Version || '';
          const build = data.BuildNumber ? `Build ${data.BuildNumber}` : '';
          return [caption, version, build].filter(Boolean).join(' ');
        }
      }
      if (process.env.TERMUX_VERSION) {
        // We're in Termux, get Android version
        const releaseVer = await this.runCommandWithSuFallback(
          'getprop ro.build.version.release',
        );
        const sdkVer = await this.runCommandWithSuFallback(
          'getprop ro.build.version.sdk',
        );
        return `Android ${releaseVer} (API ${sdkVer})`;
      }

      // Check for /etc/os-release first (Linux/RPi)
      if (await this.fileExists('/etc/os-release')) {
        const osRelease = await this.readFile('/etc/os-release');
        const prettyName = osRelease
          .split('\n')
          .find((line) => line.startsWith('PRETTY_NAME='))
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
  static async getCpuCount(): Promise<number> {
    try {
      if (process.platform === 'win32') {
        return os.cpus().length;
      }
      return parseInt(
        (await this.execCommand("lscpu | grep '^CPU(s):' | awk '{print $2}'")).trim(),
      );
    } catch {
      return os.cpus().length;
    }
  }

  /** ✅ Get CPU thread details (using `lscpu`) */
  static async getCpuThreads(): Promise<Array<any>> {
    try {
      if (process.platform === 'win32') {
        return os.cpus().map((cpu, index) => ({
          model: cpu.model || `CPU ${index}`,
          coreId: index,
          maxMHz: cpu.speed || 0,
          minMHz: Math.floor((cpu.speed || 0) * 0.3),
          hashrate: 0,
        }));
      }
      // Get raw lscpu output
      const output = (await this.execCommand('lscpu')).split('\n');
      const threadList: any[] = [];

      // Try to get CPU details with better parsing
      const modelNames = output
        .filter((line) => line.includes('Model name'))
        .map((line) => line.split(':')[1]?.trim())
        .filter(Boolean);

      const maxMHzList = output
        .filter((line) => line.includes('CPU max MHz'))
        .map((line) => parseFloat(line.split(':')[1]?.trim() || '0'));

      const minMHzList = output
        .filter((line) => line.includes('CPU min MHz'))
        .map((line) => parseFloat(line.split(':')[1]?.trim() || '0'));

      // Get total CPU count
      const cores = parseInt(
        output
          .find((l) => l.includes('CPU(s):'))
          ?.split(':')[1]
          ?.trim() || os.cpus().length.toString(),
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
              hashrate: 0, // Will be updated with actual mining data
            });
          }
        });
      } else {
        // Single CPU type
        const model =
          modelNames[0] || this.extractTextValue(output, 'Model name');
        const maxMHz =
          maxMHzList[0] || this.extractValue(output, 'CPU max MHz');
        const minMHz =
          minMHzList[0] || this.extractValue(output, 'CPU min MHz');

        for (let i = 0; i < cores; i++) {
          threadList.push({
            model: model || `CPU ${i}`,
            coreId: i,
            maxMHz: maxMHz || 0,
            minMHz: minMHz || 0,
            hashrate: 0, // Will be updated with actual mining data
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
        hashrate: 0,
      }));
    }
  }

  /** ✅ Extract text value from lscpu output */
  private static extractTextValue(output: string[], key: string): string {
    try {
      const line = output.find((l) => l.trim().startsWith(key + ':'));
      return line ? line.split(':')[1].trim() : '';
    } catch {
      return '';
    }
  }

  /** ✅ Extract numeric value from lscpu output */
  private static extractValue(output: string[], key: string): number {
    try {
      const line = output.find((l) => l.trim().startsWith(key + ':'));
      if (!line) return 0;
      const value = line.split(':')[1].trim();
      return parseFloat(value) || 0;
    } catch {
      return 0;
    }
  }

  /** ✅ Get CPU Temperature Based on OS */
  static async getCpuTemperature(systemType: string, logger?: (message: string, level: string, category: string) => void): Promise<number> {
    const log = logger || (() => {}); // No-op if no logger provided
    
    log(`Getting CPU temperature for system type: ${systemType}`, 'DEBUG', 'hardware');
    try {
      if (process.platform === 'win32') {
        return await this.getWindowsCpuTemperature(log);
      }
      switch (systemType) {
        case 'raspberry-pi':
          log('Using Raspberry Pi temperature method', 'DEBUG', 'hardware');
          return await this.getVcgencmdTemperature(log);
        case 'termux':
          log('Using Termux temperature method', 'DEBUG', 'hardware');
          return await this.getTermuxCpuTemperature(log);
        case 'linux':
          log('Using Linux temperature method', 'DEBUG', 'hardware');
          return await this.getLinuxCpuTemperature(log);
        default:
          log(`Unknown system type: ${systemType}, returning 0`, 'DEBUG', 'hardware');
          return 0;
      }
    } catch (error) {
      log(`Failed to get CPU temperature: ${error instanceof Error ? error.message : String(error)}`, 'ERROR', 'hardware');
      return 0;
    }
  }

  /** ✅ Windows: Get CPU temperature via WMI (if available) */
  private static async getWindowsCpuTemperature(log: (message: string, level: string, category: string) => void): Promise<number> {
    try {
      const output = (await this.execCommand(
        'powershell -Command "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1 -ExpandProperty CurrentTemperature"',
        5000,
      )).trim();

      const rawValue = parseFloat(output);
      if (!isNaN(rawValue) && rawValue > 0) {
        // WMI temperature is in tenths of Kelvin
        return Math.round((rawValue / 10 - 273.15) * 10) / 10;
      }
    } catch (error) {
      log(
        `Windows temperature read failed: ${error instanceof Error ? error.message : String(error)}`,
        'DEBUG',
        'hardware',
      );
    }
    return 0;
  }

  /** ✅ Helper function to determine if error should be suppressed based on environment */
  private static shouldSuppressError(systemType: string, errorMessage: string): boolean {
    // Common errors that are expected in restricted environments
    const expectedErrors = [
      'permission denied',
      'not found',
      'no such file or directory',
      'command not found',
      'eacces',
      'enoent',
    ];

    const lowerErrorMessage = errorMessage.toLowerCase();
    
    // Always suppress expected permission/availability errors in Termux
    if (systemType === 'termux') {
      return expectedErrors.some(pattern => lowerErrorMessage.includes(pattern));
    }
    
    // For other systems, only suppress very common expected errors
    return expectedErrors.slice(0, 3).some(pattern => lowerErrorMessage.includes(pattern));
  }

  /** ✅ Helper function to log errors conditionally */
  private static logConditionalError(
    systemType: string,
    errorMessage: string,
    log: (message: string, level: string, category: string) => void,
    context: string = '',
    level: 'WARN' | 'ERROR' = 'WARN'
  ): void {
    if (!this.shouldSuppressError(systemType, errorMessage)) {
      const fullMessage = context ? `${context}: ${errorMessage}` : errorMessage;
      log(fullMessage, level, 'hardware');
    }
  }

  /** ✅ Raspberry Pi: Get CPU Temp via vcgencmd */
  private static async getVcgencmdTemperature(log: (message: string, level: string, category: string) => void): Promise<number> {
    try {
      if (await this.fileExists(this.VCGENCMD_PATH)) {
        await this.execCommand(`chmod +x ${this.VCGENCMD_PATH}`);
        const tempOutput = await this.execCommand(`${this.VCGENCMD_PATH} measure_temp`);
        const match = tempOutput.match(/temp=([\d.]+)/);
        if (match) return parseFloat(match[1]);
      }
      return await this.getLinuxCpuTemperature(log);
    } catch (error) {
      log(
        `Failed to get Raspberry Pi temperature: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'hardware',
      );
      return await this.getLinuxCpuTemperature(log);
    }
  }

  /** ✅ Termux: Robust CPU temperature detection (with proper permission handling) */
  private static async getTermuxCpuTemperature(log: (message: string, level: string, category: string) => void): Promise<number> {
    const now = Date.now();
    if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
      log('Starting Termux temperature detection...', 'DEBUG', 'hardware');
      this.lastTemperatureLogAt = now;
    }
    
    try {
      // Method 1: Try vcgencmd with root first (for some rooted devices)
      if (await this.isSuAvailable('termux') && await this.fileExists(this.VCGENCMD_PATH)) {
        try {
          if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
            log('Trying vcgencmd with root...', 'DEBUG', 'hardware');
            this.lastTemperatureLogAt = now;
          }
          await this.execCommand(`chmod +x ${this.VCGENCMD_PATH}`);
          const tempOutput = await this.execCommand(
            `su -c "${this.VCGENCMD_PATH} measure_temp"`,
          );
          const match = tempOutput.match(/temp=([\d.]+)/);
          if (match) {
            const temp = parseFloat(match[1]);
            const now = Date.now();
            if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
              log(`vcgencmd temperature: ${temp}°C`, 'DEBUG', 'hardware');
              this.lastTemperatureLogAt = now;
            }
            return temp;
          }
        } catch (vcgencmdError) {
          log(`vcgencmd failed: ${vcgencmdError instanceof Error ? vcgencmdError.message : String(vcgencmdError)}`, 'WARN', 'hardware');
        }
      }

      // Method 2: Try reading thermal zones with root access first
      if (await this.isSuAvailable('termux')) {
        try {
          if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
            log('Trying thermal zones with root access...', 'DEBUG', 'hardware');
            this.lastTemperatureLogAt = now;
          }
          
          // Try to list thermal zones with root
          const zonesOutput = (await this.execCommand(
            'su -c "ls /sys/class/thermal/ 2>/dev/null | grep thermal_zone"',
          )).trim();
          if (zonesOutput) {
            const zones = zonesOutput
              .split('\n')
              .filter((z) => z.startsWith('thermal_zone'));
            log(
              `Found ${zones.length} thermal zones with root: ${zones.join(', ')}`,
              'DEBUG',
              'hardware',
            );
            
            const cpuTemps: number[] = [];
            
            for (const zone of zones) {
              try {
                // Try to read type and temperature with root
                const typeOutput = (await this.execCommand(
                  `su -c "cat /sys/class/thermal/${zone}/type 2>/dev/null"`,
                ))
                  .trim()
                  .toLowerCase();
                if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
                  log(`Zone ${zone} type: ${typeOutput}`, 'DEBUG', 'hardware');
                  this.lastTemperatureLogAt = now;
                }
                
                // Skip non-CPU sensors
                if (
                  typeOutput.includes('bms') ||
                  typeOutput.includes('battery') ||
                  typeOutput.includes('chg') ||
                  typeOutput.includes('case') ||
                  typeOutput.includes('pmic') ||
                  typeOutput.includes('xo_therm') ||
                  typeOutput.includes('gpu')
                ) {
                  log(
                    `Skipping non-CPU sensor: ${typeOutput}`,
                    'DEBUG',
                    'hardware',
                  );
                  continue;
                }

                const tempRaw = (await this.execCommand(
                  `su -c "cat /sys/class/thermal/${zone}/temp 2>/dev/null"`,
                )).trim();
                let temp = parseInt(tempRaw);

                if (typeOutput.includes('tsens')) {
                  temp = temp / 10; // deci-degrees for tsens sensors (Xiaomi/Qualcomm)
                } else if (temp > 1000) {
                  temp = temp / 1000; // milli-degrees for Samsung/Exynos
                }

                log(
                  `Zone ${zone} (${typeOutput}): ${temp}°C`,
                  'DEBUG',
                  'hardware',
                );
                
                if (!isNaN(temp) && temp > 0 && temp < 150) {
                  cpuTemps.push(temp);
                }
              } catch (zoneError) {
                log(
                  `Failed to read zone ${zone}: ${zoneError instanceof Error ? zoneError.message : String(zoneError)}`,
                  'WARN',
                  'hardware',
                );
                continue;
              }
            }

            if (cpuTemps.length > 0) {
              const maxTemp = Math.max(...cpuTemps);
              log(
                `Using max CPU temperature from thermal zones: ${maxTemp}°C`,
                'INFO',
                'hardware',
              );
              return maxTemp;
            }
          }
        } catch (rootThermalError) {
          log(
            `Root thermal access failed: ${rootThermalError instanceof Error ? rootThermalError.message : String(rootThermalError)}`,
            'WARN',
            'hardware',
          );
        }
      }

      // Method 3: Try reading thermal zones without root (limited access)
      try {
        log('Trying thermal zones without root...', 'DEBUG', 'hardware');
        const basePath = '/sys/class/thermal';
        
        // Check if we can access the directory at all
        if (await this.fileExists(basePath)) {
          try {
            const zones = (await this.readDir(basePath)).filter((z) => z.startsWith('thermal_zone'));
            log(`Found ${zones.length} thermal zones without root: ${zones.join(', ')}`, 'DEBUG', 'hardware');
            
            let cpuTemps: number[] = [];

            for (const zone of zones) {
              try {
                const typePath = path.join(basePath, zone, 'type');
                const tempPath = path.join(basePath, zone, 'temp');
                
                if (await this.fileExists(typePath) && await this.fileExists(tempPath)) {
                  const type = (await this.readFileTrim(typePath)).toLowerCase();
                  if (!this.lastTemperatureLogAt || now - this.lastTemperatureLogAt > this.TEMPERATURE_LOG_TTL) {
                    log(`Zone ${zone} type (no-root): ${type}`, 'DEBUG', 'hardware');
                    this.lastTemperatureLogAt = now;
                  }
                  
                  // Skip non-CPU sensors
                  if (
                    type.includes('bms') ||
                    type.includes('battery') ||
                    type.includes('chg') ||
                    type.includes('case') ||
                    type.includes('pmic') ||
                    type.includes('xo_therm') ||
                    type.includes('gpu')
                  ) {
                    log(`Skipping non-CPU sensor: ${type}`, 'DEBUG', 'hardware');
                    continue;
                  }

                  const tempRaw = await this.readFileTrim(tempPath);
                  let temp = parseInt(tempRaw);

                  if (type.includes('tsens')) {
                    temp = temp / 10; // deci-degrees for tsens sensors (Xiaomi/Qualcomm)
                  } else if (temp > 1000) {
                    temp = temp / 1000; // milli-degrees for Samsung/Exynos
                  }

                  log(`Zone ${zone} (${type}): ${temp}°C`, 'DEBUG', 'hardware');

                  if (!isNaN(temp) && temp > 0 && temp < 150) {
                    cpuTemps.push(temp);
                  }
                }
              } catch (zoneReadError) {
                log(`Failed to read zone ${zone}: ${zoneReadError instanceof Error ? zoneReadError.message : String(zoneReadError)}`, 'WARN', 'hardware');
                continue;
              }
            }

            if (cpuTemps.length > 0) {
              const maxTemp = Math.max(...cpuTemps);
              log(`Using max CPU temperature from thermal zones (no-root): ${maxTemp}°C`, 'INFO', 'hardware');
              return maxTemp;
            }
          } catch (thermalScanError) {
            this.logConditionalError(
              'termux',
              thermalScanError instanceof Error ? thermalScanError.message : String(thermalScanError),
              log,
              'Failed to scan thermal directory'
            );
          }
        }
      } catch (thermalAccessError) {
        log(`Cannot access thermal zones: ${thermalAccessError instanceof Error ? thermalAccessError.message : String(thermalAccessError)}`, 'WARN', 'hardware');
      }

      // Method 4: Try individual thermal zone files with root (fallback)
      if (await this.isSuAvailable('termux')) {
        log('Trying individual thermal zone files with root...', 'DEBUG', 'hardware');
        for (let i = 0; i < 10; i++) {
          try {
            const tempRaw = (await this.execCommand(
              `su -c "cat /sys/class/thermal/thermal_zone${i}/temp 2>/dev/null"`,
            )).trim();
            
            if (tempRaw) {
              let temp = parseInt(tempRaw);
              if (temp > 1000) temp = temp / 1000; // Convert from millidegrees
              
              log(`Thermal zone ${i}: ${temp}°C`, 'DEBUG', 'hardware');
              
              if (!isNaN(temp) && temp > 0 && temp < 150) {
                log(`Using thermal zone ${i} temperature: ${temp}°C`, 'INFO', 'hardware');
                return temp;
              }
            }
          } catch {
            // Continue to next zone
            continue;
          }
        }
      }

      // Method 5: Fallback to Linux method (might work on some Termux setups)
      log('Falling back to Linux temperature detection...', 'DEBUG', 'hardware');
      return await this.getLinuxCpuTemperature(log);
      
    } catch (error) {
      log(
        `Failed to get Termux temperature: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'hardware',
      );
      return 0;
    }
  }

  /** ✅ Linux: Default Method for CPU Temperature with better fallbacks and debugging */
  private static async getLinuxCpuTemperature(log: (message: string, level: string, category: string) => void): Promise<number> {
    try {
      log('Starting Linux CPU temperature detection...', 'DEBUG', 'hardware');

      // Method 1: Try thermal zone (most reliable for most systems)
      if (await this.fileExists('/sys/class/thermal/thermal_zone0/temp')) {
        try {
          const tempRaw = (await this.execCommand(
            'cat /sys/class/thermal/thermal_zone0/temp',
          )).trim();
          const temp = parseInt(tempRaw) / 1000;
          log(`Thermal zone 0: ${temp}°C`, 'DEBUG', 'hardware');
          if (!isNaN(temp) && temp > 0 && temp < 150) {
            log(
              `Using thermal zone 0 temperature: ${temp}°C`,
              'INFO',
              'hardware',
            );
            return temp;
          }
        } catch (thermalError) {
          log(
            `Thermal zone 0 failed: ${thermalError instanceof Error ? thermalError.message : String(thermalError)}`,
            'WARN',
            'hardware',
          );
        }
      }

      // Method 2: Try other thermal zones (1-9)
      for (let i = 1; i < 10; i++) {
        const zonePath = `/sys/class/thermal/thermal_zone${i}/temp`;
        if (await this.fileExists(zonePath)) {
          try {
            const tempRaw = (await this.execCommand(`cat ${zonePath}`)).trim();
            const temp = parseInt(tempRaw) / 1000;
            log(`Thermal zone ${i}: ${temp}°C`, 'DEBUG', 'hardware');
            if (!isNaN(temp) && temp > 0 && temp < 150) {
              log(
                `Using thermal zone ${i} temperature: ${temp}°C`,
                'INFO',
                'hardware',
              );
              return temp;
            }
          } catch {
            continue;
          }
        }
      }

      // Method 3: Try sensors command (lm-sensors package) - Enhanced parsing with debugging
      try {
        log('Trying sensors command...', 'DEBUG', 'hardware');
        const sensorsOutput = (await this.execCommand('sensors')).trim();
        log(
          `Sensors output length: ${sensorsOutput.length} characters`,
          'DEBUG',
          'hardware',
        );

        // Priority 1: AMD k10temp Tctl (most accurate for AMD CPUs)
        const tctlMatch = sensorsOutput.match(/Tctl:\s*\+?(\d+\.\d+)°C/);
        if (tctlMatch && tctlMatch[1]) {
          const temp = parseFloat(tctlMatch[1]);
          log(`Found AMD Tctl: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using AMD Tctl temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Priority 2: Intel Package temperature
        const packageMatch = sensorsOutput.match(
          /Package id \d+:\s*\+?(\d+\.\d+)°C/,
        );
        if (packageMatch && packageMatch[1]) {
          const temp = parseFloat(packageMatch[1]);
          log(`Found Intel Package: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(
              `Using Intel Package temperature: ${temp}°C`,
              'INFO',
              'hardware',
            );
            return temp;
          }
        }

        // Priority 3: TSI0_TEMP (AMD motherboard sensor)
        const tsi0Match = sensorsOutput.match(/TSI0_TEMP:\s*\+?(\d+\.\d+)°C/);
        if (tsi0Match && tsi0Match[1]) {
          const temp = parseFloat(tsi0Match[1]);
          log(`Found TSI0_TEMP: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using TSI0_TEMP temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Priority 4: CPUTIN (motherboard CPU sensor)
        const cputinMatch = sensorsOutput.match(/CPUTIN:\s*\+?(\d+\.\d+)°C/);
        if (cputinMatch && cputinMatch[1]) {
          const temp = parseFloat(cputinMatch[1]);
          log(`Found CPUTIN: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using CPUTIN temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Priority 5: Core temperature (Intel)
        const coreMatch = sensorsOutput.match(/Core \d+:\s*\+?(\d+\.\d+)°C/);
        if (coreMatch && coreMatch[1]) {
          const temp = parseFloat(coreMatch[1]);
          log(`Found Core temp: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using Core temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Priority 6: Any other CPU-related temperature
        const cpuTempMatch = sensorsOutput.match(
          /CPU[^:]*:\s*\+?(\d+\.\d+)°C/i,
        );
        if (cpuTempMatch && cpuTempMatch[1]) {
          const temp = parseFloat(cpuTempMatch[1]);
          log(`Found CPU temp: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using CPU temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Debug: Show what patterns we're looking for vs what we found
        log(
          'Searching for temperature patterns in sensors output...',
          'DEBUG',
          'hardware',
        );
        const tempLines = sensorsOutput
          .split('\n')
          .filter((line) => line.includes('°C'));
        log(`Found ${tempLines.length} temperature lines:`, 'DEBUG', 'hardware');
        tempLines.forEach((line, index) => {
          log(`Temp line ${index + 1}: ${line.trim()}`, 'DEBUG', 'hardware');
        });

        // Priority 7: Processor temperature
        const processorMatch = sensorsOutput.match(
          /Processor[^:]*:\s*\+?(\d+\.\d+)°C/i,
        );
        if (processorMatch && processorMatch[1]) {
          const temp = parseFloat(processorMatch[1]);
          log(`Found Processor temp: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using Processor temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        // Priority 8: Any temperature that looks like a main sensor (first one found)
        const anyTempMatch = sensorsOutput.match(
          /^\s*[^:]+:\s*\+?(\d+\.\d+)°C/m,
        );
        if (anyTempMatch && anyTempMatch[1]) {
          const temp = parseFloat(anyTempMatch[1]);
          log(`Found any temp: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 20 && temp < 150) {
            log(`Using fallback temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }

        log('No valid temperature found in sensors output', 'WARN', 'hardware');
      } catch (sensorsError) {
        this.logConditionalError(
          'linux',
          sensorsError instanceof Error ? sensorsError.message : String(sensorsError),
          log,
          'Sensors command failed'
        );
      }

      // Method 4: Try /sys/class/hwmon approach (alternative to sensors)
      try {
        log('Trying hwmon approach...', 'DEBUG', 'hardware');
        const hwmonDirs = (await this.execCommand('ls /sys/class/hwmon/'))
          .trim()
          .split('\n');
        log(
          `Found ${hwmonDirs.length} hwmon directories: ${hwmonDirs.join(', ')}`,
          'DEBUG',
          'hardware',
        );

        for (const hwmonDir of hwmonDirs) {
          const hwmonPath = `/sys/class/hwmon/${hwmonDir}`;

          // Check if this is a CPU temperature sensor
          try {
            const nameFile = `${hwmonPath}/name`;
            if (await this.fileExists(nameFile)) {
              const sensorName = (await this.readFileTrim(nameFile)).toLowerCase();
              log(`Checking hwmon sensor: ${sensorName}`, 'DEBUG', 'hardware');

              // Look for CPU-related sensor names
              if (
                sensorName.includes('k10temp') ||
                sensorName.includes('coretemp') ||
                sensorName.includes('cpu') ||
                sensorName.includes('tctl')
              ) {
                log(`Found CPU sensor: ${sensorName}`, 'DEBUG', 'hardware');

                // Try to read temp1_input (main temperature)
                const tempFile = `${hwmonPath}/temp1_input`;
                if (await this.fileExists(tempFile)) {
                  const tempRaw = await this.readFileTrim(tempFile);
                  const temp = parseInt(tempRaw) / 1000;
                  log(
                    `${sensorName} temp1_input: ${temp}°C`,
                    'DEBUG',
                    'hardware',
                  );
                  if (!isNaN(temp) && temp > 0 && temp < 150) {
                    log(
                      `Using ${sensorName} temperature: ${temp}°C`,
                      'INFO',
                      'hardware',
                    );
                    return temp;
                  }
                }
              }
            }
          } catch (hwmonError) {
            log(
              `Hwmon error for ${hwmonDir}: ${hwmonError instanceof Error ? hwmonError.message : String(hwmonError)}`,
              'WARN',
              'hardware',
            );
            continue;
          }
        }
      } catch (hwmonListError) {
        this.logConditionalError(
          'linux',
          hwmonListError instanceof Error ? hwmonListError.message : String(hwmonListError),
          log,
          'Failed to list hwmon directories'
        );
      }

      // Method 5: Try acpi as fallback (only if we have it installed)
      try {
        log('Trying ACPI approach...', 'DEBUG', 'hardware');
        // Check if acpi exists before trying to use it
        await this.execCommand('command -v acpi > /dev/null 2>&1');

        const tempOutput = await this.execCommand('acpi -t');
        log(`ACPI output: ${tempOutput.trim()}`, 'DEBUG', 'hardware');
        const match = tempOutput.match(/(\d+\.\d+)/);
        if (match) {
          const temp = parseFloat(match[0]);
          log(`ACPI temperature: ${temp}°C`, 'DEBUG', 'hardware');
          if (temp > 0 && temp < 150) {
            log(`Using ACPI temperature: ${temp}°C`, 'INFO', 'hardware');
            return temp;
          }
        }
      } catch (acpiError) {
        const errorMessage = acpiError instanceof Error ? acpiError.message : String(acpiError);
        HardwareInfoUtil.logConditionalError(
          'linux',
          errorMessage,
          log,
          'ACPI failed',
          'WARN',
        );
      }

      // Method 6: Try /proc/acpi/thermal_zone
      try {
        log('Trying /proc/acpi/thermal_zone...', 'DEBUG', 'hardware');
        if (await this.fileExists('/proc/acpi/thermal_zone')) {
          const zones = (await this.execCommand('ls /proc/acpi/thermal_zone'))
            .trim()
            .split('\n');
          log(`Found thermal zones: ${zones.join(', ')}`, 'DEBUG', 'hardware');
          if (zones.length > 0) {
            const tempOutput = await this.execCommand(
              `cat /proc/acpi/thermal_zone/${zones[0]}/temperature`,
            );
            log(`Thermal zone output: ${tempOutput.trim()}`, 'DEBUG', 'hardware');
            const match = tempOutput.match(/(\d+)/);
            if (match) {
              const temp = parseInt(match[0]);
              log(`Thermal zone temperature: ${temp}°C`, 'DEBUG', 'hardware');
              if (temp > 0 && temp < 150) {
                log(
                  `Using thermal zone temperature: ${temp}°C`,
                  'INFO',
                  'hardware',
                );
                return temp;
              }
            }
          }
        }
      } catch (procAcpiError) {
        const errorMessage = procAcpiError instanceof Error ? procAcpiError.message : String(procAcpiError);
        HardwareInfoUtil.logConditionalError(
          'linux',
          errorMessage,
          log,
          '/proc/acpi/thermal_zone failed',
          'WARN',
        );
      }

      // Method 7: Try direct AMD temperature reading (for systems without sensors package)
      try {
        log('Trying direct AMD k10temp reading...', 'DEBUG', 'hardware');
        // Look for AMD k10temp in hwmon
        const hwmonDirs = await this.readDir('/sys/class/hwmon/');
        for (const dir of hwmonDirs) {
          const namePath = `/sys/class/hwmon/${dir}/name`;
          if (await this.fileExists(namePath)) {
            const name = await this.readFileTrim(namePath);
            log(`Checking direct sensor: ${name}`, 'DEBUG', 'hardware');
            if (name === 'k10temp') {
              const tempPath = `/sys/class/hwmon/${dir}/temp1_input`;
              if (await this.fileExists(tempPath)) {
                const tempRaw = await this.readFileTrim(tempPath);
                const temp = parseInt(tempRaw) / 1000;
                log(`Direct k10temp: ${temp}°C`, 'DEBUG', 'hardware');
                if (!isNaN(temp) && temp > 0 && temp < 150) {
                  log(`Using direct k10temp: ${temp}°C`, 'INFO', 'hardware');
                  return temp;
                }
              }
            }
          }
        }
      } catch (directAmdError) {
        const errorMessage = directAmdError instanceof Error ? directAmdError.message : String(directAmdError);
        HardwareInfoUtil.logConditionalError(
          'linux',
          errorMessage,
          log,
          'Direct AMD reading failed',
          'WARN',
        );
      }

      // No temperature data available
      log(
        'No CPU temperature sensors detected or accessible',
        'ERROR',
        'hardware',
      );
      return 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      HardwareInfoUtil.logConditionalError(
        'linux',
        errorMessage,
        log,
        'Failed to get Linux temperature',
        'ERROR',
      );
      return 0;
    }
  }

  /** ✅ Check if ADB is enabled (Termux-specific) */
  static async isAdbEnabled(systemType: string): Promise<boolean> {
    if (systemType !== 'termux') return false;
    try {
      const adbOutput = await this.execCommand('adb devices');
      const devices = adbOutput
        .split('\n')
        .slice(1) // Skip the "List of devices attached" header
        .filter((line) => line.trim().length > 0)
        .map((line) => line.trim().split('\t')[0]);

      return devices.length > 0;
    } catch {
      // If adb command fails, it means ADB is not available
      // Note: This method doesn't have access to logger, but ADB status is not critical
      return false;
    }
  }

  /** ✅ Check if SU (root) is available */
  static async isSuAvailable(systemType: string): Promise<boolean> {
    if (systemType !== 'termux') return false;
    try {
      return (await this.execCommand('su -c "echo rooted" 2>/dev/null')).includes('rooted');
    } catch {
      return false;
    }
  }

  /** ✅ Run a command with fallback to `su` in Termux */
  private static async runCommandWithSuFallback(command: string): Promise<string> {
    try {
      return (await this.execCommand(command)).trim();
    } catch {
      try {
        return (await this.execCommand(`su -c "${command}"`)).trim();
      } catch {
        return 'Unknown';
      }
    }
  }
}
