import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';
import { OsDetectionService } from '../device-monitoring/os-detection/os-detection.service';
import { ConfigService } from '../config/config.service';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  MinerInfo,
  SystemCompatibility,
  MinerValidationResult,
  DownloadInfo,
} from './interfaces/miner-software.interface';

@Injectable()
export class MinerSoftwareService {
  private readonly supportedMiners = ['ccminer', 'xmrig'];
  private readonly appsDir = path.join(process.cwd(), 'apps');

  constructor(
    private readonly loggingService: LoggingService,
    private readonly osDetectionService: OsDetectionService,
    private readonly configService: ConfigService,
  ) {}
  /**
   * Check CPU compatibility based on your installer logic
   */
  checkCPUCompatibility(): SystemCompatibility {
    const osType = this.osDetectionService.detectOS();
    
    let cpuFlags: string[] = [];
    let is64Bit = false;
    let hasAES = false;
    let hasPMULL = false;
    let isTermux = false;
    let hasRoot = false;

    try {
      // Check if running in Termux
      isTermux = process.env.PREFIX?.includes('termux') || false;

      // Check for root access
      if (isTermux) {
        try {
          execSync('command -v su', { stdio: 'pipe' });
          hasRoot = true;
        } catch {
          hasRoot = false;
        }
      } else {
        hasRoot = process.getuid ? process.getuid() === 0 : false;
      }      // Get CPU information
      const cpuInfo = execSync('lscpu 2>/dev/null || cat /proc/cpuinfo', {
        encoding: 'utf8',
      });

      // Check for 64-bit support
      is64Bit = cpuInfo.includes('64-bit') || cpuInfo.includes('x86_64') || cpuInfo.includes('aarch64');

      // Extract CPU flags - multiple methods like in your installer
      if (cpuInfo.includes('Flags:')) {
        const flagsMatch = cpuInfo.match(/Flags:\s*(.+)/);
        if (flagsMatch) {
          cpuFlags = flagsMatch[1].split(/\s+/);
        }
      } else if (cpuInfo.includes('flags')) {
        const flagsMatch = cpuInfo.match(/flags\s*:\s*(.+)/);
        if (flagsMatch) {
          cpuFlags = flagsMatch[1].split(/\s+/);
        }
      } else if (cpuInfo.includes('Features')) {
        // ARM format
        const featuresMatch = cpuInfo.match(/Features\s*:\s*(.+)/);
        if (featuresMatch) {
          cpuFlags = featuresMatch[1].split(/\s+/);
        }
      }

      // Check for essential features
      hasAES = cpuFlags.some(flag => flag.toLowerCase().includes('aes'));
      hasPMULL = cpuFlags.some(flag => 
        flag.toLowerCase().includes('pmull') || 
        flag.toLowerCase().includes('pclmul')
      );

    } catch (error) {
      this.loggingService.log(
        `Error checking CPU compatibility: ${error.message}`,
        'ERROR',
        'miner-software'
      );
    }

    return {
      os: osType,
      architecture: process.arch,
      cpuFlags,
      hasAES,
      hasPMULL,
      is64Bit,
      isTermux,
      hasRoot,
    };
  }

