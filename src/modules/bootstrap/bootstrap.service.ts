import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { DeviceMonitoringService } from '../device-monitoring/device-monitoring.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import { execSync } from 'child_process';

// Define config interface to fix TypeScript errors
interface MinerConfig {
  minerId?: string;
  rigId?: string;
  [key: string]: any; // Allow any other properties
}

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly configPath = 'config/config.json'; // ✅ Define configPath

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly deviceMonitoringService: DeviceMonitoringService,
    private readonly minerManagerService: MinerManagerService,
    private readonly configService: ConfigService, // <-- inject ConfigService
  ) {}

  async onModuleInit() {
    console.log('⚡ [DEBUG] BootstrapService is running...');
    this.loggingService.log(
      'Initializing Bootstrap Service...',
      'INFO',
      'bootstrap',
    );
    this.ensureConfigExists();

    // --- ENFORCE: Do not proceed until minerId is assigned by backend ---
    let validMinerID = false;

    // First check if we already have a valid miner ID
    const existingConfig = this.configService.getConfig();
    if (
      existingConfig &&
      existingConfig.minerId &&
      existingConfig.minerId.length > 0
    ) {
      this.loggingService.log(
        `Found existing miner ID: ${existingConfig.minerId}. Skipping registration.`,
        'INFO',
        'bootstrap',
      );
      validMinerID = true;
    } else {
      this.loggingService.log(
        'No valid miner ID found. Starting registration process...',
        'INFO',
        'bootstrap',
      );

      while (!validMinerID) {
        validMinerID = await this.registerMiner();
        if (!validMinerID) {
          this.loggingService.log(
            'Waiting for backend-assigned minerId. Retrying registration in 10 seconds...',
            'ERROR',
            'bootstrap',
          );
          await new Promise((res) => setTimeout(res, 10000));
        }
      }
    } // --- END ENFORCE ---

    // Now that registration is complete, trigger config sync to get schedules and other config data
    this.loggingService.log(
      'Registration complete. Triggering config sync to fetch schedules and configuration...',
      'INFO',
      'bootstrap',
    );
    
    try {
      await this.configService.triggerConfigSyncAfterRegistration();
      this.loggingService.log(
        '✅ Config sync triggered successfully after registration',
        'INFO',
        'bootstrap',
      );
    } catch (error) {
      this.loggingService.log(
        `⚠️ Failed to trigger config sync after registration: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'bootstrap',
      );
    }

    // Trigger initial flightsheet fetch now that registration is complete
    this.loggingService.log(
      'Triggering initial flightsheet fetch after successful registration...',
      'INFO',
      'bootstrap',
    );
    await this.minerManagerService.triggerInitialFlightsheetFetchAndStart();

    this.checkCPUCompatibility();
    await this.verifyDependencies();
    this.ensureExecutables();

    // Check if we're on Termux to run ADB optimizations
    const osType = this.deviceMonitoringService.getOS();
    if (osType === 'termux') {
      this.setupAdbOptimizations();
    }

    this.loggingService.log(
      'Bootstrap process completed!',
      'INFO',
      'bootstrap',
    );
  }

  /** ✅ Ensure local configuration file exists */
  private ensureConfigExists() {
    const configDir = 'config';

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true }); // Ensure config directory exists
    }

    if (!fs.existsSync(this.configPath)) {
      this.loggingService.log(
        'Config file missing, creating new one...',
        'WARN',
        'bootstrap',
      );
      // Create empty config with NO minerId, so nothing can proceed until registration
      fs.writeFileSync(
        this.configPath,
        JSON.stringify({ minerId: '', rigId: '' }, null, 2),
      );
    }
  }

  /** ✅ Check CPU Compatibility */
  private checkCPUCompatibility() {
    try {
      const systemInfo = this.deviceMonitoringService.getSystemInfo() as {
        cpuInfo?: {
          architecture?: string;
          aesSupport?: boolean;
          pmullSupport?: boolean;
          model?: string;
        };
      };
      const cpuInfo = systemInfo.cpuInfo || {};
      const architecture = cpuInfo.architecture || '';
      const aesSupport = !!cpuInfo.aesSupport;
      const pmullSupport = !!cpuInfo.pmullSupport;
      const cpuModel = cpuInfo.model || '';

      if (!architecture.includes('64')) {
        this.loggingService.log(
          'Warning: CPU or OS is not 64-bit, mining may be less efficient',
          'WARN',
          'bootstrap',
        );
      }

      const isIntelAmd = cpuModel.includes('Intel') || cpuModel.includes('AMD');
      const isArm = architecture.includes('arm') || cpuModel.includes('Cortex');

      if (isArm && !pmullSupport) {
        this.loggingService.log(
          'Warning: ARM CPU missing PMULL support, mining will continue but may be less efficient',
          'WARN',
          'bootstrap',
        );
      }
      if (isIntelAmd && !aesSupport) {
        this.loggingService.log(
          'Warning: Intel/AMD CPU missing AES support, mining will continue but may be less efficient',
          'WARN',
          'bootstrap',
        );
      }
      if (!aesSupport) {
        this.loggingService.log(
          'CPU lacks essential cryptographic instructions (AES), mining may not work properly',
          'WARN',
          'bootstrap',
        );
      }
      this.loggingService.log(
        'CPU compatibility check completed - mining should work',
        'INFO',
        'bootstrap',
      );
    } catch (error) {
      const errMsg =
        typeof error === 'object' && error && 'message' in error
          ? (error as { message: string }).message
          : String(error);
      this.loggingService.log(
        `CPU check warning: ${errMsg}`,
        'WARN',
        'bootstrap',
      );
    }
  }

  /** ✅ Check & Install Dependencies - Enhanced for Raspberry Pi */
  private async verifyDependencies() {
    try {
      const osType = this.deviceMonitoringService.getOS();

      const PACKAGE_MAPPING: Record<string, Record<string, string[]>> = {
        'apt-get': {
          essential: ['curl', 'screen', 'git'],
          network: ['netcat-openbsd', 'dnsutils', 'traceroute'],
          networkFallback: ['netcat', 'bind9-host', 'iputils-ping'],
          system: ['gnupg', 'debianutils'],
          hardware: ['lm-sensors', 'acpi'],
          compilation: ['make', 'clang', 'cmake'],
        },
        dnf: {
          essential: ['curl', 'screen', 'git'],
          network: ['nc', 'bind-utils', 'traceroute'],
          networkFallback: ['nmap-ncat', 'bind-utils', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi'],
          compilation: ['make', 'clang', 'cmake'],
        },
        yum: {
          essential: ['curl', 'screen', 'git'],
          network: ['nc', 'bind-utils', 'traceroute'],
          networkFallback: ['nmap-ncat', 'bind-utils', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi'],
          compilation: ['make', 'clang', 'cmake'],
        },
        pacman: {
          essential: ['curl', 'screen', 'git'],
          network: ['openbsd-netcat', 'bind-tools', 'traceroute'],
          networkFallback: ['gnu-netcat', 'bind', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi'],
          compilation: ['make', 'clang', 'cmake'],
        },
        pkg: {
          essential: ['curl', 'screen', 'git'],
          network: ['netcat-openbsd', 'dnsutils', 'traceroute'],
          networkFallback: ['netcat', 'bind9-host', 'iputils-ping'],
          system: ['gnupg', 'debianutils'],
          hardware: ['lm-sensors', 'acpi'],
          compilation: ['make', 'clang', 'cmake'],
        },
      };

      // Check if sudo is available
      let hasSudo = false;
      try {
        execSync('command -v sudo', { stdio: 'ignore' });
        hasSudo = true;
      } catch {
        // No sudo available
      }

      // Detect package manager
      let packageManager = '';
      if (osType === 'linux' || osType === 'raspberry-pi') {
        const managers = ['apt-get', 'dnf', 'yum', 'pacman'];
        for (const manager of managers) {
          try {
            execSync(`command -v ${manager}`, { stdio: 'ignore' });
            packageManager = manager;
            break;
          } catch {
            // Continue to next manager
          }
        }
      } else if (osType === 'termux') {
        packageManager = 'pkg';
      }

      if (!packageManager) {
        this.loggingService.log(
          `No supported package manager found for OS: ${osType}`,
          'WARN',
          'bootstrap',
        );
        // Continue without package installation
      } else if (!hasSudo && packageManager !== 'pkg') {
        this.loggingService.log(
          `Package manager ${packageManager} requires sudo privileges, but sudo is not available`,
          'WARN',
          'bootstrap',
        );
        this.loggingService.log(
          'Skipping package installation and verifying existing tools...',
          'INFO',
          'bootstrap',
        );
        
        // Just verify that essential tools are available
        await this.verifyEssentialTools();
        return;
      } else {
        this.loggingService.log(
          `Installing dependencies for ${osType} using ${packageManager}...`,
          'INFO',
          'bootstrap',
        );

        // Enhanced installation with individual package fallback
        await this.installDependenciesWithFallback(
          packageManager,
          hasSudo,
          osType,
          PACKAGE_MAPPING[packageManager] || PACKAGE_MAPPING['apt-get'],
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.loggingService.log(
        `Dependency verification failed: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
      this.loggingService.log(
        'Continuing without dependency verification...',
        'WARN',
        'bootstrap',
      );
    }
  }

  /** Enhanced installation with individual package fallback and timeout handling */
  private async installDependenciesWithFallback(
    packageManager: string,
    hasSudo: boolean,
    osType: string,
    packageMap: Record<string, string[]>,
  ) {
    const sudoPrefix = hasSudo ? 'sudo ' : '';
    const timeoutMs = 30000; // 30 second timeout per package group

    // Setup package repositories first
    await this.setupPackageRepositories(packageManager, sudoPrefix, osType);

    // Install package groups with fallback
    const packageGroups = ['essential', 'compilation', 'network', 'system', 'hardware'];
    let successfulInstalls = 0;
    let totalAttempts = 0;

    for (const group of packageGroups) {
      const packages = packageMap[group] || [];
      if (packages.length === 0) continue;

      this.loggingService.log(
        `Installing ${group} packages: ${packages.join(', ')}`,
        'INFO',
        'bootstrap',
      );

      const success = await this.installPackageGroup(
        packageManager,
        sudoPrefix,
        packages,
        'INFO',
        timeoutMs,
      );

      totalAttempts++;
      if (success) {
        successfulInstalls++;
      } else if (group === 'network' && packageMap.networkFallback) {
        // Try fallback network packages
        this.loggingService.log(
          `Trying fallback network packages: ${packageMap.networkFallback.join(', ')}`,
          'INFO',
          'bootstrap',
        );

        const fallbackSuccess = await this.installPackageGroup(
          packageManager,
          sudoPrefix,
          packageMap.networkFallback,
          'INFO',
          timeoutMs,
        );

        if (fallbackSuccess) {
          successfulInstalls++;
        } else {
          // Try installing individual network tools
          await this.installIndividualNetworkTools(
            packageManager,
            sudoPrefix,
            'INFO',
          );
        }
      }
    }

    // Verify critical network tools
    await this.verifyNetworkTools();

    this.loggingService.log(
      `Dependency installation completed: ${successfulInstalls}/${totalAttempts} package groups installed`,
      successfulInstalls > 0 ? 'INFO' : 'WARN',
      'bootstrap',
    );
  }

  /** Install a group of packages with timeout handling */
  private installPackageGroup(
    packageManager: string,
    sudoPrefix: string,
    packages: string[],
    logLevel: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const packageList = packages.join(' ');
      let installCommand = '';

      switch (packageManager) {
        case 'apt-get':
          installCommand = `${sudoPrefix}apt-get install -yq ${packageList}`;
          break;
        case 'dnf':
        case 'yum':
          installCommand = `${sudoPrefix}${packageManager} install -y ${packageList}`;
          break;
        case 'pacman':
          installCommand = `${sudoPrefix}pacman -S --noconfirm ${packageList}`;
          break;
        case 'pkg':
          installCommand = `pkg install -y ${packageList}`;
          break;
        default:
          resolve(false);
          return;
      }

      try {
        const stdio = logLevel === 'DEBUG' ? 'inherit' : 'ignore';
        execSync(installCommand, {
          stdio,
          timeout: timeoutMs,
          encoding: 'utf8',
        });
        resolve(true);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.loggingService.log(
          `Package group installation failed: ${errorMessage}`,
          'WARN',
          'bootstrap',
        );
        resolve(false);
      }
    });
  }

  /** Setup package repositories with better error handling */
  private setupPackageRepositories(
    packageManager: string,
    sudoPrefix: string,
    osType: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (packageManager !== 'apt-get') {
        resolve();
        return;
      }

      try {
        // Update package lists first
        this.loggingService.log('Updating package lists...', 'INFO', 'bootstrap');
        execSync(`${sudoPrefix}apt-get update -qq`, {
          stdio: 'ignore',
          timeout: 30000,
        });
        resolve();
      } catch {
        this.loggingService.log(
          'Package list update failed, checking repositories...',
          'WARN',
          'bootstrap',
        );

        // Setup minimal repository if needed
        if (
          !fs.existsSync('/etc/apt/sources.list') ||
          fs.readFileSync('/etc/apt/sources.list', 'utf8').trim() === ''
        ) {
          try {
            const distro = execSync(
              'lsb_release -sc 2>/dev/null || echo bookworm',
              { encoding: 'utf8' },
            ).trim();

            const sourcesList =
              osType === 'raspberry-pi'
                ? `deb http://deb.debian.org/debian ${distro} main\ndeb http://archive.raspberrypi.org/debian/ ${distro} main`
                : `deb http://deb.debian.org/debian ${distro} main`;

            fs.writeFileSync('/etc/apt/sources.list', sourcesList);

            this.loggingService.log(
              'Repository sources configured',
              'INFO',
              'bootstrap',
            );
            execSync(`${sudoPrefix}apt-get update -qq`, {
              stdio: 'ignore',
              timeout: 30000,
            });
          } catch (repoError) {
            const errorMessage = repoError instanceof Error ? repoError.message : String(repoError);
            this.loggingService.log(
              `Repository setup failed: ${errorMessage}`,
              'WARN',
              'bootstrap',
            );
          }
        }
        resolve();
      }
    });
  }

  /** Install individual network tools as fallback */
  private installIndividualNetworkTools(
    packageManager: string,
    sudoPrefix: string,
    logLevel: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      const networkTools = [
        { pkg: 'netcat-openbsd', alt: 'netcat' },
        { pkg: 'dnsutils', alt: 'bind9-host' },
        { pkg: 'iputils-ping', alt: 'ping' },
      ];

      for (const tool of networkTools) {
        for (const pkgName of [tool.pkg, tool.alt]) {
          try {
            const command = `${sudoPrefix}${packageManager} install -yq ${pkgName}`;
            execSync(command, {
              stdio: 'ignore',
              timeout: 15000,
            });
            this.loggingService.log(
              `Successfully installed ${pkgName}`,
              'INFO',
              'bootstrap',
            );
            break;
          } catch {
            continue; // Try alternative package
          }
        }
      }
      resolve();
    });
  }

  /** Verify that critical network tools are available */
  private verifyNetworkTools(): Promise<void> {
    return new Promise((resolve) => {
      const tools = [
        { cmd: 'curl', required: true },
        { cmd: 'nc', required: false },
        { cmd: 'nslookup', required: false },
        { cmd: 'ping', required: false },
      ];

      const available = [];
      const missing = [];

      for (const tool of tools) {
        try {
          execSync(`command -v ${tool.cmd}`, { stdio: 'ignore' });
          available.push(tool.cmd);
        } catch {
          if (tool.required) {
            missing.push(tool.cmd);
          }
        }
      }

      if (available.length > 0) {
        this.loggingService.log(
          `Network tools available: ${available.join(', ')}`,
          'INFO',
          'bootstrap',
        );
      }

      if (missing.length > 0) {
        this.loggingService.log(
          `Critical network tools missing: ${missing.join(', ')}`,
          'ERROR',
          'bootstrap',
        );
      } else {
        this.loggingService.log(
          'All required network tools are available',
          'INFO',
          'bootstrap',
        );
      }
      resolve();
    });
  }

  /** ✅ Ensure miner executables are runnable */
  private ensureExecutables() {
    const executables = [
      { path: 'apps/ccminer/ccminer', name: 'ccminer' },
      { path: 'apps/xmrig/xmrig', name: 'xmrig' },
      { path: 'apps/vcgencmd/vcgencmd', name: 'vcgencmd' },
    ];

    executables.forEach(({ path, name }) => {
      if (fs.existsSync(path)) {
        try {
          execSync(`chmod +x ${path}`);
          this.loggingService.log(
            `Executable permissions fixed for ${name}!`,
            'INFO',
            'bootstrap',
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.loggingService.log(
            `Failed to set executable permissions for ${name}: ${errorMessage}`,
            'ERROR',
            'bootstrap',
          );
        }
      } else {
        this.loggingService.log(
          `Warning: ${name} not found. Skipping permission fix.`,
          'WARN',
          'bootstrap',
        );
      }
    });
  }

  /** ✅ Register Miner with API */
  private async registerMiner(): Promise<boolean> {
    interface RegisterResponse {
      minerId: string;
      rigId?: string;
    }
    try {
      // Initialize config
      let config: MinerConfig = {
        minerId: undefined,
        rigId: undefined,
      };
      // Safely read existing config if available
      try {
        if (fs.existsSync(this.configPath)) {
          const rawConfig = fs.readFileSync(this.configPath, 'utf8');
          config = JSON.parse(rawConfig);
        }
      } catch (readError) {
        this.loggingService.log(
          `Config read error: ${String(readError)}`,
          'ERROR',
          'bootstrap',
        );
      }

      // Check if we already have a valid miner ID - if so, don't re-register
      if (
        config.minerId &&
        typeof config.minerId === 'string' &&
        config.minerId.length > 0
      ) {
        this.loggingService.log(
          `Using existing miner ID: ${config.minerId}`,
          'INFO',
          'bootstrap',
        );
        return true;
      }

      // Only register if we don't have a valid miner ID
      const metadata = this.deviceMonitoringService.getSystemInfo() as {
        osType: string;
        hwBrand: string;
        hwModel: string;
        os: string;
        cpuInfo: {
          architecture: string;
          model: string;
          cores: number;
          aesSupport: boolean;
          pmullSupport: boolean;
        };
      };
      const ipAddress = this.deviceMonitoringService.getIPAddress();
      
      // Add miningCpus to metadata for backend registration
      const cpuInfo = metadata.cpuInfo || {
        architecture: '64-bit',
        model: 'Unknown',
        cores: 1,
        aesSupport: false,
        pmullSupport: false,
      };

      const registrationMetadata = {
        ...metadata,
        miningCpus: cpuInfo.cores || 8, // Just the count, not an array
        lastSeenIp: ipAddress,
      };
      
      this.loggingService.log(
        `Registering with metadata: ${JSON.stringify(registrationMetadata, null, 2)}`,
        'DEBUG',
        'bootstrap',
      );
      
      const response = (await this.apiService.registerMiner(
        registrationMetadata,
        ipAddress,
      )) as RegisterResponse | undefined;
      if (
        response &&
        typeof response.minerId === 'string' &&
        response.minerId.length > 0
      ) {
        // Use the API's minerId and rigId
        config.minerId = response.minerId;
        config.rigId = response.rigId || '';
        // Save the updated config
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
        this.loggingService.log(
          `Miner registered with ID: ${response.minerId}`,
          'INFO',
          'bootstrap',
        );
        return true;
      } else {
        this.loggingService.log(
          'Registration failed: Invalid response from API',
          'ERROR',
          'bootstrap',
        );
        // Do NOT create any local/fallback minerId, just return false to keep the registration loop running
        return false;
      }
    } catch (error) {
      this.loggingService.log(
        `Registration failed: ${String(error)}`,
        'ERROR',
        'bootstrap',
      );
      // Do NOT create any local/fallback minerId, just return false to keep the registration loop running
      return false;
    }
  }

  /** ✅ Setup ADB optimizations for Termux */
  private setupAdbOptimizations() {
    try {
      this.loggingService.log(
        'Checking ADB availability on Termux...',
        'INFO',
        'bootstrap',
      );

      // Check if ADB is installed
      try {
        execSync('command -v adb', { stdio: 'ignore' });
      } catch {
        this.loggingService.log(
          'ADB not found, skipping power optimizations',
          'INFO',
          'bootstrap',
        );
        return;
      }

      // Reset ADB server to ensure fresh connection
      try {
        execSync('adb kill-server', { stdio: 'ignore' });
        this.loggingService.log('ADB server killed', 'DEBUG', 'bootstrap');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.loggingService.log(
          `Failed to kill ADB server: ${errorMessage}`,
          'DEBUG',
          'bootstrap',
        );
      }

      // Start ADB and check if it can connect to the device
      let adbWorks = false;

      // First attempt: Try ADB directly
      try {
        // Try to get device state - this will start the server if needed
        const deviceOutput = execSync('adb get-state', {
          encoding: 'utf8',
          timeout: 5000, // 5 second timeout
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

        if (deviceOutput === 'device') {
          adbWorks = true;
          this.loggingService.log(
            'ADB connection established successfully',
            'INFO',
            'bootstrap',
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.loggingService.log(
          `ADB not connected: ${errorMessage}`,
          'DEBUG',
          'bootstrap',
        );

        // Second attempt: Try to restart the server and establish connection
        try {
          // Explicitly kill and restart ADB server
          execSync('adb kill-server', { stdio: 'ignore' });
          this.loggingService.log(
            'Restarting ADB server...',
            'DEBUG',
            'bootstrap',
          );

          // Start server and check for devices
          // This specifically handles the "daemon not running; starting now" case
          const result = execSync('adb shell echo success', {
            encoding: 'utf8',
            timeout: 8000, // Give it more time to initialize
          }).trim();

          if (result.includes('success')) {
            adbWorks = true;
            this.loggingService.log(
              'ADB connection established after restart',
              'INFO',
              'bootstrap',
            );
          }
        } catch (restartError) {
          const restartErrorMessage = restartError instanceof Error ? restartError.message : String(restartError);
          this.loggingService.log(
            `ADB restart failed: ${restartErrorMessage}`,
            'DEBUG',
            'bootstrap',
          );

          // Third attempt: Check device list (sometimes works when the above fails)
          try {
            const devices = execSync('adb devices', {
              encoding: 'utf8',
              timeout: 5000,
            });

            // Check if any device is connected (not just "List of devices attached")
            if (devices.split('\n').length > 2 || devices.includes('device')) {
              adbWorks = true;
              this.loggingService.log(
                'ADB devices detected',
                'INFO',
                'bootstrap',
              );
            }
          } catch (devicesError) {
            const devicesErrorMessage = devicesError instanceof Error ? devicesError.message : String(devicesError);
            this.loggingService.log(
              `ADB devices check failed: ${devicesErrorMessage}`,
              'DEBUG',
              'bootstrap',
            );
          }
        }
      }

      if (!adbWorks) {
        this.loggingService.log(
          'ADB is installed but no devices are connected, skipping optimizations',
          'WARN',
          'bootstrap',
        );
        return;
      }

      // ADB is working - run optimization commands
      this.loggingService.log(
        'Applying power and performance optimizations via ADB...',
        'INFO',
        'bootstrap',
      );

      const adbCommands = [
        'adb shell dumpsys battery set level 100',
        'adb shell svc power stayon true',
        'adb shell dumpsys deviceidle whitelist +com.termux.boot',
        'adb shell dumpsys deviceidle whitelist +com.termux',
        'adb shell dumpsys deviceidle whitelist +com.termux.api',
        'adb shell settings put global system_capabilities 100',
        'adb shell settings put global sem_enhanced_cpu_responsiveness 1',
        'adb shell settings put global wifi_sleep_policy 2',
      ];

      let successCount = 0;
      for (const cmd of adbCommands) {
        try {
          execSync(cmd, { timeout: 3000 });
          successCount++;
        } catch (cmdError) {
          const cmdErrorMessage = cmdError instanceof Error ? cmdError.message : String(cmdError);
          this.loggingService.log(
            `Failed to run "${cmd}": ${cmdErrorMessage}`,
            'DEBUG',
            'bootstrap',
          );
        }
      }

      this.loggingService.log(
        `Power optimizations applied: ${successCount}/${adbCommands.length} succeeded`,
        'INFO',
        'bootstrap',
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.loggingService.log(
        `ADB optimization failed: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
      // Continue execution despite failures
    }
  }

  /** Verify that essential tools are available without installing packages */
  private async verifyEssentialTools(): Promise<void> {
    const essentialTools = [
      { command: 'curl', required: true, description: 'HTTP client for API communication' },
      { command: 'screen', required: true, description: 'Terminal multiplexer for background processes' },
      { command: 'git', required: false, description: 'Version control system' },
      { command: 'nc', required: false, description: 'Network connectivity testing' },
      { command: 'ping', required: false, description: 'Network connectivity testing' },
    ];

    const available: string[] = [];
    const missing: string[] = [];
    const criticalMissing: string[] = [];

    for (const tool of essentialTools) {
      try {
        execSync(`command -v ${tool.command}`, { stdio: 'ignore' });
        available.push(tool.command);
        this.loggingService.log(
          `✅ ${tool.command} is available`,
          'DEBUG',
          'bootstrap',
        );
      } catch {
        missing.push(tool.command);
        if (tool.required) {
          criticalMissing.push(tool.command);
          this.loggingService.log(
            `❌ CRITICAL: ${tool.command} is missing (${tool.description})`,
            'ERROR',
            'bootstrap',
          );
        } else {
          this.loggingService.log(
            `⚠️ Optional: ${tool.command} is missing (${tool.description})`,
            'WARN',
            'bootstrap',
          );
        }
      }
    }

    this.loggingService.log(
      `Tools available: ${available.length > 0 ? available.join(', ') : 'none'}`,
      'INFO',
      'bootstrap',
    );

    if (missing.length > 0) {
      this.loggingService.log(
        `Tools missing: ${missing.join(', ')}`,
        'WARN',
        'bootstrap',
      );
    }

    if (criticalMissing.length > 0) {
      this.loggingService.log(
        'CRITICAL TOOLS MISSING: RefurbMiner may not function properly.',
        'ERROR',
        'bootstrap',
      );
      this.loggingService.log(
        `Please install these tools manually: ${criticalMissing.join(', ')}`,
        'ERROR',
        'bootstrap',
      );
      this.loggingService.log(
        'Example: sudo apt-get install curl screen',
        'INFO',
        'bootstrap',
      );
    } else {
      this.loggingService.log(
        'All critical tools are available - RefurbMiner should function properly',
        'INFO',
        'bootstrap',
      );
    }
  }
}
