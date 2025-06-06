import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { LoggingService } from '../logging/logging.service';
import { ConfigService } from '../config/config.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { OsDetectionService } from '../device-monitoring/os-detection/os-detection.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import {
  MinerAction,
  MinerActionCommand,
  MinerActionStatus,
} from './interfaces/action.interface';

const execAsync = promisify(exec);

@Injectable()
export class ActionsService implements OnModuleInit {
  private actionsInterval?: NodeJS.Timeout;
  private isProcessingActions = false;

  constructor(
    private readonly apiService: ApiCommunicationService,
    private readonly loggingService: LoggingService,
    private readonly configService: ConfigService,
    private readonly minerManagerService: MinerManagerService,
    private readonly osDetectionService: OsDetectionService,
  ) {}
  onModuleInit() {
    this.startActionsMonitoring();
    this.loggingService.log(
      '✅ Actions monitoring initialized',
      'INFO',
      'actions',
    );
  }

  /**
   * Start monitoring for pending actions from the API
   */
  startActionsMonitoring(): void {
    // Clear any existing interval
    if (this.actionsInterval) {
      clearInterval(this.actionsInterval);
    }
    
    // Check for actions every minute
    this.actionsInterval = setInterval(() => {
      void this.checkForPendingActions();
    }, 60000); // Every 60 seconds
    
    // Initial check
    setTimeout(() => {
      void this.checkForPendingActions();
    }, 5000); // Start checking after 5 seconds of application boot
  }

  /**
   * Check for any pending actions from the API
   */
  async checkForPendingActions(): Promise<void> {
    try {      // Skip if already processing actions
      if (this.isProcessingActions) {
        this.loggingService.log(
          '⏳ Already processing actions, skipping check',
          'DEBUG',
          'actions',
        );
        return;
      }
      
      // Get minerId from config
      const config = this.configService.getConfig();
      if (!config?.minerId) {
        this.loggingService.log('❌ Cannot check actions: No minerId found', 'ERROR', 'actions');
        return;
      }
        this.loggingService.log('🔍 Checking for pending actions...', 'DEBUG', 'actions');
      this.isProcessingActions = true;
        // Fetch pending actions from API - this will use the miners-actions/miner/:minerId/pending endpoint
      const response = await this.apiService.getPendingMinerActions(
        config.minerId,
      );
      const actions = (response as unknown) as MinerAction[];
      
      if (!actions || actions.length === 0) {
        this.loggingService.log('✅ No pending actions found', 'DEBUG', 'actions');
        this.isProcessingActions = false;
        return;
      }
      
      this.loggingService.log(`🔔 Found ${actions.length} pending action(s)`, 'INFO', 'actions');
      
      // Process each action in sequence
      for (const action of actions) {
        await this.processAction(action);
      }
        } catch (error) {
      this.loggingService.log(
        `❌ Error checking for actions: ${(error as Error).message}`,
        'ERROR',
        'actions',
      );
    } finally {
      this.isProcessingActions = false;
    }
  }

  /**
   * Process a single action
   */
  async processAction(action: MinerAction): Promise<void> {
    try {
      this.loggingService.log(`🎬 Processing action: ${action._id} - ${action.command}`, 'INFO', 'actions');
      
      // Mark action as in progress
      await this.apiService.updateMinerActionStatus(action._id, MinerActionStatus.IN_PROGRESS);
      
      // Execute the command
      switch (action.command) {
        case MinerActionCommand.RESTART_MINER:
          await this.restartMiner();
          break;
        case MinerActionCommand.RESTART_DEVICE:
          await this.restartDevice();
          break;
        case MinerActionCommand.UPDATE_SOFTWARE:
          await this.updateSoftware();
          break;
        case MinerActionCommand.RELOAD_CONFIG:
          await this.reloadConfig();
          break;
        case MinerActionCommand.STOP_MINING:
          await this.stopMining();
          break;
        case MinerActionCommand.START_MINING:
          await this.startMining();
          break;
        case MinerActionCommand.TORCH_ON:
          await this.toggleTorch(true);
          break;
        case MinerActionCommand.TORCH_OFF:
          await this.toggleTorch(false);
          break;
        default:
          throw new Error(`Unknown command: ${action.command}`);
      }
      
      // Mark action as completed
      await this.apiService.updateMinerActionStatus(action._id, MinerActionStatus.COMPLETED);
      this.loggingService.log(`✅ Action completed: ${action._id}`, 'INFO', 'actions');
      
    } catch (error) {
      this.loggingService.log(`❌ Action failed: ${action._id} - ${error.message}`, 'ERROR', 'actions');
      // Mark action as failed with error message
      await this.apiService.updateMinerActionStatus(action._id, MinerActionStatus.FAILED, error.message);
    }
  }