  /**
   * Get miner information
   */
  getMinerInfo(minerName: string): MinerInfo {
    const minerPath = path.join(this.appsDir, minerName, minerName);
    const configPath = path.join(this.appsDir, minerName, 'config.json');
    
    let version = 'unknown';
    let exists = false;
    let executable = false;
    let compatible = false;

    try {
      exists = fs.existsSync(minerPath);
      
      if (exists) {
        // Check if executable
        try {
          fs.accessSync(minerPath, fs.constants.X_OK);
          executable = true;
        } catch {
          executable = false;
        }

        // Try to get version
        try {
          const versionOutput = execSync(`${minerPath} --version 2>/dev/null || ${minerPath} --help 2>/dev/null`, {
            encoding: 'utf8',
            timeout: 5000,
          });
          
          if (minerName === 'ccminer') {
            const versionMatch = versionOutput.match(/ccminer\s+(\d+\.\d+\.\d+)/i);
            version = versionMatch ? versionMatch[1] : 'unknown';
          } else if (minerName === 'xmrig') {
            const versionMatch = versionOutput.match(/XMRig\s+(\d+\.\d+\.\d+)/i);
            version = versionMatch ? versionMatch[1] : 'unknown';
          }

          compatible = true;
        } catch (error) {
          this.loggingService.log(
            `Failed to get version for ${minerName}: ${error.message}`,
            'WARN',
            'miner-software'
          );
        }
      }
    } catch (error) {
      this.loggingService.log(
        `Error getting miner info for ${minerName}: ${error.message}`,
        'ERROR',
        'miner-software'
      );
    }

    return {
      name: minerName,
      version,
      path: minerPath,
      exists,
      executable,
      compatible,
    };
  }

  /**
   * Validate specific miner based on your installer logic
   */
  async validateMiner(minerName: string): Promise<MinerValidationResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    if (!this.supportedMiners.includes(minerName)) {
      issues.push(`Unsupported miner: ${minerName}`);
      return { valid: false, issues, recommendations };
    }

    const compatibility = await this.checkCPUCompatibility();
    const minerInfo = this.getMinerInfo(minerName);

    // Check CPU compatibility
    if (!compatibility.is64Bit) {
      issues.push('CPU does not support 64-bit operations');
    }

    if (!compatibility.hasAES) {
      issues.push('CPU does not support AES instructions (required for mining)');
    }

    if (!compatibility.hasPMULL && minerName === 'ccminer') {
      recommendations.push('CPU does not support PMULL/PCLMUL instructions (may impact performance)');
    }

    // Check miner binary
    if (!minerInfo.exists) {
      issues.push(`Miner binary not found at ${minerInfo.path}`);
      recommendations.push(`Run installation for ${minerName}`);
    } else {
      if (!minerInfo.executable) {
        issues.push(`Miner binary is not executable`);
        recommendations.push(`Set executable permissions: chmod +x ${minerInfo.path}`);
      }

      if (!minerInfo.compatible) {
        issues.push(`Miner binary failed compatibility test`);
        recommendations.push(`Reinstall ${minerName} for your system`);
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      recommendations,
    };
  }

  /**
   * Get download information based on your installer logic
   */
  getDownloadInfo(minerName: string, compatibility: SystemCompatibility): DownloadInfo | null {
    if (minerName === 'ccminer') {
      return this.getCcminerDownloadInfo(compatibility);
    } else if (minerName === 'xmrig') {
      return this.getXmrigDownloadInfo(compatibility);
    }
    
    return null;
  }

  /**
   * Get ccminer download info based on OS and architecture (from your installer)
   */
  private getCcminerDownloadInfo(compatibility: SystemCompatibility): DownloadInfo | null {
    const { os, architecture, isTermux } = compatibility;

    // Handle Termux specifically
    if (isTermux) {
      return {
        url: 'SOURCE_BUILD', // Indicates needs source build
        filename: 'ccminer',
        needsExtraction: false,
      };
    }

    // Handle different OS types based on your installer logic
    if (os === 'linux') {
      if (architecture === 'arm64' || architecture === 'aarch64') {
        // ARM64 Linux - may need source build for optimal performance
        return {
          url: 'https://github.com/tpruvot/ccminer/releases/download/v3.8.3/ccminer-linux-arm64',
          filename: 'ccminer',
          needsExtraction: false,
        };
      } else if (architecture === 'x64' || architecture === 'x86_64') {
        return {
          url: 'https://github.com/tpruvot/ccminer/releases/download/v3.8.3/ccminer-linux-x64',
          filename: 'ccminer',
          needsExtraction: false,
        };
      }
    }

    // For other cases, recommend source build
    return {
      url: 'SOURCE_BUILD',
      filename: 'ccminer',
      needsExtraction: false,
    };
  }

