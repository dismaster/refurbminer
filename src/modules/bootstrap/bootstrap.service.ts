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
  
      if (osType === 'linux' || osType === 'raspberry-pi') {
        installCommand = 'sudo apt-get install -yq screen git gnu-which netcat-openbsd dnsutils traceroute';
      } else if (osType === 'termux') {
        installCommand = 'pkg install -y screen git which nmap-ncat getconf dnsutils traceroute';
      }
  
      if (!installCommand) {
        this.loggingService.log(`No install command found for OS: ${osType}`, 'WARN', 'bootstrap');
        return;
      }
  
      this.loggingService.log(`Installing dependencies for ${osType}...`, 'INFO', 'bootstrap');
  
      // Execute command & suppress stdout unless DEBUG mode is enabled
      const logLevel = process.env.LOG_LEVEL || 'INFO';
      if (logLevel === 'DEBUG') {
        execSync(installCommand, { stdio: 'inherit' });
      } else {
        execSync(installCommand + ' > /dev/null 2>&1');
      }
  
      this.loggingService.log('All dependencies installed successfully!', 'INFO', 'bootstrap');
    } catch (error) {
      this.loggingService.log(`Dependency installation failed: ${error.message}`, 'ERROR', 'bootstrap');
      process.exit(1);
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
    const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));

    if (!config.minerId || !config.rigId) {
      this.loggingService.log('No minerId found, registering miner...', 'INFO', 'bootstrap');
      const metadata = this.deviceMonitoringService.getSystemInfo();
      const ipAddress = this.deviceMonitoringService.getIPAddress();
      const response = await this.apiService.registerMiner(metadata, ipAddress);

      config.minerId = response.minerId;
      config.rigId = response.rigId;
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));

      this.loggingService.log(`Miner registered successfully! minerId: ${config.minerId}`, 'INFO', 'bootstrap');
    }
  }
}