  /**
   * Implementation of different actions
   */
  async restartMiner(): Promise<void> {
    this.loggingService.log('🔄 Executing restart_miner action', 'INFO', 'actions');
    await this.minerManagerService.restartMiner();
  }

  async restartDevice(): Promise<void> {
    this.loggingService.log('🔄 Executing restart_device action', 'INFO', 'actions');
    
    try {
      // First import the OsDetectionService
      const osDetectionService = new (await import('../device-monitoring/os-detection/os-detection.service')).OsDetectionService(this.loggingService);
      const osType = osDetectionService.detectOS();
      
      this.loggingService.log(`🖥️ Restarting device on ${osType} platform`, 'INFO', 'actions');
      
      // Use different commands based on OS
      switch (osType) {
        case 'termux':
          // In Termux, we need to use special commands to reboot
          this.loggingService.log('Using Termux-specific reboot commands', 'DEBUG', 'actions');
          
          try {
            // Try multiple reboot methods in sequence until one works
            
            // First try with su if available (for rooted devices)
            try {
              this.loggingService.log('Attempting reboot with su (root)', 'DEBUG', 'actions');
              await execAsync('su -c reboot');
              return; // If successful, exit early
            } catch (suError) {
              this.loggingService.log('Su reboot failed, trying next method', 'DEBUG', 'actions');
            }
            
            // Next try with ADB if available
            try {
              this.loggingService.log('Attempting reboot with ADB', 'DEBUG', 'actions');
              await execAsync('adb shell reboot');
              return; // If successful, exit early
            } catch (adbError) {
              this.loggingService.log('ADB reboot failed, trying next method', 'DEBUG', 'actions');
            }
            
            // Fallback to Android broadcast method
            this.loggingService.log('Using Android broadcast reboot command', 'DEBUG', 'actions');
            await execAsync('am broadcast --user 0 -a android.intent.action.ACTION_SHUTDOWN || termux-toast "Reboot attempted"');
            
          } catch (fallbackError) {
            this.loggingService.log(`All reboot methods failed: ${fallbackError.message}`, 'WARN', 'actions');
            throw fallbackError;
          }
          break;
          
        case 'raspberry-pi':
        case 'linux':
        default:
          // Standard Linux reboot with a delay
          this.loggingService.log('Using standard Linux reboot command', 'DEBUG', 'actions');
          await execAsync('sleep 5 && reboot');
      }
      
      this.loggingService.log('📱 Reboot command executed, device should restart shortly', 'INFO', 'actions');
    } catch (error) {
      this.loggingService.log(`❌ Reboot failed: ${error.message}`, 'ERROR', 'actions');
      throw error; // Re-throw the error to mark the action as failed
    }
  }