  /**
   * Get xmrig download info (basic implementation for now)
   */
  private getXmrigDownloadInfo(compatibility: SystemCompatibility): DownloadInfo | null {
    const { os, architecture } = compatibility;

    if (os === 'linux') {
      if (architecture === 'arm64' || architecture === 'aarch64') {
        return {
          url: 'https://github.com/xmrig/xmrig/releases/download/v6.22.3/xmrig-6.22.3-linux-static-arm64.tar.gz',
          filename: 'xmrig-6.22.3-linux-static-arm64.tar.gz',
          needsExtraction: true,
          extractCommand: 'tar -xzf xmrig-6.22.3-linux-static-arm64.tar.gz --strip-components=1',
        };
      } else if (architecture === 'x64' || architecture === 'x86_64') {
        return {
          url: 'https://github.com/xmrig/xmrig/releases/download/v6.22.3/xmrig-6.22.3-linux-static-x64.tar.gz',
          filename: 'xmrig-6.22.3-linux-static-x64.tar.gz',
          needsExtraction: true,
          extractCommand: 'tar -xzf xmrig-6.22.3-linux-static-x64.tar.gz --strip-components=1',
        };
      }
    }

    return null;
  }

  /**
   * Get all available miners status
   */
  async getAllMinersStatus(): Promise<Record<string, MinerInfo & { validation: MinerValidationResult }>> {
    const result: Record<string, MinerInfo & { validation: MinerValidationResult }> = {};

    for (const minerName of this.supportedMiners) {
      const info = this.getMinerInfo(minerName);
      const validation = await this.validateMiner(minerName);
      
      result[minerName] = {
        ...info,
        validation,
      };
    }

    return result;
  }

  /**
   * Ensure apps directory exists
   */
  private ensureAppsDirectory(): void {
    if (!fs.existsSync(this.appsDir)) {
      fs.mkdirSync(this.appsDir, { recursive: true });
    }
  }

  /**
   * Set executable permissions for miner
   */
  async setExecutablePermissions(minerName: string): Promise<boolean> {
    try {
      const minerPath = path.join(this.appsDir, minerName, minerName);
      
      if (fs.existsSync(minerPath)) {
        execSync(`chmod +x ${minerPath}`);
        this.loggingService.log(
          `Set executable permissions for ${minerName}`,
          'INFO',
          'miner-software'
        );
        return true;
      }
      
      return false;
    } catch (error) {
      this.loggingService.log(
        `Failed to set executable permissions for ${minerName}: ${error.message}`,
        'ERROR',
        'miner-software'
      );
      return false;
    }
  }

