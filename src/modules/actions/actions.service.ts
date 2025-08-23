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
    try {
      // Skip if already processing actions
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
        this.loggingService.log(
          '❌ Cannot check actions: No minerId found',
          'ERROR',
          'actions',
        );
        return;
      }
      this.loggingService.log(
        '🔍 Checking for pending actions...',
        'DEBUG',
        'actions',
      );
      this.isProcessingActions = true;

      // Set a maximum timeout for the entire action check process
      const actionCheckTimeout = setTimeout(() => {
        this.loggingService.log(
          '⏰ Action check timed out after 30 seconds, resetting processing flag',
          'WARN',
          'actions',
        );
        this.isProcessingActions = false;
      }, 30000); // 30 second timeout

      try {
        // Fetch pending actions from API - this will use the miners-actions/miner/:minerId/pending endpoint
        const response = await this.apiService.getPendingMinerActions(
          config.minerId,
        );
        const actions = response as unknown as MinerAction[];

        clearTimeout(actionCheckTimeout); // Clear timeout if successful

        if (!actions || actions.length === 0) {
          this.loggingService.log(
            '✅ No pending actions found',
            'DEBUG',
            'actions',
          );
          this.isProcessingActions = false;
          return;
        }

        this.loggingService.log(
          `🔔 Found ${actions.length} pending action(s)`,
          'INFO',
          'actions',
        );

        // Process each action in sequence
        for (const action of actions) {
          await this.processAction(action);
        }
      } catch (apiError) {
        clearTimeout(actionCheckTimeout);
        throw apiError; // Re-throw to be handled by outer catch
      }
    } catch (error) {
      if (error.message?.includes('timeout')) {
        this.loggingService.log(
          `⏰ Action check timed out: ${(error as Error).message}`,
          'WARN',
          'actions',
        );
      } else {
        this.loggingService.log(
          `❌ Error checking for actions: ${(error as Error).message}`,
          'ERROR',
          'actions',
        );
      }
    } finally {
      this.isProcessingActions = false;
    }
  }

  /**
   * Process a single action
   */
  async processAction(action: MinerAction): Promise<void> {
    try {
      this.loggingService.log(
        `🎬 Processing action: ${action._id} - ${action.command}`,
        'INFO',
        'actions',
      );

      // Mark action as in progress
      await this.apiService.updateMinerActionStatus(
        action._id,
        MinerActionStatus.IN_PROGRESS,
      );

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
      await this.apiService.updateMinerActionStatus(
        action._id,
        MinerActionStatus.COMPLETED,
      );
      this.loggingService.log(
        `✅ Action completed: ${action._id}`,
        'INFO',
        'actions',
      );
    } catch (error) {
      this.loggingService.log(
        `❌ Action failed: ${action._id} - ${error.message}`,
        'ERROR',
        'actions',
      );
      // Mark action as failed with error message
      await this.apiService.updateMinerActionStatus(
        action._id,
        MinerActionStatus.FAILED,
        error.message,
      );
    }
  }

  /**
   * Implementation of different actions
   */
  async restartMiner(): Promise<void> {
    this.loggingService.log(
      '🔄 Executing restart_miner action',
      'INFO',
      'actions',
    );
    await this.minerManagerService.restartMiner();
  }

  async restartDevice(): Promise<void> {
    this.loggingService.log(
      '🔄 Executing restart_device action',
      'INFO',
      'actions',
    );

    try {
      // First import the OsDetectionService
      const osDetectionService = new (
        await import('../device-monitoring/os-detection/os-detection.service')
      ).OsDetectionService(this.loggingService);
      const osType = osDetectionService.detectOS();

      this.loggingService.log(
        `🖥️ Restarting device on ${osType} platform`,
        'INFO',
        'actions',
      );

      // Use different commands based on OS
      switch (osType) {
        case 'termux':
          // In Termux, we need to use special commands to reboot
          this.loggingService.log(
            'Using Termux-specific reboot commands',
            'DEBUG',
            'actions',
          );

          try {
            // Try multiple reboot methods in sequence until one works

            // First try with su if available (for rooted devices)
            try {
              this.loggingService.log(
                'Attempting reboot with su (root)',
                'DEBUG',
                'actions',
              );
              await execAsync('su -c reboot');
              return; // If successful, exit early
            } catch (suError) {
              this.loggingService.log(
                'Su reboot failed (device likely not rooted), trying ADB method',
                'DEBUG',
                'actions',
              );
            }

            // Next try with ADB if available
            try {
              // First check if ADB is available and connected
              this.loggingService.log(
                'Checking ADB availability and device connection',
                'DEBUG',
                'actions',
              );
              
              // Check if adb command exists
              await execAsync('command -v adb');
              
              // Check if device is connected to ADB
              const adbDevices = await execAsync('adb devices');
              const deviceLines = adbDevices.stdout.split('\n').filter(line => 
                line.trim() && !line.includes('List of devices') && line.includes('device')
              );
              
              if (deviceLines.length === 0) {
                throw new Error('No ADB devices connected');
              }
              
              this.loggingService.log(
                `Found ${deviceLines.length} ADB device(s) connected, attempting reboot`,
                'INFO',
                'actions',
              );
              
              // Try adb reboot (more direct than adb shell reboot)
              await execAsync('adb reboot');
              this.loggingService.log(
                '✅ ADB reboot command sent successfully',
                'INFO',
                'actions',
              );
              return; // If successful, exit early
            } catch (adbError) {
              this.loggingService.log(
                `ADB reboot failed: ${adbError.message}`,
                'DEBUG',
                'actions',
              );
              
              // Fallback: try adb shell reboot as secondary method
              try {
                this.loggingService.log(
                  'Trying ADB shell reboot as fallback',
                  'DEBUG',
                  'actions',
                );
                await execAsync('adb shell reboot');
                this.loggingService.log(
                  '✅ ADB shell reboot command sent successfully',
                  'INFO',
                  'actions',
                );
                return;
              } catch (adbShellError) {
                this.loggingService.log(
                  `ADB shell reboot also failed: ${adbShellError.message}`,
                  'DEBUG',
                  'actions',
                );
              }
            }

            // Fallback to Android broadcast method
            this.loggingService.log(
              'All root/ADB methods failed, using Android broadcast reboot command',
              'DEBUG',
              'actions',
            );
            await execAsync(
              'am broadcast --user 0 -a android.intent.action.ACTION_SHUTDOWN || termux-toast "Reboot attempted"',
            );
          } catch (fallbackError) {
            this.loggingService.log(
              `All reboot methods failed: ${fallbackError.message}`,
              'WARN',
              'actions',
            );
            throw fallbackError;
          }
          break;

        case 'raspberry-pi':
        case 'linux':
        default:
          // Standard Linux reboot with a delay
          this.loggingService.log(
            'Using standard Linux reboot command',
            'DEBUG',
            'actions',
          );
          await execAsync('sleep 5 && reboot');
      }

      this.loggingService.log(
        '📱 Reboot command executed, device should restart shortly',
        'INFO',
        'actions',
      );
    } catch (error) {
      this.loggingService.log(
        `❌ Reboot failed: ${error.message}`,
        'ERROR',
        'actions',
      );
      throw error; // Re-throw the error to mark the action as failed
    }
  }

  /**
   * Run system package updates as pre-steps before software update
   */
  private async runSystemPackageUpdates(): Promise<void> {
    try {
      const osType = await this.detectOSType();
      this.loggingService.log(
        `🔍 Detected OS type: ${osType}`,
        'INFO',
        'actions',
      );

      if (osType === 'termux') {
        // Termux environment - use pkg
        this.loggingService.log(
          '📱 Running Termux package updates (pkg update && pkg upgrade)...',
          'INFO',
          'actions',
        );
        
        await execAsync('pkg update -y && pkg upgrade -y', { timeout: 300000 }); // 5 minute timeout
        
        this.loggingService.log(
          '✅ Termux packages updated successfully',
          'INFO',
          'actions',
        );
      } else if (osType && osType !== 'unknown') {
        // Linux distributions - detect package manager
        this.loggingService.log(
          `🐧 Running Linux package updates for ${osType}...`,
          'INFO',
          'actions',
        );

        // Try different package managers based on availability
        let updateCommand = '';
        let upgradeCommand = '';

        try {
          // Check for apt (Debian/Ubuntu)
          await execAsync('which apt-get');
          updateCommand = 'sudo apt-get update -y';
          upgradeCommand = 'sudo apt-get upgrade -y';
          this.loggingService.log('📦 Using APT package manager', 'INFO', 'actions');
        } catch {
          try {
            // Check for yum (RHEL/CentOS)
            await execAsync('which yum');
            updateCommand = 'sudo yum check-update';
            upgradeCommand = 'sudo yum update -y';
            this.loggingService.log('📦 Using YUM package manager', 'INFO', 'actions');
          } catch {
            try {
              // Check for dnf (Fedora)
              await execAsync('which dnf');
              updateCommand = 'sudo dnf check-update';
              upgradeCommand = 'sudo dnf upgrade -y';
              this.loggingService.log('📦 Using DNF package manager', 'INFO', 'actions');
            } catch {
              try {
                // Check for pacman (Arch Linux)
                await execAsync('which pacman');
                updateCommand = 'sudo pacman -Sy';
                upgradeCommand = 'sudo pacman -Su --noconfirm';
                this.loggingService.log('📦 Using Pacman package manager', 'INFO', 'actions');
              } catch {
                try {
                  // Check for zypper (openSUSE)
                  await execAsync('which zypper');
                  updateCommand = 'sudo zypper refresh';
                  upgradeCommand = 'sudo zypper update -y';
                  this.loggingService.log('📦 Using Zypper package manager', 'INFO', 'actions');
                } catch {
                  this.loggingService.log(
                    '⚠️ No supported package manager found, skipping system updates',
                    'WARN',
                    'actions',
                  );
                  return;
                }
              }
            }
          }
        }

        if (updateCommand && upgradeCommand) {
          // Run update command
          this.loggingService.log(`🔄 Running: ${updateCommand}`, 'INFO', 'actions');
          try {
            await execAsync(updateCommand, { timeout: 300000 }); // 5 minute timeout
            this.loggingService.log('✅ Package index updated successfully', 'INFO', 'actions');
          } catch (updateError) {
            this.loggingService.log(
              `⚠️ Package update command failed (continuing anyway): ${updateError instanceof Error ? updateError.message : String(updateError)}`,
              'WARN',
              'actions',
            );
          }

          // Run upgrade command
          this.loggingService.log(`⬆️ Running: ${upgradeCommand}`, 'INFO', 'actions');
          try {
            await execAsync(upgradeCommand, { timeout: 600000 }); // 10 minute timeout
            this.loggingService.log('✅ System packages upgraded successfully', 'INFO', 'actions');
          } catch (upgradeError) {
            this.loggingService.log(
              `⚠️ Package upgrade command failed: ${upgradeError instanceof Error ? upgradeError.message : String(upgradeError)}`,
              'WARN',
              'actions',
            );
            // Don't throw here - continue with software update even if system update fails
          }
        }
      } else {
        this.loggingService.log(
          '⚠️ Unknown OS type, skipping system package updates',
          'WARN',
          'actions',
        );
      }
    } catch (error) {
      this.loggingService.log(
        `❌ System package update failed: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
        'actions',
      );
      // Don't throw - continue with software update even if system update fails
      this.loggingService.log(
        '🔄 Continuing with RefurbMiner update despite system update failure...',
        'INFO',
        'actions',
      );
    }
  }

  async updateSoftware(): Promise<void> {
    this.loggingService.log(
      '⬆️ Executing update_software action',
      'INFO',
      'actions',
    );

    try {
      // STEP 1: Run system package updates as pre-steps
      this.loggingService.log(
        '🔄 Running system package updates before software update...',
        'INFO',
        'actions',
      );
      await this.runSystemPackageUpdates();

      // STEP 2: Proceed with RefurbMiner software update
      this.loggingService.log(
        '📦 System packages updated, proceeding with RefurbMiner update...',
        'INFO',
        'actions',
      );

      // Get the home directory properly
      const homeDir =
        process.env.HOME ||
        process.env.USERPROFILE ||
        '/data/data/com.termux/files/home';

      // Always download the latest update script from GitHub
      const updateScriptPath = `${homeDir}/update_refurbminer.sh`;
      const scriptUrl = 'https://raw.githubusercontent.com/dismaster/refurbminer_tools/refs/heads/main/update_refurbminer.sh';
      
      this.loggingService.log(
        '⬇️ Downloading latest update script from GitHub...',
        'INFO',
        'actions',
      );

      // Remove existing script if it exists to ensure we get the latest version
      try {
        if (fs.existsSync(updateScriptPath)) {
          fs.unlinkSync(updateScriptPath);
          this.loggingService.log(
            '🗑️ Removed existing update script to ensure latest version',
            'DEBUG',
            'actions',
          );
        }
      } catch (removeError) {
        this.loggingService.log(
          `⚠️ Could not remove existing script: ${removeError.message}`,
          'WARN',
          'actions',
        );
      }

      // Download the latest script from the repository
      try {
        await execAsync(
          `wget -q -O ${updateScriptPath} "${scriptUrl}"`,
        );
        this.loggingService.log(
          '✅ Downloaded latest update script successfully',
          'INFO',
          'actions',
        );
      } catch (downloadError) {
        this.loggingService.log(
          `❌ Failed to download update script: ${downloadError.message}`,
          'ERROR',
          'actions',
        );
        
        // Try curl as fallback
        try {
          this.loggingService.log(
            '🔄 Trying curl as fallback download method...',
            'DEBUG',
            'actions',
          );
          await execAsync(
            `curl -s -o ${updateScriptPath} "${scriptUrl}"`,
          );
          this.loggingService.log(
            '✅ Downloaded update script using curl',
            'INFO',
            'actions',
          );
        } catch (curlError) {
          this.loggingService.log(
            `❌ Failed to download with curl: ${curlError.message}`,
            'ERROR',
            'actions',
          );
          throw new Error('Could not download update script with wget or curl');
        }
      }

      // Make the script executable
      try {
        await execAsync(`chmod +x ${updateScriptPath}`);
      } catch (chmodError) {
        this.loggingService.log(
          `⚠️ Could not make update script executable: ${chmodError.message}`,
          'WARN',
          'actions',
        );
        // Continue anyway, as the script might already be executable
      }

      // Execute the update script - use bash explicitly to ensure proper execution
      this.loggingService.log(
        `🚀 Running update script: ${updateScriptPath}`,
        'INFO',
        'actions',
      );
      // Detect OS environment and use appropriate execution method
      const osType = await this.detectOSType();

      if (osType === 'termux') {
        // On Termux, use a different approach that's more reliable
        this.loggingService.log(
          '📱 Detected Termux environment, using robust wrapper script execution',
          'INFO',
          'actions',
        );

        // Create a comprehensive wrapper script that handles the entire update process
        const wrapperPath = `${homeDir}/update_wrapper.sh`;
        const logPath = `${homeDir}/update_log.txt`;
        
const wrapperContent = `#!/data/data/com.termux/files/usr/bin/bash
# RefurbMiner Termux Update Wrapper Script
# Generated at $(date)

# Wait a bit for the current process to exit
sleep 5

# Create log file with timestamp
echo "=== RefurbMiner Update Started at $(date) ===" > ${logPath}

# Function to log with timestamp
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a ${logPath}
}

log_message "Starting RefurbMiner update process in Termux..."

# Set environment variables for better Termux compatibility
export npm_config_target_platform=android
export npm_config_target_arch=arm64
export npm_config_cache=/data/data/com.termux/files/home/.npm
export npm_config_prefer_offline=true

# Pre-install known problematic packages with Termux-specific handling
log_message "Preparing Termux environment for update..."

# Clear npm cache to avoid potential conflicts
log_message "Clearing npm cache..."
npm cache clean --force >> ${logPath} 2>&1 || true

# Execute the update script with full bash environment and save output
log_message "Executing update script: ${updateScriptPath}"
bash "${updateScriptPath}" >> ${logPath} 2>&1
UPDATE_EXIT_CODE=$?

log_message "Update script completed with exit code: $UPDATE_EXIT_CODE"

# The update script handles everything (stopping/starting services, dependencies, notifications)
# We just need to verify the result and send a final status notification
if [ $UPDATE_EXIT_CODE -eq 0 ]; then
    log_message "✅ Update completed successfully!"
    
    # Additional Termux-specific post-update steps
    log_message "Running post-update Termux optimizations..."
    
    # Navigate to the refurbminer directory for post-update steps
    cd /data/data/com.termux/files/home/refurbminer 2>/dev/null || cd ~/refurbminer 2>/dev/null || true
    
    if [ -d "node_modules/@swc/core" ] && [ ! -f "node_modules/@swc/core/.termux-fixed" ]; then
        log_message "Applying Termux compatibility fixes for @swc/core..."
        
        # Try to install the wasm fallback explicitly if native bindings failed
        npm install @swc/wasm --save-optional >> ${logPath} 2>&1 || true
        
        # Mark as fixed to avoid repeating this
        touch "node_modules/@swc/core/.termux-fixed" 2>/dev/null || true
        
        log_message "Applied @swc/core compatibility fixes"
    fi
    
    # Run a quick dependency audit and fix if possible
    log_message "Running npm audit fix (non-breaking changes only)..."
    npm audit fix --only=prod >> ${logPath} 2>&1 || true
    
    # Verify that RefurbMiner is running in screen session
    sleep 3
    if screen -list 2>/dev/null | grep -q "refurbminer"; then
        log_message "✅ RefurbMiner is running in screen session 'refurbminer'"
        termux-notification --title "RefurbMiner Update Complete" --content "Update successful - RefurbMiner is running" || true
    else
        log_message "⚠️ RefurbMiner screen session not found after update"
        termux-notification --title "RefurbMiner Update" --content "Update completed but screen session verification failed" || true
    fi
else
    log_message "❌ Update failed with exit code $UPDATE_EXIT_CODE"
    
    # Try to provide helpful error information
    if grep -q "@swc/core" ${logPath}; then
        log_message "Note: @swc/core warnings are normal on Termux and don't prevent operation"
    fi
    
    termux-notification --title "RefurbMiner Update Failed" --content "Update script failed with exit code $UPDATE_EXIT_CODE" || true
fi

log_message "=== RefurbMiner Update Process Completed ==="

# Make log readable
chmod 644 ${logPath} 2>/dev/null || true

# Clean up wrapper script
rm -f ${wrapperPath} 2>/dev/null || true
`;

        // Write wrapper script
        try {
          fs.writeFileSync(wrapperPath, wrapperContent);
          await execAsync(`chmod +x ${wrapperPath}`);
          
          this.loggingService.log(
            `📝 Created wrapper script at: ${wrapperPath}`,
            'DEBUG',
            'actions',
          );
        } catch (writeError) {
          this.loggingService.log(
            `❌ Failed to create wrapper script: ${writeError.message}`,
            'ERROR',
            'actions',
          );
          throw writeError;
        }

        // Create a visual indicator for the user that update is happening
        try {
          await execAsync('termux-toast "RefurbMiner update starting, please wait..." 2>/dev/null || true');
        } catch {
          // Toast might not be available, continue anyway
        }

        // Execute the wrapper using nohup to ensure it continues after we exit
        try {
          this.loggingService.log(
            `🚀 Launching update wrapper: ${wrapperPath}`,
            'INFO',
            'actions',
          );
          
          // Use a more robust execution method for Termux
          await execAsync(`nohup bash ${wrapperPath} </dev/null >/dev/null 2>&1 &`);
          
          this.loggingService.log(
            '✅ Update wrapper launched successfully',
            'INFO',
            'actions',
          );
        } catch (execError) {
          this.loggingService.log(
            `❌ Failed to launch wrapper: ${execError.message}`,
            'ERROR',
            'actions',
          );
          
          // Fallback: try direct execution
          try {
            this.loggingService.log(
              '🔄 Trying fallback execution method...',
              'INFO',
              'actions',
            );
            await execAsync(`bash ${wrapperPath} &`);
            this.loggingService.log(
              '✅ Wrapper launched with fallback method',
              'INFO',
              'actions',
            );
          } catch (fallbackError) {
            this.loggingService.log(
              `❌ Fallback execution also failed: ${fallbackError.message}`,
              'ERROR',
              'actions',
            );
            throw fallbackError;
          }
        }

        this.loggingService.log(
          '🚀 Update will continue in background with output logged to ~/update_log.txt',
          'INFO',
          'actions',
        );
        this.loggingService.log(
          '⚠️ Service may restart shortly as part of the update process',
          'WARN',
          'actions',
        );
      } else if (osType && osType !== 'unknown') {
        // For Linux distributions, use enhanced wrapper with systemd/service management
        this.loggingService.log(
          `🐧 Detected Linux environment (${osType}), using enhanced execution method`,
          'INFO',
          'actions',
        );

        const wrapperPath = `${homeDir}/update_wrapper.sh`;
        const logPath = `${homeDir}/update_log.txt`;

        // Create enhanced wrapper script for Linux systems
        const wrapperContent = await this.createLinuxUpdateWrapper(
          updateScriptPath,
          homeDir,
          osType,
        );

        // Write wrapper script
        fs.writeFileSync(wrapperPath, wrapperContent);
        await execAsync(`chmod +x ${wrapperPath}`);

        // Launch wrapper with nohup to keep it running after our process exits
        this.loggingService.log(
          `📋 Creating update log at ${logPath}`,
          'INFO',
          'actions',
        );

        // Create a visual indicator for the user that update is happening
        try {
          await this.showLinuxUpdateNotification(osType, 'start');
        } catch {
          // Notification might not be available, continue anyway
        }

        // Execute the wrapper using nohup to ensure it continues after we exit
        try {
          this.loggingService.log(
            `📋 Attempting to execute wrapper: ${wrapperPath}`,
            'DEBUG',
            'actions',
          );
          await execAsync(`nohup bash ${wrapperPath} >/dev/null 2>&1 &`);
          this.loggingService.log(
            '✅ Wrapper script launched successfully',
            'DEBUG',
            'actions',
          );
        } catch (nohupError) {
          this.loggingService.log(
            `⚠️ nohup failed, trying alternative method: ${nohupError.message}`,
            'WARN',
            'actions',
          );
          // Fallback: try direct execution with bash
          try {
            await execAsync(`bash ${wrapperPath} &`);
            this.loggingService.log(
              '✅ Wrapper script launched with fallback method',
              'DEBUG',
              'actions',
            );
          } catch (fallbackError) {
            this.loggingService.log(
              `❌ Both execution methods failed: ${fallbackError.message}`,
              'ERROR',
              'actions',
            );
            // Try synchronous execution as last resort
            await execAsync(`bash ${wrapperPath}`);
          }
        }

        this.loggingService.log(
          '🚀 Update will continue in background with output logged to update_log.txt',
          'INFO',
          'actions',
        );
        this.loggingService.log(
          '⚠️ Service may restart shortly as part of the update process',
          'WARN',
          'actions',
        );
      } else {
        // Standard execution for unknown/other environments
        this.loggingService.log(
          '💻 Using standard execution method for current environment',
          'INFO',
          'actions',
        );
        const { stdout, stderr } = await execAsync(`bash ${updateScriptPath}`);

        // Log the output
        if (stdout)
          this.loggingService.log(
            `📝 Update script output: ${stdout}`,
            'INFO',
            'actions',
          );
        if (stderr)
          this.loggingService.log(
            `⚠️ Update script errors: ${stderr}`,
            'WARN',
            'actions',
          );
      }

      this.loggingService.log(
        '✅ Software update process initiated successfully',
        'INFO',
        'actions',
      );
    } catch (error) {
      this.loggingService.log(
        `❌ Software update failed: ${error.message}`,
        'ERROR',
        'actions',
      );
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
    this.loggingService.log(
      '🔄 Executing reload_config action',
      'INFO',
      'actions',
    );
    await this.configService.forceSyncWithApi();
  }

  async stopMining(): Promise<void> {
    this.loggingService.log(
      '⏹️ Executing stop_mining action',
      'INFO',
      'actions',
    );

    // Pass true to indicate this is a manual stop by user
    const result = this.minerManagerService.stopMiner(true);

    // Update telemetry to indicate mining was manually stopped
    try {
      const config = this.configService.getConfig();
      if (!config?.minerId) {
        throw new Error('No minerId found in config');
      }

      this.loggingService.log(
        '✋ Mining manually stopped by user action',
        'INFO',
        'actions',
      );
    } catch (error) {
      this.loggingService.log(
        `Failed to update miner status: ${error.message}`,
        'WARN',
        'actions',
      );
    }

    return Promise.resolve(); // Return resolved promise to satisfy async
  }

  async startMining(): Promise<void> {
    this.loggingService.log(
      '▶️ Executing start_mining action',
      'INFO',
      'actions',
    );
    await this.minerManagerService.startMiner();
  }

  async toggleTorch(turnOn: boolean): Promise<void> {
    const action = turnOn ? 'on' : 'off';
    this.loggingService.log(
      `🔦 Executing torch_${action} action`,
      'INFO',
      'actions',
    );

    try {
      // Check if we're on Termux
      const isTermux = await this.checkIfTermux();

      if (isTermux) {
        // Use termux-api command to control the torch
        await execAsync(`termux-torch ${action}`);
        this.loggingService.log(
          `✅ Torch turned ${action} successfully`,
          'INFO',
          'actions',
        );
      } else {
        // Not on Termux, log a warning
        this.loggingService.log(
          '⚠️ Torch control is only available on Termux',
          'WARN',
          'actions',
        );
      }
    } catch (error: any) {
      this.loggingService.log(
        `❌ Failed to toggle torch: ${error.message}`,
        'ERROR',
        'actions',
      );

      // Check if termux-api might be missing
      if (
        error.message.includes('not found') ||
        error.message.includes('No such file')
      ) {
        this.loggingService.log(
          '⚠️ Termux-api package might not be installed',
          'WARN',
          'actions',
        );

        try {
          // Try to install termux-api package
          this.loggingService.log(
            '🔄 Attempting to install termux-api package...',
            'INFO',
            'actions',
          );
          await execAsync('pkg install -y termux-api');

          // Try again after installation
          await execAsync(`termux-torch ${action}`);
          this.loggingService.log(
            `✅ Installed termux-api and turned torch ${action}`,
            'INFO',
            'actions',
          );
        } catch (installError: any) {
          this.loggingService.log(
            `❌ Could not install termux-api: ${installError.message}`,
            'ERROR',
            'actions',
          );
          throw new Error(
            `Torch control requires termux-api package: ${installError.message}`,
          );
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
      const { stdout: lsbRelease } = await execAsync(
        'lsb_release -si 2>/dev/null || echo "unknown"',
      );
      const distro = lsbRelease.trim().toLowerCase();

      if (distro.includes('ubuntu') || distro.includes('debian')) {
        packageUpdateCmd = 'apt update && apt upgrade -y';
        serviceRestartCmd =
          'systemctl restart refurbminer || service refurbminer restart';
      } else if (
        distro.includes('centos') ||
        distro.includes('rhel') ||
        distro.includes('fedora')
      ) {
        packageUpdateCmd = 'yum update -y || dnf update -y';
        serviceRestartCmd =
          'systemctl restart refurbminer || service refurbminer restart';
      } else if (distro.includes('arch')) {
        packageUpdateCmd = 'pacman -Syu --noconfirm';
        serviceRestartCmd = 'systemctl restart refurbminer';
      } else {
        // Generic Linux fallback
        packageUpdateCmd =
          'echo "Generic Linux - package updates not automated"';
        serviceRestartCmd =
          'systemctl restart refurbminer 2>/dev/null || service refurbminer restart 2>/dev/null || echo "Service restart not available"';
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
    
    # Stop any existing refurbminer screen session
    if screen -list | grep -q "refurbminer" 2>/dev/null; then
        log_message "Stopping existing RefurbMiner screen session..."
        screen -S refurbminer -X quit 2>/dev/null || true
        sleep 1
    fi
    
    # Try systemd/service restart first
    ${serviceRestartCmd} >> ${logPath} 2>&1
    SERVICE_EXIT_CODE=$?
    
    if [ $SERVICE_EXIT_CODE -eq 0 ]; then
        log_message "RefurbMiner service restarted successfully"
    else
        log_message "Service restart failed, attempting manual start in screen session..."
        cd ${homeDir}/refurbminer && screen -dmS refurbminer npm start
        log_message "RefurbMiner started in screen session 'refurbminer'"
    fi
    
    # Send success notification
    ${this.getLinuxNotificationCommand(osType, 'RefurbMiner Update Complete', 'Update completed successfully and service restarted')}
else
    log_message "RefurbMiner update failed with exit code $UPDATE_EXIT_CODE"
    # Send failure notification
    ${this.getLinuxNotificationCommand(osType, 'RefurbMiner Update Failed', 'Update failed with exit code $UPDATE_EXIT_CODE')}
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
  private getLinuxNotificationCommand(
    osType: string,
    title: string,
    message: string,
  ): string {
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
  private async showLinuxUpdateNotification(
    osType: string,
    phase: 'start' | 'complete' | 'error',
  ): Promise<void> {
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
        message =
          'Update process encountered an error. Check logs for details.';
        break;
    }

    try {
      const notificationCmd = this.getLinuxNotificationCommand(
        osType,
        title,
        message,
      );
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
