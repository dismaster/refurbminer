import { execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryInfoUtil } from './memory-info.util';
import { StorageInfoUtil } from './storage-info.util';

export class HardwareInfoUtil {
  private static readonly VCGENCMD_PATH = path.join(
    process.cwd(),
    'apps',
    'vcgencmd',
    'vcgencmd',
  );

  /** ✅ Get full hardware info */
  static getDeviceInfo(systemType: string, logger?: (message: string, level: string, category: string) => void): any {
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
      cpuTemperature: this.getCpuTemperature(systemType, logger),
      // Add system uptime
      systemUptime: this.getSystemUptime(systemType),
      // Add raw values
      totalMemory: totalMemory,
      freeMemory: freeMemory,
      totalStorage: totalStorage,
      freeStorage: freeStorage,
      adbEnabled: this.isAdbEnabled(systemType),
      suAvailable: this.isSuAvailable(systemType),
    };
  }

  /** ✅ Get system uptime in seconds */
  static getSystemUptime(systemType: string): number {
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
        const uptimeOutput = execSync('uptime -p', { encoding: 'utf8' }).trim();

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
      if (fs.existsSync('/proc/uptime')) {
        const uptimeContent = fs
          .readFileSync('/proc/uptime', 'utf8')
          .split(' ')[0];
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
  static getBrand(systemType: string): string {
    try {
      if (systemType === 'termux') {
        return this.runCommandWithSuFallback('getprop ro.product.brand');
      }
      if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
        return execSync(
          "cat /sys/firmware/devicetree/base/model | awk '{print $1}'",
          { encoding: 'utf8' },
        )
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
        return execSync(
          "cat /sys/firmware/devicetree/base/model | awk '{print $2, $3}'",
          { encoding: 'utf8' },
        )
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
        const releaseVer = this.runCommandWithSuFallback(
          'getprop ro.build.version.release',
        );
        const sdkVer = this.runCommandWithSuFallback(
          'getprop ro.build.version.sdk',
        );
        return `Android ${releaseVer} (API ${sdkVer})`;
      }

      // Check for /etc/os-release first (Linux/RPi)
      if (fs.existsSync('/etc/os-release')) {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
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
  static getCpuCount(): number {
    try {
      return parseInt(
        execSync("lscpu | grep '^CPU(s):' | awk '{print $2}'", {
          encoding: 'utf8',
        }).trim(),
      );
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
  static getCpuTemperature(systemType: string, logger?: (message: string, level: string, category: string) => void): number {
    const log = logger || (() => {}); // No-op if no logger provided
    
    log(`Getting CPU temperature for system type: ${systemType}`, 'DEBUG', 'hardware');
    try {
      switch (systemType) {
        case 'raspberry-pi':
          log('Using Raspberry Pi temperature method', 'DEBUG', 'hardware');
          return this.getVcgencmdTemperature(log);
        case 'termux':
          log('Using Termux temperature method', 'DEBUG', 'hardware');
          return this.getTermuxCpuTemperature(log);
        case 'linux':
          log('Using Linux temperature method', 'DEBUG', 'hardware');
          return this.getLinuxCpuTemperature(log);
        default:
          log(`Unknown system type: ${systemType}, returning 0`, 'DEBUG', 'hardware');
          return 0;
      }
    } catch (error) {
      log(`Failed to get CPU temperature: ${error instanceof Error ? error.message : String(error)}`, 'ERROR', 'hardware');
      return 0;
    }
  }

  /** ✅ Raspberry Pi: Get CPU Temp via vcgencmd */
  private static getVcgencmdTemperature(log: (message: string, level: string, category: string) => void): number {
    try {
      if (fs.existsSync(this.VCGENCMD_PATH)) {
        execSync(`chmod +x ${this.VCGENCMD_PATH}`);
        const tempOutput = execSync(`${this.VCGENCMD_PATH} measure_temp`, {
          encoding: 'utf8',
        });
        const match = tempOutput.match(/temp=([\d.]+)/);
        if (match) return parseFloat(match[1]);
      }
      return this.getLinuxCpuTemperature(log);
    } catch (error) {
      log(
        `Failed to get Raspberry Pi temperature: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'hardware',
      );
      return this.getLinuxCpuTemperature(log);
    }
  }

  /** ✅ Termux: Robust CPU temperature detection (with proper permission handling) */
  private static getTermuxCpuTemperature(log: (message: string, level: string, category: string) => void): number {
    log('Starting Termux temperature detection...', 'DEBUG', 'hardware');
    
    try {
      // Method 1: Try vcgencmd with root first (for some rooted devices)
      if (this.isSuAvailable('termux') && fs.existsSync(this.VCGENCMD_PATH)) {
        try {
          log('Trying vcgencmd with root...', 'DEBUG', 'hardware');
          execSync(`chmod +x ${this.VCGENCMD_PATH}`);
          const tempOutput = execSync(
            `su -c "${this.VCGENCMD_PATH} measure_temp"`,
            { encoding: 'utf8' },
          );
          const match = tempOutput.match(/temp=([\d.]+)/);
          if (match) {
            const temp = parseFloat(match[1]);
            log(`vcgencmd temperature: ${temp}°C`, 'DEBUG', 'hardware');
            return temp;
          }
        } catch (vcgencmdError) {
          log(`vcgencmd failed: ${vcgencmdError instanceof Error ? vcgencmdError.message : String(vcgencmdError)}`, 'WARN', 'hardware');
        }
      }

      // Method 2: Try reading thermal zones with root access first
      if (this.isSuAvailable('termux')) {
        try {
          log('Trying thermal zones with root access...', 'DEBUG', 'hardware');
          
          // Try to list thermal zones with root
          const zonesOutput = execSync(
            'su -c "ls /sys/class/thermal/ 2>/dev/null | grep thermal_zone"',
            { encoding: 'utf8' },
          ).trim();
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
                const typeOutput = execSync(
                  `su -c "cat /sys/class/thermal/${zone}/type 2>/dev/null"`,
                  { encoding: 'utf8' },
                )
                  .trim()
                  .toLowerCase();
                log(`Zone ${zone} type: ${typeOutput}`, 'DEBUG', 'hardware');
                
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

                const tempRaw = execSync(
                  `su -c "cat /sys/class/thermal/${zone}/temp 2>/dev/null"`,
                  { encoding: 'utf8' },
                ).trim();
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
        if (fs.existsSync(basePath)) {
          try {
            const zones = fs.readdirSync(basePath).filter((z) => z.startsWith('thermal_zone'));
            log(`Found ${zones.length} thermal zones without root: ${zones.join(', ')}`, 'DEBUG', 'hardware');
            
            let cpuTemps: number[] = [];

            for (const zone of zones) {
              try {
                const typePath = path.join(basePath, zone, 'type');
                const tempPath = path.join(basePath, zone, 'temp');
                
                if (fs.existsSync(typePath) && fs.existsSync(tempPath)) {
                  const type = fs.readFileSync(typePath, 'utf8').trim().toLowerCase();
                  log(`Zone ${zone} type (no-root): ${type}`, 'DEBUG', 'hardware');
                  
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

                  const tempRaw = fs.readFileSync(tempPath, 'utf8').trim();
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
            log(`Failed to scan thermal directory: ${thermalScanError instanceof Error ? thermalScanError.message : String(thermalScanError)}`, 'WARN', 'hardware');
          }
        }
      } catch (thermalAccessError) {
        log(`Cannot access thermal zones: ${thermalAccessError instanceof Error ? thermalAccessError.message : String(thermalAccessError)}`, 'WARN', 'hardware');
      }

      // Method 4: Try individual thermal zone files with root (fallback)
      if (this.isSuAvailable('termux')) {
        log('Trying individual thermal zone files with root...', 'DEBUG', 'hardware');
        for (let i = 0; i < 10; i++) {
          try {
            const tempRaw = execSync(
              `su -c "cat /sys/class/thermal/thermal_zone${i}/temp 2>/dev/null"`,
              { encoding: 'utf8' },
            ).trim();
            
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
      return this.getLinuxCpuTemperature(log);
      
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
  private static getLinuxCpuTemperature(log: (message: string, level: string, category: string) => void): number {
    try {
      log('Starting Linux CPU temperature detection...', 'DEBUG', 'hardware');

      // Method 1: Try thermal zone (most reliable for most systems)
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        try {
          const tempRaw = execSync(
            'cat /sys/class/thermal/thermal_zone0/temp',
            { encoding: 'utf8' },
          ).trim();
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
        if (fs.existsSync(zonePath)) {
          try {
            const tempRaw = execSync(`cat ${zonePath}`, {
              encoding: 'utf8',
            }).trim();
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
        const sensorsOutput = execSync('sensors', { encoding: 'utf8' }).trim();
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
        log(
          `Sensors command failed: ${sensorsError instanceof Error ? sensorsError.message : String(sensorsError)}`,
          'WARN',
          'hardware',
        );
      }

      // Method 4: Try /sys/class/hwmon approach (alternative to sensors)
      try {
        log('Trying hwmon approach...', 'DEBUG', 'hardware');
        const hwmonDirs = execSync('ls /sys/class/hwmon/', { encoding: 'utf8' })
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
            if (fs.existsSync(nameFile)) {
              const sensorName = fs
                .readFileSync(nameFile, 'utf8')
                .trim()
                .toLowerCase();
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
                if (fs.existsSync(tempFile)) {
                  const tempRaw = fs.readFileSync(tempFile, 'utf8').trim();
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
        log(
          `Failed to list hwmon directories: ${hwmonListError instanceof Error ? hwmonListError.message : String(hwmonListError)}`,
          'WARN',
          'hardware',
        );
      }

      // Method 5: Try acpi as fallback (only if we have it installed)
      try {
        log('Trying ACPI approach...', 'DEBUG', 'hardware');
        // Check if acpi exists before trying to use it
        execSync('command -v acpi > /dev/null 2>&1');

        const tempOutput = execSync('acpi -t', { encoding: 'utf8' });
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
        log(
          `ACPI failed: ${acpiError instanceof Error ? acpiError.message : String(acpiError)}`,
          'WARN',
          'hardware',
        );
      }

      // Method 6: Try /proc/acpi/thermal_zone
      try {
        log('Trying /proc/acpi/thermal_zone...', 'DEBUG', 'hardware');
        if (fs.existsSync('/proc/acpi/thermal_zone')) {
          const zones = execSync('ls /proc/acpi/thermal_zone', {
            encoding: 'utf8',
          })
            .trim()
            .split('\n');
          log(`Found thermal zones: ${zones.join(', ')}`, 'DEBUG', 'hardware');
          if (zones.length > 0) {
            const tempOutput = execSync(
              `cat /proc/acpi/thermal_zone/${zones[0]}/temperature`,
              { encoding: 'utf8' },
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
        log(
          `/proc/acpi/thermal_zone failed: ${procAcpiError instanceof Error ? procAcpiError.message : String(procAcpiError)}`,
          'WARN',
          'hardware',
        );
      }

      // Method 7: Try direct AMD temperature reading (for systems without sensors package)
      try {
        log('Trying direct AMD k10temp reading...', 'DEBUG', 'hardware');
        // Look for AMD k10temp in hwmon
        const hwmonDirs = fs.readdirSync('/sys/class/hwmon/');
        for (const dir of hwmonDirs) {
          const namePath = `/sys/class/hwmon/${dir}/name`;
          if (fs.existsSync(namePath)) {
            const name = fs.readFileSync(namePath, 'utf8').trim();
            log(`Checking direct sensor: ${name}`, 'DEBUG', 'hardware');
            if (name === 'k10temp') {
              const tempPath = `/sys/class/hwmon/${dir}/temp1_input`;
              if (fs.existsSync(tempPath)) {
                const tempRaw = fs.readFileSync(tempPath, 'utf8').trim();
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
        log(
          `Direct AMD reading failed: ${directAmdError instanceof Error ? directAmdError.message : String(directAmdError)}`,
          'WARN',
          'hardware',
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
      log(
        `Failed to get Linux temperature: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'hardware',
      );
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
  static isSuAvailable(systemType: string): boolean {
    if (systemType !== 'termux') return false;
    try {
      return !!execSync('su -c "echo rooted" 2>/dev/null', {
        encoding: 'utf8',
      }).includes('rooted');
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