  /**
   * Select optimal ccminer branch based on CPU architecture (from your installer logic)
   */
  async selectCcminerBranch(compatibility: SystemCompatibility): Promise<string> {
    try {
      // Get detailed CPU information
      const cpuInfo = execSync('lscpu 2>/dev/null || cat /proc/cpuinfo', { 
        encoding: 'utf8' 
      });

      // Extract CPU model and architecture
      let cpuModel = '';
      let cpuArch = compatibility.architecture;

      // Try to get CPU model from lscpu output
      const modelMatch = cpuInfo.match(/Model name\s*:\s*(.+)/);
      if (modelMatch) {
        cpuModel = modelMatch[1].trim();
      } else {
        // Fallback to /proc/cpuinfo format
        const procModelMatch = cpuInfo.match(/model name\s*:\s*(.+)/);
        if (procModelMatch) {
          cpuModel = procModelMatch[1].trim();
        }
      }

      // Try to get architecture from lscpu if available
      const archMatch = cpuInfo.match(/Architecture\s*:\s*(.+)/);
      if (archMatch) {
        cpuArch = archMatch[1].trim();
      }

      this.loggingService.log(
        `CPU model: ${cpuModel}, Architecture: ${cpuArch}`,
        'INFO',
        'miner-software'
      );

      let ccBranch = 'generic';

      // Parse complex CPU model names - prioritize Exynos custom cores first
      if (cpuModel.includes('exynos-m3')) {
        if (cpuModel.includes('A55')) {
          ccBranch = 'em3-a55';
          this.loggingService.log('Detected Exynos M3 with Cortex-A55', 'INFO', 'miner-software');
        } else {
          ccBranch = 'em3';
          this.loggingService.log('Detected Exynos M3', 'INFO', 'miner-software');
        }
      } else if (cpuModel.includes('exynos-m4')) {
        if (cpuModel.includes('A75') && cpuModel.includes('A55')) {
          ccBranch = 'em4-a75-a55';
          this.loggingService.log('Detected Exynos M4 with Cortex-A75 and A55', 'INFO', 'miner-software');
        } else {
          ccBranch = 'em4';
          this.loggingService.log('Detected Exynos M4', 'INFO', 'miner-software');
        }
      } else if (cpuModel.includes('exynos-m5')) {
        if (cpuModel.includes('A76') && cpuModel.includes('A55')) {
          ccBranch = 'em5-a76-a55';
          this.loggingService.log('Detected Exynos M5 with Cortex-A76 and A55', 'INFO', 'miner-software');
        } else {
          ccBranch = 'em5';
          this.loggingService.log('Detected Exynos M5', 'INFO', 'miner-software');
        }
      }
      // Prioritize combined CPU configurations first, then fallback to single core types
      else if (cpuModel.includes('A76') && cpuModel.includes('A55')) {
        ccBranch = 'a76-a55';
      } else if (cpuModel.includes('A75') && cpuModel.includes('A55')) {
        ccBranch = 'a75-a55';
      } else if (cpuModel.includes('A72') && cpuModel.includes('A53')) {
        ccBranch = 'a72-a53';
      } else if (cpuModel.includes('A73') && cpuModel.includes('A53')) {
        ccBranch = 'a73-a53';
      } else if (cpuModel.includes('A57') && cpuModel.includes('A53')) {
        ccBranch = 'a57-a53';
      } else if (cpuModel.includes('X1') && cpuModel.includes('A78') && cpuModel.includes('A55')) {
        ccBranch = 'x1-a78-a55';
      }
      // Single-core architectures if no combinations match
      else if (cpuModel.includes('A35')) {
        ccBranch = 'a35';
      } else if (cpuModel.includes('A53')) {
        ccBranch = 'a53';
      } else if (cpuModel.includes('A55')) {
        ccBranch = 'a55';
      } else if (cpuModel.includes('A57')) {
        ccBranch = 'a57';
      } else if (cpuModel.includes('A65')) {
        ccBranch = 'a65';
      } else if (cpuModel.includes('A72')) {
        ccBranch = 'a72';
      } else if (cpuModel.includes('A73')) {
        ccBranch = 'a73';
      } else if (cpuModel.includes('A75')) {
        ccBranch = 'a75';
      } else if (cpuModel.includes('A76')) {
        ccBranch = 'a76';
      } else if (cpuModel.includes('A77')) {
        ccBranch = 'a77';
      } else if (cpuModel.includes('A78')) {
        ccBranch = 'a78';
      } else if (cpuModel.includes('A78C')) {
        ccBranch = 'a78c';
      }
      // Check architecture as a fallback if model name doesn't have ARM core info
      else if (cpuArch === 'aarch64' || cpuArch === 'arm64') {
        // Determine a reasonable fallback for ARM64 architectures
        if (cpuInfo.includes('bcm') || this.isRaspberryPi()) {
          ccBranch = 'a72-a53'; // Common for Raspberry Pi 4 and similar
        } else {
          ccBranch = 'a55'; // Most common newer ARM core
        }
      } else if (cpuArch.startsWith('arm')) {
        // For older 32-bit ARM
        ccBranch = 'a53';
      } else {
        ccBranch = 'generic';
      }

      this.loggingService.log(
        `Selected ccminer branch: ${ccBranch}`,
        'INFO',
        'miner-software'
      );

      return ccBranch;

    } catch (error) {
      this.loggingService.log(
        `Error selecting ccminer branch: ${error.message}`,
        'ERROR',
        'miner-software'
      );
      return 'generic';
    }
  }