    async updateSoftware(): Promise<void> {
    this.loggingService.log('⬆️ Executing update_software action', 'INFO', 'actions');
    
    try {
        // Get the home directory properly
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/data/data/com.termux/files/home';
        
        // Create an array of possible script paths to check
        const possibleScriptPaths = [
        `${homeDir}/update_refurbminer.sh`,          // In home directory
        `${homeDir}/refurbminer/update_refurbminer.sh`, // In refurbminer sub-directory
        `${process.cwd()}/update_refurbminer.sh`,    // In current working directory
        '/data/data/com.termux/files/home/update_refurbminer.sh'  // Hardcoded Termux path
        ];
        
        // Find the first script path that exists
        let updateScriptPath: string | null = null;
        for (const path of possibleScriptPaths) {
        try {
            await promisify(fs.access)(path, fs.constants.F_OK);
            updateScriptPath = path;
            this.loggingService.log(`✅ Found update script at: ${updateScriptPath}`, 'INFO', 'actions');
            break;
        } catch (err) {
            // Continue checking other paths
        }
        }
        
        // If no script found, try to create one
        if (!updateScriptPath) {
        this.loggingService.log('⚠️ No update script found, attempting to download...', 'WARN', 'actions');
        
        // Create default path
        updateScriptPath = `${homeDir}/update_refurbminer.sh`;
        
        // Try to download the script from the repository
        try {
            await execAsync(`wget -q -O ${updateScriptPath} https://raw.githubusercontent.com/dismaster/refurbminer/refs/heads/master/update_refurbminer.sh`);
            this.loggingService.log('✅ Downloaded update script successfully', 'INFO', 'actions');
        } catch (downloadError) {
            this.loggingService.log(`❌ Failed to download update script: ${downloadError.message}`, 'ERROR', 'actions');
            throw new Error('Could not find or download update script');
        }
        }
        
        // Make the script executable
        try {
        await execAsync(`chmod +x ${updateScriptPath}`);
        } catch (chmodError) {
        this.loggingService.log(`⚠️ Could not make update script executable: ${chmodError.message}`, 'WARN', 'actions');
        // Continue anyway, as the script might already be executable
        }
        
        // Execute the update script - use bash explicitly to ensure proper execution
        this.loggingService.log(`🚀 Running update script: ${updateScriptPath}`, 'INFO', 'actions');
          // Detect OS environment and use appropriate execution method
        const osType = await this.detectOSType();
        
        if (osType === 'termux') {
        // On Termux, use a different approach that's more reliable
        this.loggingService.log('📱 Detected Termux environment, using simplified execution method', 'INFO', 'actions');
        
        // Create a simpler wrapper script that just runs the update script
        const wrapperPath = `${homeDir}/update_wrapper.sh`;
        const wrapperContent = `#!/bin/bash
# Wait a bit for the current process to exit
sleep 5
# Execute the update script with full bash environment and save output
bash "${updateScriptPath}" > ${homeDir}/update_log.txt 2>&1
UPDATE_EXIT_CODE=$?

# Send notification when complete
if [ $UPDATE_EXIT_CODE -eq 0 ]; then
  # Try to restart the service
  if pgrep -f "node.*refurbminer" > /dev/null; then
    pkill -f "node.*refurbminer"
    sleep 2
    cd ${homeDir}/refurbminer && npm start &
  fi
  termux-notification --title "RefurbMiner Update" --content "Update completed successfully" || true
else
  termux-notification --title "RefurbMiner Update" --content "Update failed with exit code $UPDATE_EXIT_CODE" || true
fi`;
        
        // Write wrapper script
        fs.writeFileSync(wrapperPath, wrapperContent);
        await execAsync(`chmod +x ${wrapperPath}`);
        
        // Launch wrapper with nohup to keep it running after our process exits
        this.loggingService.log('📋 Creating update log at ~/update_log.txt', 'INFO', 'actions');
        
        // Create a visual indicator for the user that update is happening
        try {
          await execAsync('termux-toast "Update in progress, please wait..."');
        } catch {
          // Toast might not be available, continue anyway
        }
        
        // Execute the wrapper using nohup to ensure it continues after we exit
        await execAsync(`nohup ${wrapperPath} >/dev/null 2>&1 &`);
        
        this.loggingService.log('🚀 Update will continue in background with output logged to update_log.txt', 'INFO', 'actions');
        this.loggingService.log('⚠️ Service may restart shortly as part of the update process', 'WARN', 'actions');
        } else if (osType && osType !== 'unknown') {
        // For Linux distributions, use enhanced wrapper with systemd/service management
        this.loggingService.log(`🐧 Detected Linux environment (${osType}), using enhanced execution method`, 'INFO', 'actions');
        
        const wrapperPath = `${homeDir}/update_wrapper.sh`;
        const logPath = `${homeDir}/update_log.txt`;
        
        // Create enhanced wrapper script for Linux systems
        const wrapperContent = await this.createLinuxUpdateWrapper(updateScriptPath, homeDir, osType);
        
        // Write wrapper script
        fs.writeFileSync(wrapperPath, wrapperContent);
        await execAsync(`chmod +x ${wrapperPath}`);
        
        // Launch wrapper with nohup to keep it running after our process exits
        this.loggingService.log(`📋 Creating update log at ${logPath}`, 'INFO', 'actions');
        
        // Create a visual indicator for the user that update is happening
        try {
          await this.showLinuxUpdateNotification(osType, 'start');
        } catch {
          // Notification might not be available, continue anyway
        }
        
        // Execute the wrapper using nohup to ensure it continues after we exit
        await execAsync(`nohup ${wrapperPath} >/dev/null 2>&1 &`);
        
        this.loggingService.log('🚀 Update will continue in background with output logged to update_log.txt', 'INFO', 'actions');
        this.loggingService.log('⚠️ Service may restart shortly as part of the update process', 'WARN', 'actions');
        } else {
        // Standard execution for unknown/other environments
        this.loggingService.log('💻 Using standard execution method for current environment', 'INFO', 'actions');
        const { stdout, stderr } = await execAsync(`bash ${updateScriptPath}`);
        
        // Log the output
        if (stdout) this.loggingService.log(`📝 Update script output: ${stdout}`, 'INFO', 'actions');
        if (stderr) this.loggingService.log(`⚠️ Update script errors: ${stderr}`, 'WARN', 'actions');
        }
        
        this.loggingService.log('✅ Software update process initiated successfully', 'INFO', 'actions');
    } catch (error) {
        this.loggingService.log(`❌ Software update failed: ${error.message}`, 'ERROR', 'actions');
        throw error; // Re-throw to mark action as failed
    }
    }

