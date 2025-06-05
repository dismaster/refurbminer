import { execSync } from 'child_process';
import * as https from 'https';
import { LRUCache } from '../../device-monitoring/os-detection/lru-cache';
import { NETWORK_CONSTANTS } from './network-info-constants';

// Define NetworkInfo interface outside of class
interface NetworkInfo {
  primaryIp: string;
  externalIp: string;
  gateway: string;
  interfaces: string[];
  ping?: {
    refurbminer: number;
  };
  traffic?: {
    rxBytes: number;
    txBytes: number;
    rxSpeed: number;
    txSpeed: number;
    timestamp: number;
  };
}

// Traffic data with timestamp interface
interface TrafficData {
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
  timestamp: number;
}

// Ping data with timestamp interface to support TTL
interface PingData {
  value: number;
  timestamp: number;
}

// External IP response cache
interface ExternalIpCache {
  ip: string;
  timestamp: number;
}

// HTTP request interface with promise and abort controllers
interface HttpRequest {
  promise: Promise<any>;
  controller: AbortController;
}

export class NetworkInfoUtil {
  // Use LRU Cache for ping values with TTL support
  private static pingCache = new LRUCache<string, PingData>(20); // Limit to 20 hosts
  private static readonly PING_CACHE_TTL = 60000; // 60 seconds
  
  // Use LRU Cache for traffic stats with proper typing
  private static trafficCache = new LRUCache<string, TrafficData>(10); // Limit to 10 interfaces
  private static readonly TRAFFIC_CACHE_TTL = 30000; // 30 seconds
  
  // Keep track of previous traffic data for speed calculations (per interface)
  private static interfaceDataMap = new Map<string, { 
    rxBytes: number, 
    txBytes: number, 
    timestamp: number 
  }>();
    // Cache for external IP to reduce API calls
  private static externalIpCache: ExternalIpCache | null = null;
  private static readonly EXTERNAL_IP_CACHE_TTL = 300000; // 5 minutes  // Maximum number of interfaces to track
  private static readonly MAX_INTERFACES = 10;
  
  // HTTP request timeout in milliseconds
  private static readonly HTTP_TIMEOUT = 5000;
  
  // Active HTTP requests to manage and abort if needed - using proper AbortController instead of timeouts
  private static activeRequests: { [key: string]: HttpRequest } = {};

  /** ✅ Get network details based on system type */
  static getNetworkInfo(systemType: string): NetworkInfo {
    // Get base network info
    const baseInfo = (() => {
      switch (systemType) {
        case 'termux':
          return this.getTermuxNetworkInfo();
        case 'raspberry-pi':
        case 'linux':
          return this.getLinuxNetworkInfo();
        default:
          return this.getDefaultNetworkInfo();
      }
    })() as NetworkInfo;
    
    // Add ping metrics
    baseInfo.ping = {
      refurbminer: this.getPingLatency('refurbminer.de')
    };
    
    // Add traffic metrics for the primary interface
    const primaryInterface = baseInfo.interfaces[0] !== 'Unknown' ? baseInfo.interfaces[0] : null;
    if (primaryInterface) {
      baseInfo.traffic = this.getNetworkTraffic(primaryInterface);
    } else {
      baseInfo.traffic = {
        rxBytes: 0,
        txBytes: 0,
        rxSpeed: 0,
        txSpeed: 0,
        timestamp: Date.now()
      };
    }
    
    return baseInfo;
  }

  /** ✅ Get network info on Linux / Raspberry Pi */
  private static getLinuxNetworkInfo() {
    try {
      // Get all IPv4 addresses excluding loopback
      const ipOutput = execSync(
        "ip -4 addr show | grep inet | grep -v '127.0.0.1' | awk '{print $2}'", 
        { encoding: 'utf8', timeout: NETWORK_CONSTANTS.HTTP_TIMEOUT }
      ).split('\n').filter(Boolean);

      const gateway = execSync(
        "ip route | awk '/default/ {print $3}'", 
        { encoding: 'utf8', timeout: 2000 }
      ).trim();

      const interfaces = execSync(
        "ls /sys/class/net", 
        { encoding: 'utf8', timeout: 2000 }
      ).trim().split('\n');

      // Get external IP (cached or fresh)
      const externalIp = this.getCachedExternalIp();

      return {
        primaryIp: ipOutput.length > 0 ? ipOutput[0].split('/')[0] : 'Unknown',
        externalIp: externalIp || 'Unknown',
        gateway: gateway || 'Unknown',
        interfaces: interfaces.length > 0 ? interfaces.slice(0, this.MAX_INTERFACES) : ['Unknown']
      };
    } catch {
      return this.getDefaultNetworkInfo();
    }
  }