  /**
   * Check if running on Raspberry Pi
   */
  private isRaspberryPi(): boolean {
    try {
      const deviceTreePath = '/proc/device-tree/model';
      if (fs.existsSync(deviceTreePath)) {
        const model = fs.readFileSync(deviceTreePath, 'utf8');
        return model.toLowerCase().includes('raspberry');
      }
    } catch {
      // Ignore errors
    }
    return false;
  }

  /**
   * Verify ccminer branch availability and download
   */
  async downloadOptimalCcminer(compatibility: SystemCompatibility): Promise<boolean> {
    const ccBranch = await this.selectCcminerBranch(compatibility);
    const ccminerDir = path.join(this.appsDir, 'ccminer');
    const ccminerPath = path.join(ccminerDir, 'ccminer');
    const configPath = path.join(ccminerDir, 'config.json');

    try {
      // Ensure directory exists
      if (!fs.existsSync(ccminerDir)) {
        fs.mkdirSync(ccminerDir, { recursive: true });
      }

      // Check if selected branch is available
      const branchUrl = `https://raw.githubusercontent.com/Darktron/pre-compiled/${ccBranch}/ccminer`;
      
      try {
        // Test if branch URL is accessible
        const testCommand = process.platform === 'win32' 
          ? `powershell -Command "try { Invoke-WebRequest -Uri '${branchUrl}' -Method Head | Out-Null; exit 0 } catch { exit 1 }"`
          : `wget -q --spider "${branchUrl}"`;
        
        execSync(testCommand, { stdio: 'pipe' });
        
        this.loggingService.log(
          `Downloading ccminer from branch: ${ccBranch}`,
          'INFO',
          'miner-software'
        );

      } catch {
        this.loggingService.log(
          `Branch ${ccBranch} not available, falling back to generic`,
          'WARN',
          'miner-software'
        );
        // Fallback to generic version
        const genericUrl = `https://raw.githubusercontent.com/Darktron/pre-compiled/generic/ccminer`;
        
        const downloadCommand = process.platform === 'win32'
          ? `powershell -Command "Invoke-WebRequest -Uri '${genericUrl}' -OutFile '${ccminerPath}'"`
          : `wget -q -O "${ccminerPath}" "${genericUrl}"`;
        
        execSync(downloadCommand);
      }

      // Download the ccminer binary
      const downloadCommand = process.platform === 'win32'
        ? `powershell -Command "Invoke-WebRequest -Uri '${branchUrl}' -OutFile '${ccminerPath}'"`
        : `wget -q -O "${ccminerPath}" "${branchUrl}"`;
      
      execSync(downloadCommand);

      // Set executable permissions (Unix-like systems only)
      if (process.platform !== 'win32') {
        execSync(`chmod +x "${ccminerPath}"`);
      }

      // Download default config if it doesn't exist
      if (!fs.existsSync(configPath)) {
        const configUrl = 'https://raw.githubusercontent.com/dismaster/RG3DUI/main/config.json';
        const configDownloadCommand = process.platform === 'win32'
          ? `powershell -Command "Invoke-WebRequest -Uri '${configUrl}' -OutFile '${configPath}'"`
          : `wget -q -O "${configPath}" "${configUrl}"`;
        
        execSync(configDownloadCommand);
      }

      this.loggingService.log(
        `Successfully downloaded optimal ccminer for branch: ${ccBranch}`,
        'INFO',
        'miner-software'
      );

      return true;

    } catch (error) {
      this.loggingService.log(
        `Failed to download ccminer: ${error.message}`,
        'ERROR',
        'miner-software'
      );
      return false;
    }
  }  /**
   * Compile and install XMRig for Linux/Termux systems
   */
  async compileAndInstallXmrig(compatibility: SystemCompatibility): Promise<boolean> {
    if (compatibility.os !== 'linux' && !compatibility.isTermux) {
      this.loggingService.log(
        'XMRig compilation is currently only supported on Linux and Termux environments',
        'WARN',
        'miner-software'
      );
      return false;
    }

    const xmrigDir = path.join(this.appsDir, 'xmrig');
    const xmrigPath = path.join(xmrigDir, 'xmrig');
    const homeDir = process.env.HOME || '~';
    const buildDir = path.join(homeDir, 'xmrig');

    try {
      // Ensure xmrig directory exists
      if (!fs.existsSync(xmrigDir)) {
        fs.mkdirSync(xmrigDir, { recursive: true });
      }

      const environmentType = compatibility.isTermux ? 'Termux' : 'Linux';
      this.loggingService.log(
        `Starting XMRig compilation process for ${environmentType}...`,
        'INFO',
        'miner-software'
      );

      // Step 1: Install cmake and dependencies based on environment
      if (compatibility.isTermux) {
        // Termux environment
        this.loggingService.log('Installing cmake and dependencies for Termux...', 'INFO', 'miner-software');
        execSync('pkg install cmake -y', { stdio: 'pipe' });
        execSync('pkg install make -y', { stdio: 'pipe' });
        execSync('pkg install clang -y', { stdio: 'pipe' });
        execSync('pkg install git -y', { stdio: 'pipe' });
      } else {
        // Regular Linux environment - use apt-based installation
        this.loggingService.log('Installing cmake and dependencies for Linux...', 'INFO', 'miner-software');
        
        // Update package index
        execSync('sudo apt update', { stdio: 'pipe' });
        
        // Install build dependencies
        execSync('sudo apt install -y cmake build-essential git', { stdio: 'pipe' });
        execSync('sudo apt install -y libuv1-dev libssl-dev libhwloc-dev', { stdio: 'pipe' });
      }      // Step 2: Clone the repository
      const gitRepoUrl = 'https://github.com/dismaster/xmrig';
      this.loggingService.log(`Cloning XMRig repository from: ${gitRepoUrl}`, 'INFO', 'miner-software');
      
      // Remove existing directory if it exists
      if (fs.existsSync(buildDir)) {
        execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' });
      }
      
      execSync(
        `cd "${homeDir}" && git clone ${gitRepoUrl}`,
        { stdio: 'pipe' },
      );

      // Step 3: Create build directory
      this.loggingService.log('Creating build directory...', 'INFO', 'miner-software');
      const buildPath = path.join(buildDir, 'build');
      execSync(`mkdir -p "${buildPath}"`, { stdio: 'pipe' });

      // Step 4: Configure with cmake (different options for different environments)
      this.loggingService.log('Configuring XMRig with cmake...', 'INFO', 'miner-software');
      
      let cmakeOptions = '';
      if (compatibility.isTermux) {
        // Termux-specific cmake configuration - simplified to create standard xmrig binary
        cmakeOptions = '-DWITH_HWLOC=OFF';
      } else {
        // Linux-specific cmake configuration
        cmakeOptions = '';
      }
      
      execSync(`cd "${buildPath}" && cmake ${cmakeOptions} ..`, { stdio: 'pipe' });

      // Step 5: Compile with make
      this.loggingService.log('Compiling XMRig (this may take several minutes)...', 'INFO', 'miner-software');
      const nproc = execSync('nproc', { encoding: 'utf8' }).trim();
      execSync(`cd "${buildPath}" && make -j${nproc}`, { stdio: 'pipe', timeout: 900000 }); // 15 min timeout      // Step 6: Find and copy the compiled binary with fallback paths
      this.loggingService.log('Locating compiled XMRig binary...', 'INFO', 'miner-software');
      
      // Multiple possible locations for the compiled binary
      const possibleBinaryPaths = [
        path.join(buildDir, 'build', 'xmrig'), // Most common actual location (xmrig/build/xmrig)
        path.join(buildPath, 'xmrig'),        // Standard build location (build/xmrig)
        path.join(buildDir, 'xmrig'),         // Alternative build location (xmrig/xmrig)
        path.join(buildDir, 'bin', 'xmrig'),  // Some builds put binary in bin/ (xmrig/bin/xmrig)
        path.join(buildDir, 'build', 'bin', 'xmrig'), // Another common location (xmrig/build/bin/xmrig)
      ];
      
      let compiledXmrigPath: string | null = null;
      for (const possiblePath of possibleBinaryPaths) {
        if (fs.existsSync(possiblePath)) {
          compiledXmrigPath = possiblePath;
          this.loggingService.log(
            `Found compiled XMRig binary at: ${possiblePath}`,
            'INFO',
            'miner-software'
          );
          break;
        }
      }
        if (!compiledXmrigPath) {
        // Enhanced debugging: Log all checked paths and their status
        this.loggingService.log('Detailed binary search debugging:', 'WARN', 'miner-software');
        possibleBinaryPaths.forEach((path, index) => {
          const exists = fs.existsSync(path);
          let details = `Path ${index + 1}: ${path} - ${exists ? 'EXISTS' : 'NOT FOUND'}`;
          if (exists) {
            try {
              const stats = fs.statSync(path);
              details += ` (size: ${stats.size} bytes, executable: ${!!(stats.mode & 0o111)})`;
            } catch (e) {
              details += ` (stat error: ${e.message})`;
            }
          }
          this.loggingService.log(details, 'WARN', 'miner-software');
        });

        // Log directory contents for debugging
        try {
          const buildContents = execSync(`find "${buildDir}" -name "xmrig" -type f 2>/dev/null || true`, { encoding: 'utf8' }).trim();
          this.loggingService.log(
            `Find command results: ${buildContents || 'No xmrig binary found'}`,
            'WARN',
            'miner-software'
          );
          
          // If find found files, let's check why our paths didn't work
          if (buildContents) {
            const foundPaths = buildContents.split('\n').filter(p => p.trim());
            this.loggingService.log(`Found ${foundPaths.length} potential binaries:`, 'WARN', 'miner-software');
            foundPaths.forEach((foundPath, index) => {
              this.loggingService.log(`  Found ${index + 1}: ${foundPath}`, 'WARN', 'miner-software');
              // Check if this path was in our search list
              const wasChecked = possibleBinaryPaths.includes(foundPath);
              this.loggingService.log(`    Was this path checked? ${wasChecked}`, 'WARN', 'miner-software');
            });
          }
          
          // Also list the entire build directory structure for debugging
          const buildStructure = execSync(`find "${buildDir}" -type f | head -20`, { encoding: 'utf8' }).trim();
          this.loggingService.log(`Build directory structure (first 20 files): ${buildStructure}`, 'WARN', 'miner-software');
          
        } catch (error) {
          this.loggingService.log(`Could not search for binary: ${error.message}`, 'WARN', 'miner-software');
        }
        throw new Error(`Compiled XMRig binary not found in any expected location: ${possibleBinaryPaths.join(', ')}`);
      }

      this.loggingService.log('Copying compiled XMRig binary...', 'INFO', 'miner-software');
      execSync(`cp "${compiledXmrigPath}" "${xmrigPath}"`, { stdio: 'pipe' });
      
      // Set executable permissions
      execSync(`chmod +x "${xmrigPath}"`, { stdio: 'pipe' });

      // Step 7: Clean up build directory
      this.loggingService.log('Cleaning up build directory...', 'INFO', 'miner-software');
      execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' });

      // Step 8: Download default config if it doesn't exist
      const configPath = path.join(xmrigDir, 'config.json');
      if (!fs.existsSync(configPath)) {
        this.loggingService.log('Downloading default XMRig config...', 'INFO', 'miner-software');
        const configUrl = 'https://raw.githubusercontent.com/dismaster/RG3DUI/main/xmrig-config.json';
        
        const downloadCommand = compatibility.isTermux
          ? `wget -q -O "${configPath}" "${configUrl}"`
          : `curl -s -L -o "${configPath}" "${configUrl}"`;
        
        execSync(downloadCommand, { stdio: 'pipe' });
      }

      this.loggingService.log(
        `XMRig compilation and installation completed successfully for ${environmentType}`,
        'INFO',
        'miner-software'
      );

      return true;

    } catch (error) {
      this.loggingService.log(
        `XMRig compilation failed: ${error.message}`,
        'ERROR',
        'miner-software'
      );

      // Clean up on failure
      try {
        if (fs.existsSync(buildDir)) {
          execSync(`rm -rf "${buildDir}"`, { stdio: 'pipe' });
        }
      } catch {
        // Ignore cleanup errors
      }

      return false;
    }
  }
  /**
   * Check XMRig compilation prerequisites for both Termux and Linux
   */
  async checkXmrigPrerequisites(
    compatibility: SystemCompatibility,
  ): Promise<{
    canCompile: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!compatibility.isTermux && compatibility.os !== 'linux') {
      issues.push(
        'XMRig compilation is only supported in Termux and Linux environments',
      );
      recommendations.push(
        'Use Termux on Android or Linux for XMRig compilation support',
      );
    }

