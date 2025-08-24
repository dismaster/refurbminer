import { execSync } from 'child_process';

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
  static getMinerApiEndpoint(minerType: 'ccminer' | 'xmrig'): MinerApiEndpoint {
    const cacheKey = minerType;
    
    // Return cached endpoint if available
    if (this.cachedEndpoints.has(cacheKey)) {
      return this.cachedEndpoints.get(cacheKey)!;
    }

    // Try to discover the correct endpoint
    const endpoint = this.discoverMinerEndpoint(minerType);
    
    // Cache the discovered endpoint
    this.cachedEndpoints.set(cacheKey, endpoint);
    
    return endpoint;
  }

  /**
   * Discover miner API endpoint by testing multiple possibilities
   */
  private static discoverMinerEndpoint(minerType: 'ccminer' | 'xmrig'): MinerApiEndpoint {
    const possibleHosts = [
      '127.0.0.1',    // Localhost first (most common - miner runs locally)
      'localhost',    // Alternative localhost format
      '0.0.0.0',      // Wildcard binding (some configurations use this)
    ];

    const possiblePorts = [4068, 8080, 3333]; // Common miner API ports

    for (const host of possibleHosts) {
      for (const port of possiblePorts) {
        if (this.testEndpoint(host, port, minerType)) {
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
  private static testEndpoint(host: string, port: number, minerType: 'ccminer' | 'xmrig'): boolean {
    try {
      if (minerType === 'xmrig') {
        // Test XMRig HTTP API - simplified test without auth
        const response = execSync(
          `curl -s --connect-timeout 2 --max-time 3 http://${host}:${port}/1/summary`,
          { encoding: 'utf8', timeout: 5000 }
        );
        return response.includes('connection') || response.includes('hashrate') || response.includes('version');
      } else {
        // Test CCMiner TCP API
        const response = execSync(
          `echo 'summary' | timeout 3 nc -w 2 ${host} ${port}`,
          { encoding: 'utf8', timeout: 5000 }
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
  static getXmrigApiUrl(endpoint?: string): string {
    if (endpoint) {
      return endpoint;
    }
    
    const config = this.getMinerApiEndpoint('xmrig');
    return `http://${config.host}:${config.port}`;
  }

  /**
   * Get TCP endpoint for CCMiner API
   */
  static getCcminerApiEndpoint(): string {
    const config = this.getMinerApiEndpoint('ccminer');
    return `${config.host} ${config.port}`;
  }

  /**
   * Test connectivity to discovered endpoints
   */
  static async testConnectivity(): Promise<{ccminer: boolean, xmrig: boolean}> {
    const ccminerEndpoint = this.getMinerApiEndpoint('ccminer');
    const xmrigEndpoint = this.getMinerApiEndpoint('xmrig');

    return {
      ccminer: this.testEndpoint(ccminerEndpoint.host, ccminerEndpoint.port, 'ccminer'),
      xmrig: this.testEndpoint(xmrigEndpoint.host, xmrigEndpoint.port, 'xmrig')
    };
  }
}