    // Helper method to check if running in Termux
    private async checkIfTermux(): Promise<boolean> {
    try {
        // Check for Termux-specific paths
        if (fs.existsSync('/data/data/com.termux')) {
        return true;
        }
        
        // Or try running a Termux-specific command
        try {
        await execAsync('termux-info >/dev/null 2>&1');
        return true;
        } catch {
        // Command not found, not Termux
        }
        
        return false;
    } catch (error) {
        return false;
    }
    }

  async reloadConfig(): Promise<void> {
    this.loggingService.log('🔄 Executing reload_config action', 'INFO', 'actions');
    await this.configService.forceSyncWithApi();
  }

  async stopMining(): Promise<void> {
    this.loggingService.log('⏹️ Executing stop_mining action', 'INFO', 'actions');
    
    // Pass true to indicate this is a manual stop by user
    const result = this.minerManagerService.stopMiner(true);
    
    // Update telemetry to indicate mining was manually stopped
    try {
      const config = this.configService.getConfig();
      if (!config?.minerId) {
        throw new Error('No minerId found in config');
      }
      
      this.loggingService.log('✋ Mining manually stopped by user action', 'INFO', 'actions');
    } catch (error) {
      this.loggingService.log(`Failed to update miner status: ${error.message}`, 'WARN', 'actions');
    }
    
    return Promise.resolve(); // Return resolved promise to satisfy async
  }

  async startMining(): Promise<void> {
    this.loggingService.log('▶️ Executing start_mining action', 'INFO', 'actions');
    const result = this.minerManagerService.startMiner();
    return Promise.resolve(); // Return resolved promise to satisfy async
  }