    if (!compatibility.hasRoot) {
      recommendations.push(
        'Root access recommended for optimal mining performance',
      );
    }

    // Check for required tools
    try {
      // Check for git
      execSync('command -v git', { stdio: 'pipe' });
    } catch {
      issues.push('Git is not installed');
      if (compatibility.isTermux) {
        recommendations.push('Install git with: pkg install git');
      } else {
        recommendations.push('Install git with: sudo apt install git');
      }
    }

    try {
      // Check for make
      execSync('command -v make', { stdio: 'pipe' });
    } catch {
      issues.push('Make is not installed');
      if (compatibility.isTermux) {
        recommendations.push('Install make with: pkg install make');
      } else {
        recommendations.push('Install make with: sudo apt install build-essential');
      }
    }

    try {
      // Check for gcc/clang
      execSync('command -v gcc || command -v clang', { stdio: 'pipe' });
    } catch {
      issues.push('No C++ compiler found');
      if (compatibility.isTermux) {
        recommendations.push('Install compiler with: pkg install clang');
      } else {
        recommendations.push('Install compiler with: sudo apt install build-essential');
      }
    }

    try {
      // Check for cmake
      execSync('command -v cmake', { stdio: 'pipe' });
    } catch {
      issues.push('Cmake is not installed');
      if (compatibility.isTermux) {
        recommendations.push('Install cmake with: pkg install cmake');
      } else {
        recommendations.push('Install cmake with: sudo apt install cmake');
      }
    }

    // Check available disk space (approximate requirement: 500MB)
    try {
      const dfOutput = execSync('df $HOME', { encoding: 'utf8' });
      const lines = dfOutput.split('\n');
      if (lines.length > 1) {
        const stats = lines[1].split(/\s+/);
        const availableKB = parseInt(stats[3]);
        const availableMB = availableKB / 1024;

        if (availableMB < 500) {
          issues.push(
            `Insufficient disk space: ${Math.round(availableMB)}MB available, 500MB required`,
          );
          recommendations.push('Free up disk space before compilation');
        }
      }
    } catch {
      recommendations.push(
        'Could not check disk space, ensure at least 500MB is available',
      );
    }

    return {
      canCompile: issues.length === 0,
      issues,
      recommendations,
    };
  }
}