  /** ✅ Get network info on Termux (Android) */
  private static getTermuxNetworkInfo() {
    try {
      let primaryIp = 'Unknown';
      let gateway = 'Unknown';
      let externalIp = 'Unknown';
      let interfaces: string[] = [];

      // Try to get interface and IP from ifconfig with suppressed stderr
      try {
        const ifconfigOutput = execSync('ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        const sections = ifconfigOutput.split(/\n\n+/);
        
        for (const section of sections) {
          if (section.includes('lo:')) continue; // Skip loopback

          // Extract interface name
          const interfaceMatch = section.match(/^([a-zA-Z0-9]+):/);
          const ifaceName = interfaceMatch ? interfaceMatch[1] : null;
          
          if (ifaceName) {
            interfaces.push(ifaceName);
            
            // Extract IP address
            const ipMatch = section.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch && ipMatch[1] && primaryIp === 'Unknown') {
              primaryIp = ipMatch[1];
            }
          }
        }
      } catch (ifconfigError) {
        console.debug('ifconfig failed:', ifconfigError.message);
      }

      // If ifconfig didn't give us an IP, try termux-wifi-connectioninfo
      if (primaryIp === 'Unknown') {
        try {
          const wifiInfo = JSON.parse(
            execSync('termux-wifi-connectioninfo', { encoding: 'utf8', timeout: 3000 })
          );
          
          if (wifiInfo && wifiInfo.ip) {
            primaryIp = wifiInfo.ip;
            gateway = wifiInfo.gateway || 'Unknown';
            if (!interfaces.includes('wlan0')) interfaces.push('wlan0');
          }
        } catch (wifiError) {
          console.debug('Termux API not available:', wifiError.message);
        }
      }

      // Try to get gateway using traceroute
      if (gateway === 'Unknown') {
        gateway = this.getGatewayFromTraceroute();
      }

      // Get external IP (cached or fresh)
      externalIp = this.getCachedExternalIp();

      // If we still don't have interfaces, add a default
      if (interfaces.length === 0) {
        interfaces.push('Unknown');
      }

      // Limit number of interfaces to prevent memory growth
      if (interfaces.length > this.MAX_INTERFACES) {
        interfaces = interfaces.slice(0, this.MAX_INTERFACES);
      }

      return {
        primaryIp,
        externalIp: externalIp || 'Unknown',
        gateway: gateway || 'Unknown',
        interfaces
      };

    } catch (error) {
      console.error('Failed to get Termux network info:', error.message);
      return this.getDefaultNetworkInfo();
    }
  }

  /** ✅ Default fallback network info */
  private static getDefaultNetworkInfo() {
    return {
      primaryIp: 'Unknown',
      externalIp: 'Unknown',
      gateway: 'Unknown',
      interfaces: ['Unknown']
    };
  }

