export interface MinerInfo {
  name: string;
  version?: string;
  path: string;
  exists: boolean;
  executable: boolean;
  compatible: boolean;
}

export interface SystemCompatibility {
  os: string;
  architecture: string;
  cpuFlags: string[];
  hasAES: boolean;
  hasPMULL: boolean;
  is64Bit: boolean;
  isTermux: boolean;
  hasRoot: boolean;
}

export interface MinerValidationResult {
  valid: boolean;
  issues: string[];
  recommendations: string[];
}

export interface DownloadInfo {
  url: string;
  filename: string;
  needsExtraction: boolean;
  extractCommand?: string;
}