  async toggleTorch(turnOn: boolean): Promise<void> {
    const action = turnOn ? 'on' : 'off';
    this.loggingService.log(`🔦 Executing torch_${action} action`, 'INFO', 'actions');
    
    try {
      // Check if we're on Termux
      const isTermux = await this.checkIfTermux();
      
      if (isTermux) {
        // Use termux-api command to control the torch
        await execAsync(`termux-torch ${action}`);
        this.loggingService.log(`✅ Torch turned ${action} successfully`, 'INFO', 'actions');
      } else {
        // Not on Termux, log a warning
        this.loggingService.log('⚠️ Torch control is only available on Termux', 'WARN', 'actions');
      }
    } catch (error: any) {
      this.loggingService.log(`❌ Failed to toggle torch: ${error.message}`, 'ERROR', 'actions');
      
      // Check if termux-api might be missing
      if (error.message.includes('not found') || error.message.includes('No such file')) {
        this.loggingService.log('⚠️ Termux-api package might not be installed', 'WARN', 'actions');
        
        try {
          // Try to install termux-api package
          this.loggingService.log('🔄 Attempting to install termux-api package...', 'INFO', 'actions');
          await execAsync('pkg install -y termux-api');
          
          // Try again after installation
          await execAsync(`termux-torch ${action}`);
          this.loggingService.log(`✅ Installed termux-api and turned torch ${action}`, 'INFO', 'actions');
        } catch (installError: any) {
          this.loggingService.log(`❌ Could not install termux-api: ${installError.message}`, 'ERROR', 'actions');
          throw new Error(`Torch control requires termux-api package: ${installError.message}`);
        }
      } else {
        throw error; // Re-throw the original error
      }
    }
  }

  /**
   * Clean up on application shutdown
   */
  onApplicationShutdown() {
    if (this.actionsInterval) {
      clearInterval(this.actionsInterval);
      this.actionsInterval = undefined;
    }
  }

  /**
   * Helper method to detect OS type using the OS detection service
   */
  private async detectOSType(): Promise<string> {
    try {
      return this.osDetectionService.detectOS();
    } catch (error) {
      this.loggingService.log(
        `Failed to detect OS type: ${(error as Error).message}`,
        'WARN',
        'actions',
      );
      return 'unknown';
    }
  }