  /** ✅ Get gateway using traceroute */
  private static getGatewayFromTraceroute(): string {
    try {
      // Run traceroute and get first hop directly
      const tracerouteOutput = execSync(
        'traceroute -n -w 1 -q 1 -m 1 8.8.8.8 | grep -v traceroute | head -n 1',
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      // Extract first hop IP address more reliably
      const match = tracerouteOutput.match(/^\s*1\s+([0-9.]+)/);
      if (match && match[1]) {
        // Validate IP address format
        const ip = match[1];
        if (ip.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
          return ip;
        }
      }

      // If first attempt fails, try alternative method
      const pingOutput = execSync(
        'ping -c 1 8.8.8.8 | grep "^From .* Time to live exceeded"',
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      
      const pingMatch = pingOutput.match(/From ([0-9.]+)/);
      if (pingMatch && pingMatch[1]) {
        return pingMatch[1];
      }
    } catch (error) {
      console.debug('Gateway detection failed:', error.message);
      
      // Last resort: try to derive gateway from IP
      try {
        const ip = execSync('getprop dhcp.wlan0.ipaddress', { encoding: 'utf8', timeout: 1000 }).trim();
        if (ip) {
          const parts = ip.split('.');
          if (parts.length === 4) {
            parts[3] = '1';
            return parts.join('.');
          }
        }
      } catch {
        // Ignore errors in last resort attempt
      }
    }
    return 'Unknown';
  }

  /** ✅ Get ping latency to a target host with proper TTL caching */
  private static getPingLatency(host: string): number {
    const now = Date.now();
    
    // Check if we can use cached value
    const cachedData = this.pingCache.get(host);
    if (cachedData && (now - cachedData.timestamp < this.PING_CACHE_TTL)) {
      return cachedData.value;
    }
    
    try {
      // First try the standard ping command
      try {
        const pingOutput = execSync(
          `ping -c 3 -W 2 ${host} 2>/dev/null | grep "avg"`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        
        // Extract the avg ping time
        const match = pingOutput.match(/[0-9.]+\/([0-9.]+)\//);
        
        if (match && match[1]) {
          const pingValue = parseFloat(match[1]);
          
          // Update cache with timestamp
          this.pingCache.set(host, { value: pingValue, timestamp: now });
          
          return pingValue;
        }
      } catch (standardPingError) {
        // Standard ping failed, continue to fallback
      }
      
      // Fallback: Try to resolve hostname to IP first, then ping the IP
      try {
        // Try to resolve hostname first
        const nslookupCommand = `nslookup ${host} | grep -i address | tail -n 1 | awk '{print $2}'`;
        const ip = execSync(nslookupCommand, { encoding: 'utf8', timeout: 3000 }).trim();
        
        if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
          const altPingOutput = execSync(
            `ping -c 3 -W 2 ${ip} 2>/dev/null | grep "avg"`,
            { encoding: 'utf8', timeout: 5000 }
          ).trim();
          
          // Extract ping time from alternative output
          const altMatch = altPingOutput.match(/[0-9.]+\/([0-9.]+)\//);
          if (altMatch && altMatch[1]) {
            const altPingValue = parseFloat(altMatch[1]);
            
            // Update cache with timestamp
            this.pingCache.set(host, { value: altPingValue, timestamp: now });
            return altPingValue;
          }
        }
      } catch (fallbackError) {
        // Fallback also failed, return -1
      }
      
      // Cache the failure to prevent repeated attempts
      this.pingCache.set(host, { value: -1, timestamp: now });
      return -1; // Indicates failure to measure
    } catch (error) {
      // Cache the failure to prevent repeated attempts
      this.pingCache.set(host, { value: -1, timestamp: now });
      return -1; // Indicates failure to measure
    }
  }

  /** ✅ Get network traffic stats for an interface with improved caching */
  private static getNetworkTraffic(interfaceName: string): TrafficData {
    const now = Date.now();
    
    // Return cached value if recent enough (within TRAFFIC_CACHE_TTL)
    const cachedStats = this.trafficCache.get(interfaceName);
    if (cachedStats && (now - cachedStats.timestamp < this.TRAFFIC_CACHE_TTL)) {
      return cachedStats;
    }
    
    // Default result with all zeros
    const result: TrafficData = {
      rxBytes: 0,
      txBytes: 0,
      rxSpeed: 0,
      txSpeed: 0,
      timestamp: now
    };
    
    try {
      let rxBytes = 0;
      let txBytes = 0;
      let success = false;
      
      // Try multiple methods to get network stats
      if (interfaceName !== 'Unknown') {
        // Check if we can use su (root)
        const hasSu = this.isSuAvailable();
        
        // Method 1: Try reading from /proc/net/dev with su if available
        try {
          // Use su -c if available, otherwise try direct access
          const command = hasSu ? 
            'su -c "cat /proc/net/dev" 2>/dev/null' : 
            'cat /proc/net/dev 2>/dev/null';
            
          const netDevContent = execSync(command, { encoding: 'utf8', timeout: 2000 });
          const lines = netDevContent.split('\n');
          
          for (const line of lines) {
            if (line.includes(interfaceName)) {
              // Format: Interface: rx_bytes rx_packets ... tx_bytes tx_packets ...
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 10) {
                rxBytes = parseInt(parts[1], 10);
                txBytes = parseInt(parts[9], 10);
                success = true;
                break;
              }
            }
          }
        } catch {
          // Silently fail and try next method
        }
        
        // Method 2: Try ifconfig for systems that support it (with su if available)
        if (!success) {
          try {
            const command = hasSu ? 
              `su -c "ifconfig ${interfaceName}" 2>/dev/null` : 
              `ifconfig ${interfaceName} 2>/dev/null`;
              
            const ifconfigOutput = execSync(command, { encoding: 'utf8', timeout: 3000 });
            
            // Different formats for different ifconfig implementations
            let rxMatch = ifconfigOutput.match(/RX packets \d+\s+bytes (\d+)/);
            let txMatch = ifconfigOutput.match(/TX packets \d+\s+bytes (\d+)/);
            
            // Alternative format used on some systems
            if (!rxMatch) rxMatch = ifconfigOutput.match(/RX bytes:(\d+)/);
            if (!txMatch) txMatch = ifconfigOutput.match(/TX bytes:(\d+)/);
            
            if (rxMatch && rxMatch[1]) rxBytes = parseInt(rxMatch[1], 10);
            if (txMatch && txMatch[1]) txBytes = parseInt(txMatch[1], 10);
            
            if (rxBytes > 0 || txBytes > 0) success = true;
          } catch {
            // Silently fail
          }
        }
        
        // Method 3: For Android/Termux with root, try dumpsys
        if (!success && hasSu && interfaceName === 'wlan0') {
          try {
            const rxBytesStr = execSync(
              'su -c "dumpsys netstats | grep -E \\"iface=wlan.*NetworkStatsHistory\\" | head -1"', 
              { encoding: 'utf8', timeout: 3000 }
            ).trim();
            
            const rxBytesMatch = rxBytesStr.match(/rxBytes=(\d+)/);
            const txBytesMatch = rxBytesStr.match(/txBytes=(\d+)/);
            
            if (rxBytesMatch && rxBytesMatch[1]) rxBytes = parseInt(rxBytesMatch[1], 10);
            if (txBytesMatch && txBytesMatch[1]) txBytes = parseInt(txBytesMatch[1], 10);
            
            if (rxBytes > 0 || txBytes > 0) success = true;
          } catch {
            // Silently fail
          }
        }
      }
      
      // Calculate speeds if we have previous values for this interface
      let rxSpeed = 0;
      let txSpeed = 0;
      
      const prevData = this.interfaceDataMap.get(interfaceName);
      if (prevData && prevData.timestamp > 0 && (now - prevData.timestamp) > 0) {
        const timeDiffSecs = (now - prevData.timestamp) / 1000;
        rxSpeed = Math.max(0, rxBytes - prevData.rxBytes) / timeDiffSecs;
        txSpeed = Math.max(0, txBytes - prevData.txBytes) / timeDiffSecs;
      }
      
      // Update previous values for next calculation
      this.interfaceDataMap.set(interfaceName, {
        rxBytes,
        txBytes,
        timestamp: now
      });
      
      // Limit the size of interfaceDataMap to prevent memory growth
      if (this.interfaceDataMap.size > this.MAX_INTERFACES) {
        // Find oldest entry
        let oldestKey = interfaceName;
        let oldestTimestamp = now;
        
        this.interfaceDataMap.forEach((data, key) => {
          if (data.timestamp < oldestTimestamp) {
            oldestTimestamp = data.timestamp;
            oldestKey = key;
          }
        });
        
        // Delete oldest entry
        if (oldestKey !== interfaceName) {
          this.interfaceDataMap.delete(oldestKey);
        }
      }
      
      // Update result
      result.rxBytes = rxBytes;
      result.txBytes = txBytes;
      result.rxSpeed = Math.round(rxSpeed);
      result.txSpeed = Math.round(txSpeed);
      
      // Cache the result
      this.trafficCache.set(interfaceName, result);
      
      return result;
    } catch {
      // Return default values on any error
      return result;
    }
  }

  /** ✅ Check if we can use su (root) */
  private static isSuAvailable(): boolean {
    try {
      const result = execSync('su -c "echo test" 2>/dev/null', { encoding: 'utf8', timeout: 1000 });
      return result.includes('test');
    } catch {
      return false;
    }  }

  /**
   * Get external IP with caching to prevent frequent API calls
   * Uses a 5-minute cache to reduce external requests
   * Implements error handling and retry mechanism
   */
  private static getCachedExternalIp(): string {
    const now = Date.now();
    
    // Check if cache is valid
    if (this.externalIpCache && 
        this.externalIpCache.ip !== 'Unknown' && 
        (now - this.externalIpCache.timestamp) < this.EXTERNAL_IP_CACHE_TTL) {
      return this.externalIpCache.ip;
    }
    
    // Get fresh external IP
    try {
      const urls = [
        'https://api.ipify.org',
        'https://ifconfig.me',
        'https://icanhazip.com'
      ];
      
      // Try each URL with retries
      for (const url of urls) {
        try {          // Use timeout to prevent hanging
          let retries = 0;
          let lastError: Error | null = null;
          
          while (retries < NETWORK_CONSTANTS.MAX_RETRIES) {
            try {
              // Use timeout to prevent hanging
              const result = execSync(
                `curl -s --max-time 3 ${url}`,
                { encoding: 'utf8', timeout: 5000 }
              ).trim();
              
              if (result && result.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                // Update cache
                this.externalIpCache = { 
                  ip: result,
                  timestamp: now
                };
                return result;
              }
              
              // If result doesn't match IP format, try next attempt
              break;
            } catch (err) {
              lastError = err as Error;
              retries++;
              
              // Wait before retry (except on last attempt)
              if (retries < NETWORK_CONSTANTS.MAX_RETRIES) {
                // Sleep using a setTimeout-like approach that works synchronously
                const waitUntil = Date.now() + NETWORK_CONSTANTS.RETRY_DELAY;
                while (Date.now() < waitUntil) {
                  // Busy wait
                }
              }
            }
          }
            // Log the error if we failed after all retries
          if (lastError) {
            console.debug(`Failed to get IP from ${url} after ${NETWORK_CONSTANTS.MAX_RETRIES} attempts:`, 
              lastError instanceof Error ? lastError.message : 'Unknown error');
          }
        } catch (urlError) {
          const error = urlError as Error;
          console.debug(`Error with URL ${url}:`, error.message || 'Unknown error');
          continue;
        }
      }
    } catch (error) {
      const err = error as Error;
      console.debug('External IP detection failed:', err.message || 'Unknown error');
    }
    
    // Default to previous cached value or Unknown
    const fallbackIp = this.externalIpCache?.ip || 'Unknown';
    
    // Update cache timestamp to prevent immediate retry
    this.externalIpCache = { 
      ip: fallbackIp,
      timestamp: now
    };
    
    return fallbackIp;
  }

  /**
   * Makes an HTTP GET request with proper error handling, timeout, and cancellation
   * @param url The URL to fetch
   * @param timeoutMs Timeout in milliseconds
   * @param requestId Optional ID for tracking/cancelling requests
   * @returns Promise that resolves to the response text
   */
  private static safeHttpGet(url: string, timeoutMs: number = 5000, requestId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Set timeout to abort the request
      const timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      // Keep track of the request to allow cleanup
      const requestPromise = fetch(url, { 
        signal: controller.signal,
        method: 'GET',
      }).then(async response => {
        clearTimeout(timeoutHandle);
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }
        return response.text();
      }).catch(error => {
        clearTimeout(timeoutHandle);
        throw error;
      }).finally(() => {
        // Clean up the request entry
        if (this.activeRequests[reqId]) {
          delete this.activeRequests[reqId];
        }
      });
      
      // Store the request for potential cancellation
      this.activeRequests[reqId] = {
        promise: requestPromise,
        controller
      };
      
      // Return the result
      requestPromise.then(resolve).catch(reject);
    });
  }

  /**
   * Cleanup method to be called when app is shutting down
   * Clears all caches and cancels any pending requests
   */
  public static cleanup(): void {
    // Clear all caches
    this.pingCache = new LRUCache<string, PingData>(20);
    this.trafficCache = new LRUCache<string, TrafficData>(10);
    this.interfaceDataMap.clear();
    this.externalIpCache = null;
    
    // Cancel any pending timeouts
    Object.values(this.activeRequests).forEach(request => {
      request.controller.abort();
    });
    this.activeRequests = {};
  }
}