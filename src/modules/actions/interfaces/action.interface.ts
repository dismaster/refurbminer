/**
 * Interface representing an action from the API
 */
export interface MinerAction {
  _id: string;
  miner: string;
  command: MinerActionCommand;
  parameters?: Record<string, any>;
  status: MinerActionStatus;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Allowed commands for miner actions
 */
export enum MinerActionCommand {
  RESTART_MINER = 'restart_miner',
  RESTART_DEVICE = 'restart_device',
  UPDATE_SOFTWARE = 'update_software',
  RELOAD_CONFIG = 'reload_config',
  STOP_MINING = 'stop_mining',
  START_MINING = 'start_mining'
}

/**
 * Possible statuses for an action
 */
export enum MinerActionStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed'
}