import { exec, ExecOptionsWithStringEncoding } from 'child_process';
import { promisify } from 'util';

type ExecOptionsString = Omit<ExecOptionsWithStringEncoding, 'encoding'> & {
  encoding?: BufferEncoding;
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

export interface MinerApiEndpoint {
  host: string;
  port: number;
  protocol: 'http' | 'tcp';
}

export class MinerApiConfigUtil {
  private static cachedEndpoints: Map<string, MinerApiEndpoint> = new Map();
  private static readonly DEFAULT_ENDPOINTS = {
    ccminer: { host: '127.0.0.1', port: 4068, protocol: 'tcp' as const },
    xmrig: { host: '127.0.0.1', port: 4068, protocol: 'http' as const }
  };

  /**
   * Clear cached endpoints to force rediscovery
   */
  static clearCache(): void {
    this.cachedEndpoints.clear();
  }

  /**
   * Get the correct API endpoint for a specific miner
   */
  static async getMinerApiEndpoint(minerType: 'ccminer' | 'xmrig'): Promise<MinerApiEndpoint> {
    const cacheKey = minerType;
    
    // Return cached endpoint if available
    if (this.cachedEndpoints.has(cacheKey)) {
      return this.cachedEndpoints.get(cacheKey)!;
    }

    // Try to discover the correct endpoint
    const endpoint = await this.discoverMinerEndpoint(minerType);
    
    // Cache the discovered endpoint
    this.cachedEndpoints.set(cacheKey, endpoint);
    
    return endpoint;
  }

  /**
   * Discover miner API endpoint by testing multiple possibilities
   */
  private static async discoverMinerEndpoint(minerType: 'ccminer' | 'xmrig'): Promise<MinerApiEndpoint> {
    const possibleHosts = [
      '127.0.0.1',    // Localhost first (most common - miner runs locally)
      'localhost',    // Alternative localhost format
      '0.0.0.0',      // Wildcard binding (some configurations use this)
    ];

    const possiblePorts = [4068, 8080, 3333]; // Common miner API ports

    for (const host of possibleHosts) {
      for (const port of possiblePorts) {
        if (await this.testEndpoint(host, port, minerType)) {
          return {
            host,
            port,
            protocol: minerType === 'xmrig' ? 'http' : 'tcp',
          };
        }
      }
    }

    // If discovery fails, return default
    return this.DEFAULT_ENDPOINTS[minerType];
  }

  /**
   * Test if an endpoint is responsive
   */
  private static async testEndpoint(host: string, port: number, minerType: 'ccminer' | 'xmrig'): Promise<boolean> {
    try {
      if (minerType === 'xmrig') {
        // Test XMRig HTTP API - simplified test without auth
        const response = await execCommand(
          `curl -s --connect-timeout 2 --max-time 3 http://${host}:${port}/1/summary`,
          { timeout: 5000 }
        );
        return response.includes('connection') || response.includes('hashrate') || response.includes('version');
      } else {
        // Test CCMiner TCP API
        const response = await execCommand(
          `echo 'summary' | timeout 3 nc -w 2 ${host} ${port}`,
          { timeout: 5000 }
        );
        return response.includes('VER=') || response.includes('ALGO=');
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Get HTTP URL for XMRig API
   */
  static async getXmrigApiUrl(endpoint?: string): Promise<string> {
    if (endpoint) {
      return endpoint;
    }
    
    const config = await this.getMinerApiEndpoint('xmrig');
    return `http://${config.host}:${config.port}`;
  }

  /**
   * Get TCP endpoint for CCMiner API
   */
  static async getCcminerApiEndpoint(): Promise<string> {
    const config = await this.getMinerApiEndpoint('ccminer');
    return `${config.host} ${config.port}`;
  }

  /**
   * Test connectivity to discovered endpoints
   */
  static async testConnectivity(): Promise<{ccminer: boolean, xmrig: boolean}> {
    const [ccminerEndpoint, xmrigEndpoint] = await Promise.all([
      this.getMinerApiEndpoint('ccminer'),
      this.getMinerApiEndpoint('xmrig')
    ]);

    return {
      ccminer: await this.testEndpoint(ccminerEndpoint.host, ccminerEndpoint.port, 'ccminer'),
      xmrig: await this.testEndpoint(xmrigEndpoint.host, xmrigEndpoint.port, 'xmrig')
    };
  }
}
