import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ApiCommunicationService } from '../api-communication/api-communication.service';
import { LoggingService } from '../logging/logging.service';
import { ConfigService } from '../config/config.service';
import { MinerManagerService } from '../miner-manager/miner-manager.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { MinerAction, MinerActionCommand, MinerActionStatus } from './interfaces/action.interface';

const execAsync = promisify(exec);

@Injectable()
export class ActionsService implements OnModuleInit {
  private actionsInterval?: NodeJS.Timeout;
  private isProcessingActions = false;

  constructor(
    private readonly apiService: ApiCommunicationService,
    private readonly loggingService: LoggingService,
    private readonly configService: ConfigService,
    private readonly minerManagerService: MinerManagerService
  ) {}

  onModuleInit() {
    this.startActionsMonitoring();
    this.loggingService.log('✅ Actions monitoring initialized', 'INFO', 'actions');
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
        this.loggingService.log('⏳ Already processing actions, skipping check', 'DEBUG', 'actions');
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
      const response = await this.apiService.getPendingMinerActions(config.minerId);
      const actions = response as MinerAction[];
      
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
      this.loggingService.log(`❌ Error checking for actions: ${error.message}`, 'ERROR', 'actions');
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
        const updateScriptPath = `${homeDir}/update_refurbminer.sh`;
        
        // Check if the script exists
        try {
        await promisify(fs.access)(updateScriptPath, fs.constants.F_OK | fs.constants.X_OK);
        this.loggingService.log(`✅ Update script found at: ${updateScriptPath}`, 'INFO', 'actions');
        } catch (error) {
        this.loggingService.log(`❌ Update script not found or not executable at: ${updateScriptPath}`, 'ERROR', 'actions');
        throw new Error(`Update script not found or not executable: ${error.message}`);
        }
        
        // Make the script executable (just to be sure)
        try {
        await execAsync(`chmod +x ${updateScriptPath}`);
        } catch (chmodError) {
        this.loggingService.log(`⚠️ Could not make update script executable: ${chmodError.message}`, 'WARN', 'actions');
        // Continue anyway, as the script might already be executable
        }
        
        // Execute the update script
        this.loggingService.log(`🚀 Running update script: ${updateScriptPath}`, 'INFO', 'actions');
        const { stdout, stderr } = await execAsync(updateScriptPath);
        
        // Log the output
        if (stdout) this.loggingService.log(`📝 Update script output: ${stdout}`, 'INFO', 'actions');
        if (stderr) this.loggingService.log(`⚠️ Update script errors: ${stderr}`, 'WARN', 'actions');
        
        this.loggingService.log('✅ Software update completed successfully', 'INFO', 'actions');
    } catch (error) {
        this.loggingService.log(`❌ Software update failed: ${error.message}`, 'ERROR', 'actions');
        throw error; // Re-throw to mark action as failed
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

  /**
   * Clean up on application shutdown
   */
  onApplicationShutdown() {
    if (this.actionsInterval) {
      clearInterval(this.actionsInterval);
      this.actionsInterval = undefined;
    }
  }
}
