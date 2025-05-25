import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { DeviceMonitoringService } from '../device-monitoring/device-monitoring.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import * as fs from 'fs';
import { execSync } from 'child_process';

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly configPath = 'config/config.json'; // ✅ Define configPath

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly deviceMonitoringService: DeviceMonitoringService,
    private readonly minerManagerService: MinerManagerService,
  ) {}

  async onModuleInit() {
    console.log('⚡ [DEBUG] BootstrapService is running...');
    this.loggingService.log('Initializing Bootstrap Service...', 'INFO', 'bootstrap');
    await this.ensureConfigExists();
    await this.checkCPUCompatibility();
    await this.verifyDependencies();
    await this.ensureExecutables();
    
    // Check if we're on Termux to run ADB optimizations
    const osType = this.deviceMonitoringService.getOS();
    if (osType === 'termux') {
      await this.setupAdbOptimizations();
    }
    
    await this.registerMiner();
    this.loggingService.log('Bootstrap process completed!', 'INFO', 'bootstrap');
  }

  /** ✅ Ensure local configuration file exists */
  private async ensureConfigExists() {
    const configDir = 'config';

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true }); // Ensure config directory exists
    }

    if (!fs.existsSync(this.configPath)) {
      this.loggingService.log('Config file missing, creating new one...', 'WARN', 'bootstrap');
      fs.writeFileSync(this.configPath, JSON.stringify({}, null, 2)); // Create empty JSON file
    }
  }

  /** ✅ Check CPU Compatibility */
  private async checkCPUCompatibility() {
    try {
      const systemInfo = this.deviceMonitoringService.getSystemInfo();
      const { architecture, aesSupport, pmullSupport } = systemInfo.cpuInfo;
      const cpuModel = systemInfo.cpuInfo.model || '';
      
      // Check if CPU is 64-bit
      if (architecture !== '64-bit') {
        this.loggingService.log('Warning: CPU or OS is not 64-bit, mining may be less efficient', 'WARN', 'bootstrap');
      }
      
      // For Intel/AMD CPUs, we only need AES support
      const isIntelAmd = cpuModel.includes('Intel') || cpuModel.includes('AMD');
      
      // For ARM CPUs, we ideally want both AES and PMULL
      const isArm = architecture.includes('arm') || cpuModel.includes('Cortex');
      
      // Performance warning for ARM without PMULL
      if (isArm && !pmullSupport && aesSupport) {
        this.loggingService.log('Warning: ARM CPU missing PMULL support, mining will continue but may be less efficient', 'WARN', 'bootstrap');
      }
      
      // Intel/AMD without AES (very rare)
      if (isIntelAmd && !aesSupport) {
        this.loggingService.log('Warning: Intel/AMD CPU missing AES support, mining will continue but may be less efficient', 'WARN', 'bootstrap');
      }
      
      // Only fail if we have neither AES nor PMULL on any architecture
      if (!aesSupport && !pmullSupport) {
        this.loggingService.log('CPU lacks essential cryptographic instructions (AES), mining may not work properly', 'WARN', 'bootstrap');
        // Don't exit, just warn
      }
      
      this.loggingService.log('CPU compatibility check completed - mining should work', 'INFO', 'bootstrap');
    } catch (error) {
      this.loggingService.log(`CPU check warning: ${error.message}`, 'WARN', 'bootstrap');
      // Continue execution despite warnings
    }
  }

  /** ✅ Check & Install Dependencies */
  private async verifyDependencies() {
    try {
      const osType = this.deviceMonitoringService.getOS();
      let installCommand = '';
      let hasSudo = false;
      let packageManager = '';

      // Check if sudo is available
      try {
        execSync('command -v sudo', { stdio: 'ignore' });
        hasSudo = true;
      } catch (e) {
        this.loggingService.log('sudo not available, will attempt direct installation', 'INFO', 'bootstrap');
      }

      // Determine installation command based on OS type and sudo availability
      if (osType === 'linux' || osType === 'raspberry-pi') {
        // Detect package manager
        try {
          // Check for apt/apt-get (Debian/Ubuntu)
          execSync('command -v apt-get', { stdio: 'ignore' });
          packageManager = 'apt-get';
        } catch {
          try {
            // Check for dnf (Fedora/RHEL 8+)
            execSync('command -v dnf', { stdio: 'ignore' });
            packageManager = 'dnf';
          } catch {
            try {
              // Check for yum (CentOS/RHEL)
              execSync('command -v yum', { stdio: 'ignore' });
              packageManager = 'yum';
            } catch {
              try {
                // Check for pacman (Arch)
                execSync('command -v pacman', { stdio: 'ignore' });
                packageManager = 'pacman -S --noconfirm';
              } catch {
                this.loggingService.log('No supported package manager found', 'WARN', 'bootstrap');
              }
            }
          }
        }

        if (packageManager) {
          const sudoPrefix = hasSudo ? 'sudo ' : '';
          
          // Different package names for different distributions
          if (packageManager === 'apt-get') {
            // 'which' is part of debianutils
            installCommand = `${sudoPrefix}${packageManager} install -yq screen git gnupg curl debianutils netcat-openbsd dnsutils traceroute`;
          } else if (packageManager === 'dnf' || packageManager === 'yum') {
            installCommand = `${sudoPrefix}${packageManager} install -y screen git gnupg curl which nc bind-utils traceroute`;
          } else if (packageManager === 'pacman -S --noconfirm') {
            installCommand = `${sudoPrefix}${packageManager} screen git gnupg curl which openbsd-netcat bind-tools traceroute`;
          }
        }
      } else if (osType === 'termux') {
        installCommand = 'pkg install -y screen git gnupg curl termux-tools nmap-ncat getconf dnsutils traceroute';
      }

      if (!installCommand) {
        this.loggingService.log(`No install command found for OS: ${osType}`, 'WARN', 'bootstrap');
        return;
      }

      this.loggingService.log(`Installing dependencies for ${osType}...`, 'INFO', 'bootstrap');
      this.loggingService.log(`Running: ${installCommand}`, 'DEBUG', 'bootstrap');

      // Execute command & suppress stdout unless DEBUG mode is enabled
      const logLevel = process.env.LOG_LEVEL || 'INFO';
      try {
        if (logLevel === 'DEBUG') {
          execSync(installCommand, { stdio: 'inherit' });
        } else {
          execSync(installCommand + ' > /dev/null 2>&1');
        }
      } catch (error) {
        // If we're running as root without sudo and fail, try setting up package sources
        if (!hasSudo && process.getuid && process.getuid() === 0) {
          this.loggingService.log('Initial installation failed, checking package sources...', 'WARN', 'bootstrap');
          
          try {
            // Check /etc/apt/sources.list for Debian/Ubuntu
            if (packageManager === 'apt-get') {
              this.loggingService.log('Setting up minimal apt repository', 'INFO', 'bootstrap');
              const sourcesList = '/etc/apt/sources.list';
              
              // Check if sources.list exists and has content
              if (!fs.existsSync(sourcesList) || fs.readFileSync(sourcesList, 'utf8').trim() === '') {
                const distro = execSync('lsb_release -sc 2>/dev/null || echo bookworm', { encoding: 'utf8' }).trim();
                fs.writeFileSync(sourcesList, `deb http://deb.debian.org/debian ${distro} main\n`);
                execSync('apt-get update');
              }
              
              // Try installation again
              execSync(installCommand);
            }
          } catch (sourceError) {
            this.loggingService.log(`Repository setup failed: ${sourceError.message}`, 'ERROR', 'bootstrap');
            this.loggingService.log('Continuing without all dependencies...', 'WARN', 'bootstrap');
            return; // Continue without failing
          }
        } else {
          this.loggingService.log(`Dependency installation warning: ${error.message}`, 'WARN', 'bootstrap');
          this.loggingService.log('Continuing without all dependencies...', 'WARN', 'bootstrap');
          return; // Continue without failing
        }
      }

      this.loggingService.log('All dependencies installed successfully!', 'INFO', 'bootstrap');
    } catch (error) {
      this.loggingService.log(`Dependency verification failed: ${error.message}`, 'WARN', 'bootstrap');
      this.loggingService.log('Continuing without dependency verification...', 'WARN', 'bootstrap');
      // Don't exit, continue with warnings
    }
  }

  /** ✅ Ensure miner executables are runnable */
  private async ensureExecutables() {
    const executables = [
      { path: 'apps/ccminer/ccminer', name: 'ccminer' },
      { path: 'apps/xmrig/xmrig', name: 'xmrig' },
      { path: 'apps/vcgencmd/vcgencmd', name: 'vcgencmd' },
    ];

    executables.forEach(({ path, name }) => {
      if (fs.existsSync(path)) {
        try {
          execSync(`chmod +x ${path}`);
          this.loggingService.log(`Executable permissions fixed for ${name}!`, 'INFO', 'bootstrap');
        } catch (error) {
          this.loggingService.log(`Failed to set executable permissions for ${name}: ${error.message}`, 'ERROR', 'bootstrap');
        }
      } else {
        this.loggingService.log(`Warning: ${name} not found. Skipping permission fix.`, 'WARN', 'bootstrap');
      }
    });
  }

  /** ✅ Register Miner with API if needed */
  private async registerMiner() {
    try {
      let config = {};
      
      // Safely read the config file
      try {
        if (fs.existsSync(this.configPath)) {
          const configContent = fs.readFileSync(this.configPath, 'utf8');
          if (configContent && configContent.trim()) {
            config = JSON.parse(configContent);
          } else {
            this.loggingService.log('Config file is empty, will create new configuration', 'INFO', 'bootstrap');
          }
        } else {
          this.loggingService.log('Config file not found, will create new configuration', 'INFO', 'bootstrap');
          // Ensure directory exists
          const configDir = path.dirname(this.configPath);
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }
        }
      } catch (readError) {
        this.loggingService.log(`Error reading config: ${readError.message}, will create new configuration`, 'WARN', 'bootstrap');
      }
      
      // Check if we need to register
      if (!config.minerId || !config.rigId) {
        this.loggingService.log('No valid minerId found, registering miner...', 'INFO', 'bootstrap');
        
        try {
          const metadata = this.deviceMonitoringService.getSystemInfo();
          const ipAddress = this.deviceMonitoringService.getIPAddress();
          const response = await this.apiService.registerMiner(metadata, ipAddress);
          
          if (response && response.minerId && response.rigId) {
            config.minerId = response.minerId;
            config.rigId = response.rigId;
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
            this.loggingService.log(`Miner registered successfully! minerId: ${config.minerId}`, 'INFO', 'bootstrap');
          } else {
            this.loggingService.log('API returned incomplete registration data, using default values', 'WARN', 'bootstrap');
            // Set temporary values to prevent continuous registration attempts
            config.minerId = 'temp-' + Date.now();
            config.rigId = 'temp-' + Date.now();
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
          }
        } catch (apiError) {
          this.loggingService.log(`Miner registration failed: ${apiError.message}`, 'ERROR', 'bootstrap');
          
          // Create temporary ID to prevent repeated registration attempts
          config.minerId = 'offline-' + Date.now();
          config.rigId = 'offline-' + Date.now();
          fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
        }
      }
    } catch (error) {
      this.loggingService.log(`Register miner error: ${error.message}`, 'ERROR', 'bootstrap');
      // Make sure we still have a config file to prevent future errors
      try {
        if (!fs.existsSync(this.configPath)) {
          fs.writeFileSync(this.configPath, JSON.stringify({
            minerId: 'fallback-' + Date.now(),
            rigId: 'fallback-' + Date.now()
          }, null, 2));
        }
      } catch (writeError) {
        this.loggingService.log(`Failed to write fallback config: ${writeError.message}`, 'ERROR', 'bootstrap');
      }
    }
  }

  /** ✅ Setup ADB optimizations for Termux */
  private async setupAdbOptimizations() {
    try {
      this.loggingService.log('Checking ADB availability on Termux...', 'INFO', 'bootstrap');
      
      // Check if ADB is installed
      try {
        execSync('command -v adb', { stdio: 'ignore' });
      } catch {
        this.loggingService.log('ADB not found, skipping power optimizations', 'INFO', 'bootstrap');
        return;
      }
      
      // Reset ADB server to ensure fresh connection
      try {
        execSync('adb kill-server', { stdio: 'ignore' });
        this.loggingService.log('ADB server killed', 'DEBUG', 'bootstrap');
      } catch (error) {
        this.loggingService.log(`Failed to kill ADB server: ${error.message}`, 'DEBUG', 'bootstrap');
      }
      
      // Start ADB and check if it can connect to the device
      let adbWorks = false;
      
      // First attempt: Try ADB directly
      try {
        // Try to get device state - this will start the server if needed
        const deviceOutput = execSync('adb get-state', { 
          encoding: 'utf8',
          timeout: 5000, // 5 second timeout
          stdio: ['ignore', 'pipe', 'pipe'] 
        }).trim();
        
        if (deviceOutput === 'device') {
          adbWorks = true;
          this.loggingService.log('ADB connection established successfully', 'INFO', 'bootstrap');
        }
      } catch (error: any) {
        this.loggingService.log(`ADB not connected: ${error.message}`, 'DEBUG', 'bootstrap');
        
        // Second attempt: Try to restart the server and establish connection
        try {
          // Explicitly kill and restart ADB server
          execSync('adb kill-server', { stdio: 'ignore' });
          this.loggingService.log('Restarting ADB server...', 'DEBUG', 'bootstrap');
          
          // Start server and check for devices
          // This specifically handles the "daemon not running; starting now" case
          const result = execSync('adb shell echo success', { 
            encoding: 'utf8',
            timeout: 8000 // Give it more time to initialize
          }).trim();
          
          if (result.includes('success')) {
            adbWorks = true;
            this.loggingService.log('ADB connection established after restart', 'INFO', 'bootstrap');
          }
        } catch (restartError: any) {
          this.loggingService.log(`ADB restart failed: ${restartError.message}`, 'DEBUG', 'bootstrap');
          
          // Third attempt: Check device list (sometimes works when the above fails)
          try {
            const devices = execSync('adb devices', { 
              encoding: 'utf8',
              timeout: 5000
            });
            
            // Check if any device is connected (not just "List of devices attached")
            if (devices.split('\n').length > 2 || devices.includes('device')) {
              adbWorks = true;
              this.loggingService.log('ADB devices detected', 'INFO', 'bootstrap');
            }
          } catch (devicesError: any) {
            this.loggingService.log(`ADB devices check failed: ${devicesError.message}`, 'DEBUG', 'bootstrap');
          }
        }
      }
      
      if (!adbWorks) {
        this.loggingService.log('ADB is installed but no devices are connected, skipping optimizations', 'WARN', 'bootstrap');
        return;
      }
      
      // ADB is working - run optimization commands
      this.loggingService.log('Applying power and performance optimizations via ADB...', 'INFO', 'bootstrap');
      
      const adbCommands = [
        'adb shell dumpsys battery set level 100',
        'adb shell svc power stayon true',
        'adb shell dumpsys deviceidle whitelist +com.termux.boot',
        'adb shell dumpsys deviceidle whitelist +com.termux',
        'adb shell dumpsys deviceidle whitelist +com.termux.api',
        'adb shell settings put global system_capabilities 100',
        'adb shell settings put global sem_enhanced_cpu_responsiveness 1',
        'adb shell settings put global wifi_sleep_policy 2'
      ];
      
      let successCount = 0;
      for (const cmd of adbCommands) {
        try {
          execSync(cmd, { timeout: 3000 });
          successCount++;
        } catch (cmdError) {
          this.loggingService.log(`Failed to run "${cmd}": ${cmdError.message}`, 'DEBUG', 'bootstrap');
        }
      }
      
      this.loggingService.log(`Power optimizations applied: ${successCount}/${adbCommands.length} succeeded`, 'INFO', 'bootstrap');
    } catch (error) {
      this.loggingService.log(`ADB optimization failed: ${error.message}`, 'WARN', 'bootstrap');
      // Continue execution despite failures
    }
  }
}