  /**
   * Create enhanced Linux update wrapper script with distribution-specific package management
   */
  private async createLinuxUpdateWrapper(
    updateScriptPath: string,
    homeDir: string,
    osType: string,
  ): Promise<string> {
    const logPath = `${homeDir}/update_log.txt`;

    // Detect package manager and service management commands
    let packageUpdateCmd = '';
    let serviceRestartCmd = '';

    try {
      // Try to detect distribution-specific package managers
      const { stdout: lsbRelease } = await execAsync('lsb_release -si 2>/dev/null || echo "unknown"');
      const distro = lsbRelease.trim().toLowerCase();

      if (distro.includes('ubuntu') || distro.includes('debian')) {
        packageUpdateCmd = 'apt update && apt upgrade -y';
        serviceRestartCmd = 'systemctl restart refurbminer || service refurbminer restart';
      } else if (distro.includes('centos') || distro.includes('rhel') || distro.includes('fedora')) {
        packageUpdateCmd = 'yum update -y || dnf update -y';
        serviceRestartCmd = 'systemctl restart refurbminer || service refurbminer restart';
      } else if (distro.includes('arch')) {
        packageUpdateCmd = 'pacman -Syu --noconfirm';
        serviceRestartCmd = 'systemctl restart refurbminer';
      } else {
        // Generic Linux fallback
        packageUpdateCmd = 'echo "Generic Linux - package updates not automated"';
        serviceRestartCmd = 'systemctl restart refurbminer 2>/dev/null || service refurbminer restart 2>/dev/null || echo "Service restart not available"';
      }
    } catch (error) {
      this.loggingService.log(
        `Could not detect Linux distribution: ${(error as Error).message}`,
        'WARN',
        'actions',
      );
      packageUpdateCmd = 'echo "Could not detect package manager"';
      serviceRestartCmd = 'echo "Could not detect service manager"';
    }

    const wrapperContent = `#!/bin/bash
# RefurbMiner Linux Update Wrapper Script
# Generated for ${osType} environment

# Wait for the current process to exit
sleep 5

# Create log file with timestamp
echo "=== RefurbMiner Update Started at $(date) ===" > ${logPath}

# Function to log with timestamp
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a ${logPath}
}

log_message "Starting RefurbMiner update process..."

# Update system packages if running as root
if [ "$EUID" -eq 0 ]; then
    log_message "Running as root - updating system packages..."
    ${packageUpdateCmd} >> ${logPath} 2>&1
    PACKAGE_EXIT_CODE=$?
    if [ $PACKAGE_EXIT_CODE -eq 0 ]; then
        log_message "System packages updated successfully"
    else
        log_message "System package update failed with exit code $PACKAGE_EXIT_CODE"
    fi
else
    log_message "Not running as root - skipping system package updates"
fi

# Execute the main update script
log_message "Executing RefurbMiner update script: ${updateScriptPath}"
bash "${updateScriptPath}" >> ${logPath} 2>&1
UPDATE_EXIT_CODE=$?

# Check update result and handle service restart
if [ $UPDATE_EXIT_CODE -eq 0 ]; then
    log_message "RefurbMiner update completed successfully"
    
    # Try to restart the service
    log_message "Attempting to restart RefurbMiner service..."
    
    # Stop existing RefurbMiner processes
    if pgrep -f "node.*refurbminer" > /dev/null; then
        log_message "Stopping existing RefurbMiner processes..."
        pkill -f "node.*refurbminer"
        sleep 3
    fi
    
    # Try systemd/service restart
    ${serviceRestartCmd} >> ${logPath} 2>&1
    SERVICE_EXIT_CODE=$?
    
    if [ $SERVICE_EXIT_CODE -eq 0 ]; then
        log_message "RefurbMiner service restarted successfully"
    else
        log_message "Service restart failed, attempting manual start..."
        cd ${homeDir}/refurbminer && npm start >> ${logPath} 2>&1 &
        log_message "Manual start command executed"
    fi
    
    # Send success notification
    ${this.getLinuxNotificationCommand(osType, 'RefurbMiner Update Complete', 'Update completed successfully and service restarted')}
else
    log_message "RefurbMiner update failed with exit code $UPDATE_EXIT_CODE"
    # Send failure notification
    ${this.getLinuxNotificationCommand(osType, 'RefurbMiner Update Failed', "Update failed with exit code $UPDATE_EXIT_CODE")}
fi

log_message "=== RefurbMiner Update Process Completed ==="

# Keep the log file readable
chmod 644 ${logPath} 2>/dev/null || true
`;

    return wrapperContent;
  }

  /**
   * Get Linux notification command based on the distribution
   */
  private getLinuxNotificationCommand(osType: string, title: string, message: string): string {
    // Try different notification systems in order of preference
    return `(
      notify-send "${title}" "${message}" 2>/dev/null ||
      zenity --info --title="${title}" --text="${message}" 2>/dev/null ||
      echo "${title}: ${message}" ||
      true
    ) >> /dev/null 2>&1 &`;
  }

  /**
   * Show Linux update notification using available notification systems
   */
  private async showLinuxUpdateNotification(osType: string, phase: 'start' | 'complete' | 'error'): Promise<void> {
    let title = '';
    let message = '';

    switch (phase) {
      case 'start':
        title = 'RefurbMiner Update Started';
        message = 'Update process initiated. Please wait for completion.';
        break;
      case 'complete':
        title = 'RefurbMiner Update Complete';
        message = 'Update completed successfully. Service is restarting.';
        break;
      case 'error':
        title = 'RefurbMiner Update Failed';
        message = 'Update process encountered an error. Check logs for details.';
        break;
    }

    try {
      const notificationCmd = this.getLinuxNotificationCommand(osType, title, message);
      await execAsync(notificationCmd);
      this.loggingService.log(
        `Notification sent: ${title}`,
        'DEBUG',
        'actions',
      );
    } catch (error) {
      this.loggingService.log(
        `Failed to send notification: ${(error as Error).message}`,
        'DEBUG',
        'actions',
      );
      // Not a critical error, continue
    }
  }
}
