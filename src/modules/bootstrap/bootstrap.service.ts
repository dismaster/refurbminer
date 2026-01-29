import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { DeviceMonitoringService } from '../device-monitoring/device-monitoring.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { ConfigService } from '../config/config.service';
import * as fs from 'fs';
import { exec, ExecOptionsWithStringEncoding } from 'child_process';
import * as dotenv from 'dotenv';
import { promisify } from 'util';

type ExecOptionsString = Omit<ExecOptionsWithStringEncoding, 'encoding'> & {
  encoding?: BufferEncoding;
  stdio?: any;
};

const execAsync = promisify(exec) as (
  command: string,
  options?: ExecOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

const execCommand = async (
  command: string,
  options: ExecOptionsString = {},
): Promise<string> => {
  const { stdout } = await execAsync(command, {
    encoding: 'utf8',
    ...options,
  } as ExecOptionsWithStringEncoding);
  return stdout ?? '';
};

// Define config interface to fix TypeScript errors
interface MinerConfig {
  minerId?: string;
  rigId?: string;
  [key: string]: any; // Allow any other properties
}

@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly configPath = 'config/config.json'; // ✅ Define configPath

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  constructor(
    private readonly loggingService: LoggingService,
    private readonly apiService: ApiCommunicationService,
    private readonly deviceMonitoringService: DeviceMonitoringService,
    private readonly minerManagerService: MinerManagerService,
    private readonly configService: ConfigService, // <-- inject ConfigService
  ) {}

  async onModuleInit() {
    this.loggingService.log(
      'Initializing Bootstrap Service...',
      'INFO',
      'bootstrap',
    );
    await this.ensureConfigExists();
    await this.ensureEnvironmentVariables();

    // STEP 1: Install dependencies first (before registration needs network tools)
    this.loggingService.log(
      'Installing dependencies before registration...',
      'INFO',
      'bootstrap',
    );
    await this.verifyDependencies();
    await this.ensureExecutables();

    // STEP 1.5: Detect and fix any library issues early (before registration)
    this.loggingService.log(
      'Checking for system library issues...',
      'DEBUG',
      'bootstrap',
    );
    await this.detectAndFixLibraryIssues();

    // STEP 2: Registration process (now that network tools are available)
    // --- ENFORCE: Do not proceed until minerId is assigned by backend ---
    let validMinerID = false;

    // First check if we already have a valid miner ID
    const existingConfig = await this.configService.getConfig();
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
        validMinerID = await Promise.race([
          this.registerMiner(),
          new Promise<boolean>((_, reject) =>
            setTimeout(
              () => reject(new Error('Miner registration timeout after 30 seconds')),
              30000,
            ),
          ),
        ]);
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

    // STEP 3: Now that registration is complete, trigger config sync to get schedules and other config data
    this.loggingService.log(
      'Registration complete. Triggering optimized startup sequence...',
      'INFO',
      'bootstrap',
    );
    
    try {
      // Step 1: Trigger config sync to get schedules and configuration
      await this.configService.triggerConfigSyncAfterRegistration();
      this.loggingService.log(
        '✅ Config sync triggered successfully after registration',
        'INFO',
        'bootstrap',
      );

      // Step 2: Trigger initial flightsheet fetch and miner startup
      this.loggingService.log(
        'Triggering initial flightsheet fetch after successful registration...',
        'INFO',
        'bootstrap',
      );
      await this.minerManagerService.triggerInitialFlightsheetFetchAndStart();

      // Step 3: Perform system checks and optimizations
      await this.checkCPUCompatibility();

      // Step 4: Check if we're on Termux to run ADB optimizations and cleanup
      const osType = this.deviceMonitoringService.getOS();
      if (osType === 'termux') {
        await this.cleanupScreenSessions();
        await this.setupAdbOptimizations();
      }

      this.loggingService.log(
        '🎉 Optimized bootstrap process completed successfully!',
        'INFO',
        'bootstrap',
      );
    } catch (error) {
      this.loggingService.log(
        `⚠️ Error during startup sequence: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'bootstrap',
      );
    }
  }

  /** ✅ Ensure local configuration file exists */
  private async ensureConfigExists() {
    const configDir = 'config';

    await fs.promises.mkdir(configDir, { recursive: true }); // Ensure config directory exists

    if (!(await this.fileExists(this.configPath))) {
      this.loggingService.log(
        'Config file missing, creating new one...',
        'WARN',
        'bootstrap',
      );
      // Create empty config with NO minerId, so nothing can proceed until registration
      await fs.promises.writeFile(
        this.configPath,
        JSON.stringify({ minerId: '', rigId: '' }, null, 2),
      );
    }
  }

  /** ✅ Ensure required environment variables exist in .env file */
  private async ensureEnvironmentVariables() {
    const envPath = '.env';
    
    // Default environment variables that should always exist
    const requiredEnvVars = {
      'LOG_LEVEL': 'INFO',
      'LOG_TO_CONSOLE': 'true',
      'SEND_LOGS_TO_BACKEND': 'false',
      'BACKEND_LOG_LEVEL': 'WARN',
      'API_URL': 'https://api.refurbminer.de',
      'RIG_TOKEN': ''
    };

    let envContent = '';
    let needsUpdate = false;

    // Read existing .env file if it exists
    if (await this.fileExists(envPath)) {
      envContent = await fs.promises.readFile(envPath, 'utf8');
    } else {
      this.loggingService.log(
        '.env file missing, creating new one...',
        'WARN',
        'bootstrap',
      );
      needsUpdate = true;
    }

    // Check each required variable
    for (const [key, defaultValue] of Object.entries(requiredEnvVars)) {
      const regex = new RegExp(`^${key}=`, 'm');
      if (!regex.test(envContent)) {
        this.loggingService.log(
          `Adding missing environment variable: ${key}`,
          'INFO',
          'bootstrap',
        );
        
        // Add the variable to the appropriate section
        if (key.startsWith('LOG_') || key.includes('BACKEND_LOG') || key === 'SEND_LOGS_TO_BACKEND') {
          // Add to logging section
          if (!envContent.includes('##### Logging Module')) {
            envContent += '\n##### Logging Module\n';
            envContent += '# LOG_LEVEL controls verbosity: ERROR < WARN < INFO < DEBUG < VERBOSE\n';
          }
          if (key === 'SEND_LOGS_TO_BACKEND' && !envContent.includes('# Backend logging configuration')) {
            envContent += '\n# Backend logging configuration\n';
            envContent += '# Enable sending logs to backend via /error endpoint\n';
          }
          if (key === 'BACKEND_LOG_LEVEL' && !envContent.includes('# Backend log level')) {
            envContent += '# Backend log level - supports two modes:\n';
            envContent += '# 1. Hierarchical: WARN (sends ERROR + WARN), INFO (sends ERROR + WARN + INFO), etc.\n';
            envContent += '# 2. Explicit list: ERROR,SUCCESS (sends only ERROR and SUCCESS messages)\n';
            envContent += '# Available levels: ERROR, WARN, INFO, DEBUG, SUCCESS\n';
          }
        } else if (key.startsWith('API_') || key === 'RIG_TOKEN') {
          // Add to API section
          if (!envContent.includes('##### API settings')) {
            envContent += '\n##### API settings\n';
          }
        }

        // Ensure proper newline before adding variable if file doesn't end with newline
        if (envContent.length > 0 && !envContent.endsWith('\n')) {
          envContent += '\n';
        }
        
        envContent += `${key}=${defaultValue}\n`;
        needsUpdate = true;
      }
    }

    // Write updated .env file if needed
    if (needsUpdate) {
      await fs.promises.writeFile(envPath, envContent);
      this.loggingService.log(
        'Environment variables updated successfully',
        'INFO',
        'bootstrap',
      );
      
      // Reload environment variables
      dotenv.config();
    }
  }

  /** ✅ Check CPU Compatibility */
  private async checkCPUCompatibility() {
    try {
      const systemInfo = (await this.deviceMonitoringService.getSystemInfo()) as {
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
          hardware: ['lm-sensors', 'acpi', 'lshw'],
          compilation: ['make', 'clang', 'cmake'],
        },
        dnf: {
          essential: ['curl', 'screen', 'git'],
          network: ['nc', 'bind-utils', 'traceroute'],
          networkFallback: ['nmap-ncat', 'bind-utils', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi', 'lshw'],
          compilation: ['make', 'clang', 'cmake'],
        },
        yum: {
          essential: ['curl', 'screen', 'git'],
          network: ['nc', 'bind-utils', 'traceroute'],
          networkFallback: ['nmap-ncat', 'bind-utils', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi', 'lshw'],
          compilation: ['make', 'clang', 'cmake'],
        },
        pacman: {
          essential: ['curl', 'screen', 'git'],
          network: ['openbsd-netcat', 'bind-tools', 'traceroute'],
          networkFallback: ['gnu-netcat', 'bind', 'iputils'],
          system: ['gnupg', 'which'],
          hardware: ['lm_sensors', 'acpi', 'lshw'],
          compilation: ['make', 'clang', 'cmake'],
        },
        pkg: {
          essential: ['curl', 'screen', 'git'],
          network: ['netcat-openbsd', 'dnsutils', 'traceroute'],
          networkFallback: ['netcat', 'bind9-host', 'iputils-ping'],
          system: ['gnupg', 'debianutils'],
          hardware: ['lm-sensors', 'acpi', 'lshw'],
          compilation: ['make', 'clang', 'cmake'],
        },
      };

      // Check if sudo is available
      let hasSudo = false;
      try {
        await execCommand('command -v sudo', { stdio: 'ignore' });
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
            await execCommand(`command -v ${manager}`, { stdio: 'ignore' });
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
    // Increased timeout for slow networks/systems, especially Termux
    const timeoutMs = osType === 'termux' ? 120000 : 60000; // 2 minutes for Termux, 1 minute for others

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
  private async installPackageGroup(
    packageManager: string,
    sudoPrefix: string,
    packages: string[],
    logLevel: string,
    timeoutMs: number,
  ): Promise<boolean> {
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
        return false;
    }

    try {
      const stdio = logLevel === 'DEBUG' ? 'inherit' : 'ignore';
      await execCommand(installCommand, {
        stdio,
        timeout: timeoutMs,
      });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a timeout error - packages might have installed successfully
      if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
        this.loggingService.log(
          `Package installation timed out, verifying if packages were actually installed...`,
          'INFO',
          'bootstrap',
        );

        // Verify if packages were actually installed despite timeout
        const installedCount = await this.verifyPackagesInstalled(
          packages,
          packageManager,
        );
        if (installedCount > 0) {
          this.loggingService.log(
            `✅ Package installation succeeded despite timeout: ${installedCount}/${packages.length} packages installed`,
            'INFO',
            'bootstrap',
          );
          return true;
        }
      }

      this.loggingService.log(
        `Package group installation failed: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
      return false;
    }
  }

  /** Verify if packages were actually installed despite timeout */
  private async verifyPackagesInstalled(
    packages: string[],
    packageManager: string,
  ): Promise<number> {
    let installedCount = 0;

    for (const pkg of packages) {
      try {
        switch (packageManager) {
          case 'apt-get':
            // Check if package is installed using dpkg
            await execCommand(`dpkg -l ${pkg} 2>/dev/null | grep -q "^ii"`, {
              stdio: 'ignore',
            });
            installedCount++;
            break;
          case 'dnf':
          case 'yum':
            // Check if package is installed using rpm
            await execCommand(`rpm -q ${pkg}`, { stdio: 'ignore' });
            installedCount++;
            break;
          case 'pacman':
            // Check if package is installed using pacman
            await execCommand(`pacman -Qi ${pkg}`, { stdio: 'ignore' });
            installedCount++;
            break;
          case 'pkg':
            // Check if package is installed using pkg (Termux)
            await execCommand(
              `pkg list-installed ${pkg} 2>/dev/null | grep -q "${pkg}"`,
              { stdio: 'ignore' },
            );
            installedCount++;
            break;
          default:
            // Try generic command check for essential packages
            if (['curl', 'screen', 'git', 'make', 'clang', 'cmake'].includes(pkg)) {
              await execCommand(`command -v ${pkg}`, { stdio: 'ignore' });
              installedCount++;
            }
            break;
        }
      } catch {
        // Package not installed or verification failed
        continue;
      }
    }

    return installedCount;
  }

  /** Setup package repositories with better error handling */
  private async setupPackageRepositories(
    packageManager: string,
    sudoPrefix: string,
    osType: string,
  ): Promise<void> {
    // Handle Termux package repository switching
    if (packageManager === 'pkg') {
      await this.setupTermuxRepositories();
      return;
    }

    if (packageManager !== 'apt-get') {
      return;
    }

    try {
      // Update package lists first
      this.loggingService.log('Updating package lists...', 'INFO', 'bootstrap');
      await execCommand(`${sudoPrefix}apt-get update -qq`, {
        stdio: 'ignore',
        timeout: 30000,
      });
    } catch {
      this.loggingService.log(
        'Package list update failed, checking repositories...',
        'WARN',
        'bootstrap',
      );

      // Setup minimal repository if needed
      if (
        !(await this.fileExists('/etc/apt/sources.list')) ||
        (await fs.promises.readFile('/etc/apt/sources.list', 'utf8')).trim() === ''
      ) {
        try {
          const distro = (await execCommand(
            'lsb_release -sc 2>/dev/null || echo bookworm',
          )).trim();

          const sourcesList =
            osType === 'raspberry-pi'
              ? `deb http://deb.debian.org/debian ${distro} main\ndeb http://archive.raspberrypi.org/debian/ ${distro} main`
              : `deb http://deb.debian.org/debian ${distro} main`;

          await fs.promises.writeFile('/etc/apt/sources.list', sourcesList);

          this.loggingService.log(
            'Repository sources configured',
            'INFO',
            'bootstrap',
          );
          await execCommand(`${sudoPrefix}apt-get update -qq`, {
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
    }
  }

  /** Setup Termux repositories with fallback options */
  private async setupTermuxRepositories(): Promise<void> {
    const termuxRepos = [
      {
        name: 'Main Termux Repository',
        url: 'https://packages.termux.org/apt/termux-main',
        commands: ['pkg update'],
      },
      {
        name: 'Grimler Mirror (Europe)',
        url: 'https://grimler.se/termux-packages-24',
        commands: ['termux-change-repo', 'pkg update'],
      },
      {
        name: 'Albatross Mirror (Asia)',
        url: 'https://albatross.termux-mirror.ml',
        commands: [
          'sed -i "s@packages.termux.org@albatross.termux-mirror.ml@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'Kcubeterm Mirror (Global)',
        url: 'https://dl.kcubeterm.me',
        commands: [
          'sed -i "s@packages.termux.org@dl.kcubeterm.me@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'BFSU Mirror (China)',
        url: 'https://mirrors.bfsu.edu.cn/termux/apt/termux-main',
        commands: [
          'sed -i "s@packages.termux.org@mirrors.bfsu.edu.cn/termux@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'Tsinghua Mirror (China)',
        url: 'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main',
        commands: [
          'sed -i "s@packages.termux.org@mirrors.tuna.tsinghua.edu.cn/termux@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'USTC Mirror (China)',
        url: 'https://mirrors.ustc.edu.cn/termux/apt/termux-main',
        commands: [
          'sed -i "s@packages.termux.org@mirrors.ustc.edu.cn/termux@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'NJU Mirror (China)',
        url: 'https://mirrors.nju.edu.cn/termux/apt/termux-main',
        commands: [
          'sed -i "s@packages.termux.org@mirrors.nju.edu.cn/termux@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
      {
        name: 'Haruna Mirror (Japan)',
        url: 'https://termux.haruna.dev/apt/termux-main',
        commands: [
          'sed -i "s@packages.termux.org@termux.haruna.dev@g" $PREFIX/etc/apt/sources.list',
          'pkg update',
        ],
      },
    ];

    let repoWorking = false;
    let lastError = '';

    // First, try to update with current repository with shorter timeout
    try {
      this.loggingService.log(
        'Testing current Termux repository speed...',
        'INFO',
        'bootstrap',
      );
      await execCommand('pkg update', { stdio: 'ignore', timeout: 15000 }); // Shorter timeout for speed test
      
      // Test actual package download speed with a small package
      this.loggingService.log(
        'Testing package download speed...',
        'INFO',
        'bootstrap',
      );
      await execCommand('pkg install -y --download-only curl', { stdio: 'ignore', timeout: 10000 });
      
      repoWorking = true;
      this.loggingService.log(
        'Current repository working with good speed',
        'INFO',
        'bootstrap',
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      lastError = errorMessage;
      this.loggingService.log(
        `Current repository too slow or failed: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
    }

    // If current repo doesn't work, try alternatives
    if (!repoWorking) {
      this.loggingService.log(
        'Attempting to switch to alternative Termux repositories...',
        'INFO',
        'bootstrap',
      );

      for (const repo of termuxRepos.slice(1)) { // Skip the main repo since we tried it
        try {
          this.loggingService.log(
            `Trying ${repo.name}...`,
            'INFO',
            'bootstrap',
          );

          // Execute repository switch commands
          for (const command of repo.commands) {
            if (command === 'termux-change-repo') {
              // Use termux-change-repo if available
              try {
                await execCommand('command -v termux-change-repo', { stdio: 'ignore' });
                await execCommand('echo -e "1\n1" | termux-change-repo', {
                  stdio: 'ignore',
                  timeout: 30000,
                });
              } catch {
                // If termux-change-repo not available, skip this repo
                continue;
              }
            } else {
              await execCommand(command, { stdio: 'ignore', timeout: 45000 });
            }
          }

          repoWorking = true;
          this.loggingService.log(
            `Successfully switched to ${repo.name}`,
            'INFO',
            'bootstrap',
          );
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.loggingService.log(
            `${repo.name} failed: ${errorMessage}`,
            'WARN',
            'bootstrap',
          );
          lastError = errorMessage;
        }
      }
    }

    if (!repoWorking) {
      this.loggingService.log(
        `All Termux repositories failed. Last error: ${lastError}`,
        'ERROR',
        'bootstrap',
      );
      this.loggingService.log(
        'Continuing with package installation, but some packages may fail...',
        'WARN',
        'bootstrap',
      );
    }
  }

  /** Install individual network tools as fallback */
  private async installIndividualNetworkTools(
    packageManager: string,
    sudoPrefix: string,
    logLevel: string,
  ): Promise<void> {
    const networkTools = [
      { pkg: 'netcat-openbsd', alt: 'netcat' },
      { pkg: 'dnsutils', alt: 'bind9-host' },
      { pkg: 'iputils-ping', alt: 'ping' },
    ];

    for (const tool of networkTools) {
      for (const pkgName of [tool.pkg, tool.alt]) {
        try {
          const command = `${sudoPrefix}${packageManager} install -yq ${pkgName}`;
          await execCommand(command, {
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
  }

  /** Verify that critical network tools are available */
  private async verifyNetworkTools(): Promise<void> {
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
        await execCommand(`command -v ${tool.cmd}`, { stdio: 'ignore' });
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
  }

  /** ✅ Ensure miner executables are runnable */
  private async ensureExecutables() {
    const executables = [
      { path: 'apps/ccminer/ccminer', name: 'ccminer' },
      { path: 'apps/xmrig/xmrig', name: 'xmrig' },
      { path: 'apps/vcgencmd/vcgencmd', name: 'vcgencmd' },
    ];

    for (const { path, name } of executables) {
      if (await this.fileExists(path)) {
        try {
          await execCommand(`chmod +x ${path}`);
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
    }
  }

  /**
   * Detect and fix missing library issues on Termux/Linux
   * Specifically handles libcrypto.so.3 and other common library problems
   */
  private async detectAndFixLibraryIssues(): Promise<void> {
    try {
      this.loggingService.log(
        '🔍 Checking for missing library issues...',
        'DEBUG',
        'bootstrap',
      );

      const osType = this.deviceMonitoringService.getOS();
      if (osType !== 'termux') {
        return; // Skip on non-Termux systems for now
      }

      // Test critical commands that depend on system libraries
      const criticalCommands = [
        { cmd: 'screen -ls', name: 'screen', dependsOn: 'libtermux-auth.so' },
        { cmd: 'chmod --version', name: 'chmod', dependsOn: 'libc.so' },
        { cmd: 'ls -la /tmp', name: 'ls', dependsOn: 'libc.so' },
      ];

      let foundIssues = false;

      for (const test of criticalCommands) {
        try {
          await execCommand(test.cmd, { stdio: 'ignore', timeout: 5000 });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          // Check if this is a library error
          if (
            errorMsg.includes('CANNOT LINK EXECUTABLE') ||
            errorMsg.includes('library') ||
            errorMsg.includes('not found')
          ) {
            foundIssues = true;
            this.loggingService.log(
              `⚠️ Library issue detected with '${test.name}': ${errorMsg}`,
              'WARN',
              'bootstrap',
            );

            // Attempt to fix OpenSSL-related issues
            if (
              errorMsg.includes('libcrypto') ||
              errorMsg.includes('libtermux-auth')
            ) {
              await this.fixOpenSSLIssue();
            }
          }
        }
      }

      if (!foundIssues) {
        this.loggingService.log(
          '✅ No library issues detected',
          'DEBUG',
          'bootstrap',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `⚠️ Library detection check failed: ${error instanceof Error ? error.message : String(error)}`,
        'WARN',
        'bootstrap',
      );
      // Don't fail bootstrap if check fails
    }
  }

  /**
   * Fix OpenSSL library issues by reinstalling package
   */
  private async fixOpenSSLIssue(): Promise<void> {
    try {
      this.loggingService.log(
        '🔧 Attempting to fix OpenSSL library issue...',
        'INFO',
        'bootstrap',
      );

      // Force reinstall openssl to extract all files
      await execCommand('pkg install --reinstall openssl -y', {
        timeout: 300000, // 5 minutes
      });

      this.loggingService.log(
        '✅ OpenSSL successfully reinstalled',
        'INFO',
        'bootstrap',
      );

      // Verify the fix by testing a command
      try {
        await execCommand('screen -ls', { stdio: 'ignore', timeout: 5000 });
        this.loggingService.log(
          '✅ Library fix verified - screen command working',
          'INFO',
          'bootstrap',
        );
      } catch {
        this.loggingService.log(
          '⚠️ Screen still not working after OpenSSL fix, may need manual intervention',
          'WARN',
          'bootstrap',
        );
      }
    } catch (fixError) {
      this.loggingService.log(
        `⚠️ Failed to fix OpenSSL issue: ${fixError instanceof Error ? fixError.message : String(fixError)}`,
        'WARN',
        'bootstrap',
      );
      // Don't fail, continue with bootstrap
    }
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
        if (await this.fileExists(this.configPath)) {
          const rawConfig = await fs.promises.readFile(this.configPath, 'utf8');
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
      const metadata = (await this.deviceMonitoringService.getSystemInfo()) as {
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
      const ipAddress = await this.deviceMonitoringService.getIPAddress();
      
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
        // Get the full config from ConfigService and update it
        const fullConfig = await this.configService.getConfig();
        if (fullConfig) {
          fullConfig.minerId = response.minerId;
          fullConfig.rigId = response.rigId || '';
          // Save the updated config using ConfigService to ensure cache is updated
          await this.configService.saveConfig(fullConfig);
          this.loggingService.log(
            `Registered minerId ${response.minerId} saved to config`,
            'INFO',
            'bootstrap',
          );
        } else {
          this.loggingService.log(
            'Could not get full config to save minerId',
            'ERROR',
            'bootstrap',
          );
        }
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
  private async setupAdbOptimizations() {
    try {
      this.loggingService.log(
        'Checking ADB availability on Termux...',
        'INFO',
        'bootstrap',
      );

      // Check if ADB is installed
      try {
        await execCommand('command -v adb', { stdio: 'ignore' });
      } catch {
        this.loggingService.log(
          'ADB not found, skipping power optimizations',
          'INFO',
          'bootstrap',
        );
        return;
      }

      // Enhanced ADB cleanup - kill any stuck processes and clean up sockets
      try {
        await execCommand('pkill -f adb 2>/dev/null || true', { stdio: 'ignore' });
        await execCommand('adb kill-server 2>/dev/null || true', { stdio: 'ignore' });
        await execCommand('rm -f /tmp/adb.*.log 2>/dev/null || true', { stdio: 'ignore' });
        this.loggingService.log('ADB cleanup completed', 'DEBUG', 'bootstrap');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.loggingService.log(
          `ADB cleanup had issues: ${errorMessage}`,
          'DEBUG',
          'bootstrap',
        );
      }

      // Check for common ADB failure indicators
      const adbDiagnostics = await this.performAdbDiagnostics();
      if (!adbDiagnostics.canProceed) {
        this.loggingService.log(
          `ADB compatibility issues detected: ${adbDiagnostics.reason}. Skipping optimizations.`,
          'WARN',
          'bootstrap',
        );
        return;
      }

      // Start ADB and check if it can connect to the device
      let adbWorks = false;
      let lastError = '';

      // First attempt: Try ADB directly with enhanced error detection
      try {
        const deviceOutput = (await execCommand('adb get-state', {
          timeout: 6000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })).trim();

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
        lastError = errorMessage;
        
        // Check for specific error patterns
        if (errorMessage.includes('libusb')) {
          this.loggingService.log(
            'ADB hardware access (libusb) failed - device may not support USB debugging features',
            'DEBUG',
            'bootstrap',
          );
        } else if (errorMessage.includes('Address already in use')) {
          this.loggingService.log(
            'ADB socket conflict detected - multiple daemon instances',
            'DEBUG',
            'bootstrap',
          );
        } else {
          this.loggingService.log(
            `ADB not connected: ${errorMessage}`,
            'DEBUG',
            'bootstrap',
          );
        }

        // Second attempt: More aggressive restart with better error handling
        if (!errorMessage.includes('libusb') && !errorMessage.includes('LIBUSB_ERROR_IO')) {
          try {
            // More thorough cleanup
            await execCommand('pkill -9 -f adb 2>/dev/null || true', { stdio: 'ignore' });
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            this.loggingService.log(
              'Attempting ADB server restart with clean slate...',
              'DEBUG',
              'bootstrap',
            );

            // Try a simpler test command
            const result = (await execCommand('adb shell echo "test"', {
              timeout: 10000,
            })).trim();

            if (result.includes('test')) {
              adbWorks = true;
              this.loggingService.log(
                'ADB connection established after aggressive restart',
                'INFO',
                'bootstrap',
              );
            }
          } catch (restartError) {
            const restartErrorMessage = restartError instanceof Error ? restartError.message : String(restartError);
            this.loggingService.log(
              `ADB aggressive restart failed: ${restartErrorMessage}`,
              'DEBUG',
              'bootstrap',
            );

            // Final attempt: Check if we can at least see the device in list
            try {
              const devices = await execCommand('adb devices', {
                timeout: 5000,
              });

              const deviceLines = devices.split('\n')
                .filter(line => line.trim() && !line.includes('List of devices'))
                .filter(line => line.includes('device') || line.includes('unauthorized'));

              if (deviceLines.length > 0) {
                adbWorks = true;
                this.loggingService.log(
                  `ADB devices detected: ${deviceLines.length} device(s) found`,
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
      }

      if (!adbWorks) {
        // Provide more specific feedback based on the type of failure
        if (lastError.includes('libusb') || lastError.includes('LIBUSB_ERROR_IO')) {
          this.loggingService.log(
            'ADB hardware access unavailable on this device (libusb initialization failed). This is common on some Android devices and can be safely ignored.',
            'INFO',
            'bootstrap',
          );
        } else if (lastError.includes('Address already in use')) {
          this.loggingService.log(
            'ADB daemon conflicts detected. Power optimizations skipped to avoid system instability.',
            'WARN',
            'bootstrap',
          );
        } else {
          this.loggingService.log(
            'ADB is installed but no devices are connected, skipping optimizations',
            'WARN',
            'bootstrap',
          );
        }
        return;
      }

      // ADB is working - run optimization commands with better error categorization
      this.loggingService.log(
        'Applying power and performance optimizations via ADB...',
        'INFO',
        'bootstrap',
      );

      const adbCommands = [
        { cmd: 'adb shell dumpsys battery set level 100', desc: 'Battery level optimization' },
        { cmd: 'adb shell svc power stayon true', desc: 'Keep screen/CPU active' },
        { cmd: 'adb shell dumpsys deviceidle whitelist +com.termux.boot', desc: 'Termux boot whitelist' },
        { cmd: 'adb shell dumpsys deviceidle whitelist +com.termux', desc: 'Termux app whitelist' },
        { cmd: 'adb shell dumpsys deviceidle whitelist +com.termux.api', desc: 'Termux API whitelist' },
        { cmd: 'adb shell settings put global system_capabilities 100', desc: 'System capabilities optimization' },
        { cmd: 'adb shell settings put global sem_enhanced_cpu_responsiveness 1', desc: 'Enhanced CPU responsiveness' },
        { cmd: 'adb shell settings put global wifi_sleep_policy 2', desc: 'WiFi sleep optimization' },
      ];

      let successCount = 0;
      let criticalFailures = 0;

      for (const { cmd, desc } of adbCommands) {
        try {
          await execCommand(cmd, { timeout: 4000, stdio: ['ignore', 'ignore', 'pipe'] });
          successCount++;
          this.loggingService.log(`✓ ${desc}`, 'DEBUG', 'bootstrap');
        } catch (cmdError) {
          const cmdErrorMessage = cmdError instanceof Error ? cmdError.message : String(cmdError);
          
          // Count critical failures (permission/system issues vs minor ones)
          if (cmdErrorMessage.includes('permission') || cmdErrorMessage.includes('denied')) {
            criticalFailures++;
            this.loggingService.log(
              `✗ ${desc}: Permission denied (requires root/system access)`,
              'DEBUG',
              'bootstrap',
            );
          } else {
            this.loggingService.log(
              `✗ ${desc}: ${cmdErrorMessage}`,
              'DEBUG',
              'bootstrap',
            );
          }
        }
      }

      if (successCount > 0) {
        this.loggingService.log(
          `✅ Power optimizations applied: ${successCount}/${adbCommands.length} succeeded`,
          'INFO',
          'bootstrap',
        );
      } else {
        this.loggingService.log(
          `⚠️ No power optimizations could be applied (${criticalFailures} permission issues)`,
          'WARN',
          'bootstrap',
        );
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.loggingService.log(
        `ADB optimization process failed: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
      // Continue execution despite failures
    }
  }

  /**
   * Perform ADB diagnostics to detect common failure scenarios
   */
  private async performAdbDiagnostics(): Promise<{ canProceed: boolean; reason: string }> {
    try {
      // Test 1: Check if we can run adb version (basic functionality)
      try {
        const versionOutput = await execCommand('adb version', { 
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        if (!versionOutput.includes('Android Debug Bridge')) {
          return { canProceed: false, reason: 'ADB version check failed' };
        }
      } catch (versionError) {
        return { canProceed: false, reason: 'ADB binary is corrupted or incompatible' };
      }

      // Test 2: Quick daemon start test to detect immediate failures
      try {
        await execCommand('timeout 3 adb start-server 2>&1', { 
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (startError) {
        const errorMsg = startError instanceof Error ? startError.message : String(startError);
        
        if (errorMsg.includes('libusb') || errorMsg.includes('LIBUSB_ERROR')) {
          return { canProceed: false, reason: 'Hardware access (libusb) unavailable on this device' };
        }
        
        if (errorMsg.includes('Address already in use')) {
          return { canProceed: false, reason: 'ADB daemon conflicts detected' };
        }
      }

      return { canProceed: true, reason: 'ADB appears functional' };
    } catch (diagError) {
      return { canProceed: false, reason: 'ADB diagnostics failed' };
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
        await execCommand(`command -v ${tool.command}`, { stdio: 'ignore' });
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

  /** Clean up dead screen sessions only (not detached ones that might be running) */
  private async cleanupScreenSessions(): Promise<void> {
    this.loggingService.log(
      'Cleaning up dead screen sessions...',
      'INFO',
      'bootstrap',
    );

    try {
      // Get list of screen sessions
      const screenList = (await execCommand('screen -list', {
        stdio: 'pipe',
      })).trim();

      this.loggingService.log(
        `Current screen sessions: ${screenList}`,
        'DEBUG',
        'bootstrap',
      );

      // Only find truly dead sessions (not detached ones that might be running)
      const deadSessions = screenList
        .split('\n')
        .filter((line) => line.includes('Dead') || line.includes('Remote or dead'))
        .map((line) => {
          const match = line.match(/^\s*(\d+\.\S+)/);
          return match ? match[1] : null;
        })
        .filter((sessionId) => sessionId !== null);

      if (deadSessions.length > 0) {
        // Kill only dead sessions, leave detached ones alone
        for (const sessionId of deadSessions) {
          this.loggingService.log(
            `Killing dead screen session: ${sessionId}`,
            'INFO',
            'bootstrap',
          );
          try {
            await execCommand(`screen -S ${sessionId} -X quit`, { stdio: 'ignore' });
          } catch (error) {
            // Session might already be gone, ignore errors
          }
        }

        this.loggingService.log(
          `Cleaned up ${deadSessions.length} dead screen sessions`,
          'INFO',
          'bootstrap',
        );
      } else {
        this.loggingService.log(
          'No dead screen sessions found to clean up',
          'INFO',
          'bootstrap',
        );
      }

      // ✅ ADD THIS: Clean up all dead socket files with screen -wipe
      try {
        await execCommand('screen -wipe', { stdio: 'ignore' });
        this.loggingService.log(
          'Cleaned up dead screen socket files with screen -wipe',
          'DEBUG',
          'bootstrap',
        );
      } catch (error) {
        // screen -wipe can fail if no sockets to clean, that's fine
        this.loggingService.log(
          'No dead screen sockets to clean up with screen -wipe',
          'DEBUG',
          'bootstrap',
        );
      }

      // ✅ ADD THIS: Force remove stubborn socket files directly
      try {
        const screenDir = `${process.env.HOME}/.screen`;
        if (await this.fileExists(screenDir)) {
          // Get current screen list after wipe to see what's still there
          const remainingList = (await execCommand('screen -list 2>/dev/null || true', {
            stdio: 'pipe',
          })).trim();

          // Find socket files that correspond to "Remote or dead" sessions
          const deadSocketsToRemove = remainingList
            .split('\n')
            .filter((line) => line.includes('Dead') || line.includes('Remote or dead'))
            .map((line) => {
              const match = line.match(/^\s*(\d+\.\S+)/);
              return match ? match[1] : null;
            })
            .filter((sessionId) => sessionId !== null);

          if (deadSocketsToRemove.length > 0) {
            let removedCount = 0;
            for (const sessionId of deadSocketsToRemove) {
              const socketPath = `${screenDir}/${sessionId}`;
              try {
                if (await this.fileExists(socketPath)) {
                  await fs.promises.unlink(socketPath);
                  removedCount++;
                  this.loggingService.log(
                    `Force removed dead socket: ${sessionId}`,
                    'DEBUG',
                    'bootstrap',
                  );
                }
              } catch (removeError) {
                this.loggingService.log(
                  `Could not remove socket ${sessionId}: ${removeError instanceof Error ? removeError.message : String(removeError)}`,
                  'DEBUG',
                  'bootstrap',
                );
              }
            }

            if (removedCount > 0) {
              this.loggingService.log(
                `Force removed ${removedCount} stubborn socket files`,
                'INFO',
                'bootstrap',
              );
            }
          }
        }
      } catch (forceError) {
        this.loggingService.log(
          `Force socket cleanup failed: ${forceError instanceof Error ? forceError.message : String(forceError)}`,
          'DEBUG',
          'bootstrap',
        );
      }

      // Log remaining detached sessions but don't kill them
      const detachedSessions = screenList
        .split('\n')
        .filter((line) => line.includes('Detached'))
        .length;

      if (detachedSessions > 0) {
        this.loggingService.log(
          `Found ${detachedSessions} detached screen sessions (leaving them running)`,
          'INFO',
          'bootstrap',
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.loggingService.log(
        `Screen cleanup error: ${errorMessage}`,
        'WARN',
        'bootstrap',
      );
    }
  }
}
