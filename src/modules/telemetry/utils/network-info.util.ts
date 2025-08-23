import { execSync } from 'child_process';
import * as https from 'https';
import { LRUCache } from '../../device-monitoring/os-detection/lru-cache';
import { NETWORK_CONSTANTS } from './network-info-constants';

// Define NetworkInfo interface outside of class
export interface NetworkInfo {
  primaryIp: string;
  externalIp: string;
  gateway: string;
  interfaces: string[];
  macAddress?: string; // Primary interface MAC address
  interfaceDetails?: InterfaceDetail[]; // Detailed info per interface
  dns?: string[]; // DNS servers
  timestamp?: number; // When this info was collected
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

// Interface details with MAC addresses
export interface InterfaceDetail {
  name: string;
  macAddress: string;
  ipAddress?: string;
  state: 'up' | 'down' | 'unknown';
  type: 'ethernet' | 'wifi' | 'loopback' | 'unknown';
}

// Export other interfaces that might be needed
export interface TrafficData {
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
  timestamp: number;
}

export interface PingData {
  value: number;
  timestamp: number;
}

// Define comprehensive telemetry interface
export interface TelemetryData {
  status: string;
  appVersion?: string;
  minerSoftware: {
    name: string;
    version: string;
    algorithm: string;
    hashrate: number;
    acceptedShares: number;
    rejectedShares: number;
    uptime: number;
    solvedBlocks: number;
    difficulty?: number;
    miningStatus?: string;
  };
  pool: {
    name: string;
    url?: string;
    user?: string;
    acceptedShares: number;
    rejectedShares: number;
    staleShares?: number;
    ping: number;
    uptime: number;
  };
  deviceInfo: any;
  network: NetworkInfo;
  battery: any;
  schedules?: any;
  historicalHashrate?: any[];
}

// Traffic data with timestamp interface
interface TrafficDataInternal {
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
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
  private static interfaceDataMap = new Map<
    string,
    {
      rxBytes: number;
      txBytes: number;
      timestamp: number;
    }
  >();
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

    // Add MAC address information
    const interfaceDetails = this.getInterfaceDetails(systemType);
    baseInfo.interfaceDetails = this.filterRelevantInterfaces(interfaceDetails);

    // Set primary MAC address (from primary interface) - only if not already set by system-specific function
    const primaryInterface =
      baseInfo.interfaces[0] !== 'Unknown' ? baseInfo.interfaces[0] : null;
    if (!baseInfo.macAddress || baseInfo.macAddress === 'Unknown') {
      if (primaryInterface && interfaceDetails.length > 0) {
        const primaryDetail = interfaceDetails.find(
          (detail) => detail.name === primaryInterface,
        );
        baseInfo.macAddress = primaryDetail?.macAddress || 'Unknown';
      } else {
        baseInfo.macAddress = 'Unknown';
      }
    }

    // Add traffic metrics for the primary interface
    if (primaryInterface) {
      baseInfo.traffic = this.getNetworkTraffic(primaryInterface);
    } else {
      baseInfo.traffic = {
        rxBytes: 0,
        txBytes: 0,
        rxSpeed: 0,
        txSpeed: 0,
        timestamp: Date.now(),
      };
    }
    
    return baseInfo;
  }

  /** ✅ Filter out irrelevant network interfaces to reduce payload size */
  private static filterRelevantInterfaces(interfaceDetails: InterfaceDetail[]): InterfaceDetail[] {
    return interfaceDetails.filter((detail) => {
      // Include ethernet interfaces
      if (detail.type === 'ethernet') return true;
      
      // Include wifi interfaces
      if (detail.type === 'wifi') return true;
      
      // Include interfaces that are currently up (even if type is unknown)
      if (detail.state === 'up') return true;
      
      // Include interfaces with valid MAC addresses that might be relevant
      if (detail.macAddress !== 'Unknown' && detail.macAddress !== '00:00:00:00:00:00') {
        // But exclude clearly irrelevant interface names
        const irrelevantPatterns = [
          /^rmnet\d+$/,        // Mobile network interfaces
          /^umts_dm\d+$/,      // UMTS data modem interfaces
          /^ip_vti\d+/,        // VTI tunnel interfaces
          /^ip6_vti\d+/,       // IPv6 VTI tunnel interfaces
          /^sit\d+/,           // IPv6-in-IPv4 tunnel interfaces
          /^ip6tnl\d+/,        // IPv6 tunnel interfaces
          /^tun\d+$/,          // Generic tunnel interfaces
          /^tap\d+$/,          // TAP interfaces
        ];
        
        // Exclude if name matches any irrelevant pattern
        if (irrelevantPatterns.some(pattern => pattern.test(detail.name))) {
          return false;
        }
        
        return true;
      }
      
      // Exclude everything else (down interfaces with no MAC, tunnels, etc.)
      return false;
    });
  }

  /** ✅ Get detailed interface information including MAC addresses */
  private static getInterfaceDetails(systemType: string): InterfaceDetail[] {
    switch (systemType) {
      case 'termux':
        return this.getTermuxInterfaceDetails();
      case 'raspberry-pi':
      case 'linux':
        return this.getLinuxInterfaceDetails();
      default:
        return this.getDefaultInterfaceDetails();
    }
  }

  /** ✅ Get Linux interface details with MAC addresses */
  private static getLinuxInterfaceDetails(): InterfaceDetail[] {
    const details: InterfaceDetail[] = [];

    try {
      // Get all network interfaces
      const interfaces = execSync('ls /sys/class/net', {
        encoding: 'utf8',
        timeout: 2000,
      })
        .trim()
        .split('\n');

      for (const interfaceName of interfaces.slice(0, this.MAX_INTERFACES)) {
        try {
          const detail: InterfaceDetail = {
            name: interfaceName,
            macAddress: 'Unknown',
            state: 'unknown',
            type: 'unknown',
          };

          // Get MAC address
          try {
            const macAddress = execSync(
              `cat /sys/class/net/${interfaceName}/address`,
              {
                encoding: 'utf8',
                timeout: 1000,
              },
            ).trim();
            if (macAddress && macAddress !== '00:00:00:00:00:00') {
              detail.macAddress = macAddress.toUpperCase();
            }
          } catch {
            // MAC address not available for this interface
          }

          // Get IP address using ip command
          try {
            const ipOutput = execSync(`ip -4 addr show ${interfaceName}`, {
              encoding: 'utf8',
              timeout: 1000,
            });
            const ipMatch = ipOutput.match(/inet\s+([0-9.]+)/);
            if (ipMatch && ipMatch[1]) {
              detail.ipAddress = ipMatch[1];
            }
          } catch {
            // IP address not available
          }

          // Get interface state
          try {
            const operstate = execSync(
              `cat /sys/class/net/${interfaceName}/operstate`,
              {
                encoding: 'utf8',
                timeout: 1000,
              },
            )
              .trim()
              .toLowerCase();
            detail.state =
              operstate === 'up'
                ? 'up'
                : operstate === 'down'
                  ? 'down'
                  : 'unknown';
          } catch {
            detail.state = 'unknown';
          }

          // Determine interface type
          detail.type = this.determineInterfaceType(interfaceName);

          // Get IP address for this interface
          try {
            const ipOutput = execSync(
              `ip -4 addr show ${interfaceName} | grep inet | head -1 | awk '{print $2}' | cut -d/ -f1`,
              { encoding: 'utf8', timeout: 1000 },
            ).trim();
            if (ipOutput && ipOutput !== '') {
              detail.ipAddress = ipOutput;
            }
          } catch {
            // No IP address found for this interface
          }

          details.push(detail);
        } catch (error) {
          // Skip interfaces that can't be read
        }
      }
    } catch (error) {
      // Failed to get Linux interface details
    }

    return details;
  }

  /** ✅ Get Termux interface details with MAC addresses */
  private static getTermuxInterfaceDetails(): InterfaceDetail[] {
    const details: InterfaceDetail[] = [];

    try {
      // Primary method: Use 'ip link show' for better MAC address detection
      try {
        const ipLinkOutput = execSync('ip link show', {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
        });

        // Parse ip link show output
        const lines = ipLinkOutput.split('\n');
        let currentInterface: InterfaceDetail | null = null;

        for (const line of lines) {
          const trimmed = line.trim();
          
          // Look for interface declaration line (e.g., "21: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>")
          const interfaceMatch = trimmed.match(/^\d+:\s+([^:]+):\s+<([^>]+)>/);
          if (interfaceMatch) {
            // Save previous interface if it exists
            if (currentInterface && currentInterface.name !== 'lo') {
              details.push(currentInterface);
            }

            const interfaceName = interfaceMatch[1].trim();
            const flags = interfaceMatch[2];

            // Skip loopback interface
            if (interfaceName === 'lo') {
              currentInterface = null;
              continue;
            }

            currentInterface = {
              name: interfaceName,
              macAddress: 'Unknown',
              state: flags.includes('UP') ? 'up' : 'down',
              type: this.determineInterfaceType(interfaceName),
            };
          }
          
          // Look for MAC address line (e.g., "link/ether 70:19:88:87:ff:d5 brd ff:ff:ff:ff:ff:ff")
          const macMatch = trimmed.match(/link\/ether\s+([a-fA-F0-9:]{17})/);
          if (macMatch && currentInterface) {
            currentInterface.macAddress = macMatch[1].toUpperCase();
          }
        }

        // Don't forget the last interface
        if (currentInterface && currentInterface.name !== 'lo') {
          details.push(currentInterface);
        }

        // Now get IP addresses for all detected interfaces using 'ip addr show'
        if (details.length > 0) {
          try {
            const ipAddrOutput = execSync('ip addr show', {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
            });

            // Parse IP addresses for each interface
            for (const detail of details) {
              const interfaceRegex = new RegExp(`^\\d+:\\s+${detail.name}:.*?(?=^\\d+:|$)`, 'ms');
              const interfaceSection = ipAddrOutput.match(interfaceRegex);
              
              if (interfaceSection) {
                // Look for inet (IPv4) address
                const ipMatch = interfaceSection[0].match(/inet\s+([0-9.]+)/);
                if (ipMatch) {
                  detail.ipAddress = ipMatch[1];
                }
              }
            }
          } catch (ipAddrError) {
            // IP addresses not available, continue without them
          }
        }
      } catch (ipLinkError) {
        // ip link show failed, try ifconfig fallback
        
        // Fallback: Try ifconfig if ip link fails
        try {
          const ifconfigOutput = execSync('ifconfig 2>/dev/null', {
            encoding: 'utf8',
            timeout: 3000,
          });
          const sections = ifconfigOutput.split(/\n\n+/);

          for (const section of sections) {
            if (section.includes('lo:') || section.includes('lo ')) continue; // Skip loopback

            const detail: InterfaceDetail = {
              name: 'Unknown',
              macAddress: 'Unknown',
              state: 'unknown',
              type: 'unknown',
            };

            // Extract interface name
            const interfaceMatch = section.match(/^([a-zA-Z0-9]+)[\s:]/);
            if (interfaceMatch) {
              detail.name = interfaceMatch[1];
            }

            // Extract MAC address (HWaddr or ether)
            const macMatch = section.match(
              /(?:HWaddr|ether)\s+([a-fA-F0-9:]{17})/,
            );
            if (macMatch) {
              detail.macAddress = macMatch[1].toUpperCase();
            }

            // Check if interface is up
            if (section.includes('UP') || section.includes('RUNNING')) {
              detail.state = 'up';
            } else if (section.includes('DOWN')) {
              detail.state = 'down';
            }

            // Determine interface type
            if (detail.name !== 'Unknown') {
              detail.type = this.determineInterfaceType(detail.name);
            }

            // Extract IP address from the same ifconfig section
            const ipMatch = section.match(/inet\s+(?:addr:)?([0-9.]+)/);
            if (ipMatch) {
              detail.ipAddress = ipMatch[1];
            }

            if (detail.name !== 'Unknown') {
              details.push(detail);
            }
          }
        } catch (ifconfigError) {
          // ifconfig fallback also failed in Termux
        }
      }

      // If we have WiFi info and no proper MAC addresses were found, try Termux WiFi API
      if (details.some((d) => d.type === 'wifi')) {
        try {
          const wifiInfo = JSON.parse(
            execSync('termux-wifi-connectioninfo', {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
            }),
          ) as { bssid?: string };

          if (wifiInfo?.bssid) {
            // Find wifi interface and update MAC if needed
            const wifiInterface = details.find((d) => d.type === 'wifi');
            if (wifiInterface && wifiInterface.macAddress === 'Unknown') {
              // Note: BSSID is the router's MAC, not the device's MAC
              // But we can use it as additional info
              wifiInterface.macAddress = wifiInfo.bssid.toUpperCase();
            }
          }
        } catch (apiError) {
          // Termux WiFi API not available
        }
      }
    } catch (error) {
      // Failed to get Termux interface details
    }

    return details;
  }

  /** ✅ Get default interface details (fallback) */
  private static getDefaultInterfaceDetails(): InterfaceDetail[] {
    return [
      {
        name: 'Unknown',
        macAddress: 'Unknown',
        state: 'unknown',
        type: 'unknown',
      },
    ];
  }

  /** ✅ Get primary MAC address from interface details */
  private static getPrimaryMacAddress(
    interfaceDetails: InterfaceDetail[],
    primaryIp?: string,
  ): string {
    // If we have a primary IP, try to find the interface with that IP
    if (primaryIp && primaryIp !== 'Unknown') {
      const primaryInterface = interfaceDetails.find(
        (detail) =>
          detail.ipAddress === primaryIp &&
          detail.macAddress !== 'Unknown' &&
          detail.macAddress !== '00:00:00:00:00:00',
      );
      if (primaryInterface) {
        return primaryInterface.macAddress;
      }
    }

    // Fallback: Find first active interface with a valid MAC
    const activeInterface = interfaceDetails.find(
      (detail) =>
        detail.state === 'up' &&
        detail.type !== 'loopback' &&
        detail.macAddress !== 'Unknown' &&
        detail.macAddress !== '00:00:00:00:00:00',
    );

    if (activeInterface) {
      return activeInterface.macAddress;
    }

    // Last fallback: Find first non-loopback interface with a valid MAC
    const validInterface = interfaceDetails.find(
      (detail) =>
        detail.type !== 'loopback' &&
        detail.macAddress !== 'Unknown' &&
        detail.macAddress !== '00:00:00:00:00:00',
    );

    return validInterface?.macAddress || 'Unknown';
  }

  /** ✅ Get DNS servers */
  private static getDnsServers(): string[] {
    try {
      // Detect system type for appropriate DNS method
      let systemType = 'linux'; // default
      try {
        // Check if we're in Termux
        execSync('command -v termux-info', { stdio: 'ignore', timeout: 1000 });
        systemType = 'termux';
      } catch {
        // Not Termux, assume Linux
      }
      
      if (systemType === 'termux') {
        return this.getTermuxDnsServers();
      } else {
        return this.getLinuxDnsServers();
      }
    } catch {
      return ['Unknown'];
    }
  }

  /** ✅ Get DNS servers on Termux */
  private static getTermuxDnsServers(): string[] {
    const dnsServers: string[] = [];

    try {
      // Method 1: Try getprop for Android DNS settings
      try {
        const dns1 = execSync('getprop net.dns1', {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
        }).trim();
        const dns2 = execSync('getprop net.dns2', {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
        }).trim();

        if (dns1 && dns1 !== '' && !dns1.startsWith('127.')) {
          dnsServers.push(dns1);
        }
        if (dns2 && dns2 !== '' && !dns2.startsWith('127.')) {
          dnsServers.push(dns2);
        }
      } catch {
        // getprop might not be available
      }

      // Method 2: Try to read from /system/etc/resolv.conf (Android)
      if (dnsServers.length === 0) {
        try {
          const resolveOutput = execSync('cat /system/etc/resolv.conf', {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
          });
          
          const lines = resolveOutput.split('\n');
          for (const line of lines) {
            if (line.startsWith('nameserver ')) {
              const server = line.split(' ')[1];
              if (server && !server.startsWith('127.')) {
                dnsServers.push(server);
              }
            }
          }
        } catch {
          // /system/etc/resolv.conf might not exist
        }
      }

      // Method 3: Try nslookup to detect working DNS
      if (dnsServers.length === 0) {
        try {
          // Common public DNS servers to test
          const testDns = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
          for (const dns of testDns) {
            try {
              execSync(`nslookup google.com ${dns}`, {
                encoding: 'utf8',
                timeout: 3000,
              });
              dnsServers.push(dns);
              break; // Use first working DNS
            } catch {
              // This DNS doesn't work, try next
            }
          }
        } catch {
          // nslookup not available
        }
      }

      // Fallback: Common public DNS
      if (dnsServers.length === 0) {
        dnsServers.push('8.8.8.8', '1.1.1.1');
      }

    } catch (error) {
      // Failed to get Termux DNS servers
    }

    return dnsServers.length > 0 ? dnsServers : ['Unknown'];
  }

  /** ✅ Get DNS servers on Linux */
  private static getLinuxDnsServers(): string[] {
    try {
      const dnsOutput = execSync('cat /etc/resolv.conf', {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
      });

      const dnsServers: string[] = [];
      const lines = dnsOutput.split('\n');

      for (const line of lines) {
        if (line.startsWith('nameserver ')) {
          const server = line.split(' ')[1];
          if (server && !server.startsWith('127.')) {
            dnsServers.push(server);
          }
        }
      }

      return dnsServers.length > 0 ? dnsServers : ['Unknown'];
    } catch {
      return ['Unknown'];
    }
  }

  /** ✅ Determine interface type based on name */
  private static determineInterfaceType(
    interfaceName: string,
  ): 'ethernet' | 'wifi' | 'loopback' | 'unknown' {
    const name = interfaceName.toLowerCase();

    if (name.includes('lo') || name === 'loopback') {
      return 'loopback';
    } else if (
      name.includes('wlan') ||
      name.includes('wifi') ||
      name.includes('wlp')
    ) {
      return 'wifi';
    } else if (
      name.includes('eth') ||
      name.includes('enp') ||
      name.includes('eno') ||
      name.includes('ens')
    ) {
      return 'ethernet';
    } else {
      return 'unknown';
    }
  }

  /** ✅ Get network info on Linux / Raspberry Pi */
  private static getLinuxNetworkInfo(): NetworkInfo {
    try {
      // Get all IPv4 addresses excluding loopback
      const ipOutput = execSync(
        "ip -4 addr show | grep inet | grep -v '127.0.0.1' | awk '{print $2}'",
        { encoding: 'utf8', timeout: NETWORK_CONSTANTS.HTTP_TIMEOUT },
      )
        .split('\n')
        .filter(Boolean);

      const gateway = execSync("ip route | awk '/default/ {print $3}'", {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();

      const interfaces = execSync('ls /sys/class/net', {
        encoding: 'utf8',
        timeout: 2000,
      })
        .trim()
        .split('\n');

      // Get external IP (cached or fresh)
      const externalIp = this.getCachedExternalIp();

      // Get interface details with MAC addresses
      const interfaceDetails = this.getInterfaceDetails('linux');
      const primaryIp = ipOutput.length > 0 ? ipOutput[0].split('/')[0] : 'Unknown';

      return {
        primaryIp,
        macAddress: this.getPrimaryMacAddress(interfaceDetails, primaryIp),
        gateway: gateway || 'Unknown',
        interfaces:
          interfaces.length > 0
            ? interfaces.slice(0, this.MAX_INTERFACES)
            : ['Unknown'],
        interfaceDetails: interfaceDetails.slice(0, this.MAX_INTERFACES),
        dns: this.getDnsServers(),
        externalIp: externalIp || 'Unknown',
        timestamp: Date.now(),
      };
    } catch {
      return this.getDefaultNetworkInfo();
    }
  }

  /** ✅ Get network info on Termux (Android) */
  private static getTermuxNetworkInfo(): NetworkInfo {
    try {
      let primaryIp = 'Unknown';
      let gateway = 'Unknown';
      let externalIp = 'Unknown';
      const interfaces: string[] = [];

      // Primary method: Get gateway from routing table using multiple ip route methods
      try {
        // Method 1: Try 'ip route get' to a reliable external IP (most accurate)
        try {
          const routeGetOutput = execSync('ip route get 8.8.8.8', {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
          });
          
          // Parse output like: "8.8.8.8 via 10.0.10.1 dev eth0 table 1021 src 10.0.10.187"
          const getViaMatch = routeGetOutput.match(/via\s+([0-9.]+)/);
          if (getViaMatch) {
            gateway = getViaMatch[1];
          }

          // Extract the primary interface from dev field
          const getDevMatch = routeGetOutput.match(/dev\s+([a-zA-Z0-9]+)/);
          if (getDevMatch) {
            const primaryInterface = getDevMatch[1];
            if (!interfaces.includes(primaryInterface)) {
              interfaces.push(primaryInterface);
            }
          }

          // Extract the primary IP from src field
          const getSrcMatch = routeGetOutput.match(/src\s+([0-9.]+)/);
          if (getSrcMatch) {
            primaryIp = getSrcMatch[1];
          }
        } catch (routeGetError) {
          // ip route get failed, trying ip route show
        }

        // Method 2: If route get failed, try standard ip route commands
        if (gateway === 'Unknown') {
          const routeOutput = execSync('ip route', {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
          });

          // Look for default route first (most common)
          const defaultRouteMatch = routeOutput.match(/default\s+via\s+([0-9.]+)/);
          if (defaultRouteMatch) {
            gateway = defaultRouteMatch[1];
          } else {
            // If no default route, try to extract gateway from network routes
            // Look for patterns like "10.0.10.0/24 via 10.0.10.1 dev eth0"
            const viaRouteMatch = routeOutput.match(/([0-9.]+\/\d+)\s+via\s+([0-9.]+)/);
            if (viaRouteMatch) {
              gateway = viaRouteMatch[2];
            } else {
              // For directly connected networks, infer gateway from network
              // Example: "10.0.10.0/24 dev eth0 proto kernel scope link src 10.0.10.187"
              const directRouteMatch = routeOutput.match(/([0-9.]+)\.0\/24\s+dev\s+\w+.*src\s+([0-9.]+)/);
              if (directRouteMatch) {
                const networkBase = directRouteMatch[1];
                // Commonly gateway is .1 in the network
                gateway = `${networkBase}.1`; 
              }
            }
          }
        }
      } catch (routeError) {
        // ip route failed, trying alternative methods
      }

      // Try to get additional interfaces from ifconfig (only if we need more info)
      try {
        const ifconfigOutput = execSync('ifconfig 2>/dev/null', {
          encoding: 'utf8',
          timeout: 3000,
        });
        const sections = ifconfigOutput.split(/\n\n+/);

        for (const section of sections) {
          if (section.includes('lo:')) continue; // Skip loopback

          // Extract interface name
          const interfaceMatch = section.match(/^([a-zA-Z0-9]+):/);
          const ifaceName = interfaceMatch ? interfaceMatch[1] : null;

          if (ifaceName && !interfaces.includes(ifaceName)) {
            // Only add additional interfaces (primary interface should already be from ip route get)
            interfaces.push(ifaceName);
          }

          // Only look for IP if we haven't found it yet from ip route get
          if (primaryIp === 'Unknown') {
            const ipMatch = section.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch && ipMatch[1]) {
              primaryIp = ipMatch[1];
            }
          }
        }
      } catch (ifconfigError) {
        // ifconfig failed
      }

      // If ifconfig didn't give us an IP, try termux-wifi-connectioninfo
      if (primaryIp === 'Unknown') {
        try {
          const wifiInfo = JSON.parse(
            execSync('termux-wifi-connectioninfo', {
              encoding: 'utf8',
              timeout: 3000,
            }),
          ) as { ip?: string; gateway?: string };

          if (wifiInfo?.ip) {
            primaryIp = wifiInfo.ip;
            // Only use termux API gateway if we couldn't get it from ip route
            if (gateway === 'Unknown' && wifiInfo.gateway) {
              gateway = wifiInfo.gateway;
            }
            if (!interfaces.includes('wlan0')) interfaces.push('wlan0');
          }
        } catch (wifiError) {
          // Termux API not available
        }
      }

      // Get interface details with MAC addresses
      const interfaceDetails = this.getInterfaceDetails('termux');
      const filteredInterfaceDetails = this.filterRelevantInterfaces(interfaceDetails);

      // Get external IP
      externalIp = this.getCachedExternalIp() || 'Unknown';

            // Final network info object

      return {
        primaryIp,
        macAddress: this.getPrimaryMacAddress(interfaceDetails, primaryIp),
        gateway,
        interfaces,
        interfaceDetails: filteredInterfaceDetails,
        dns: this.getDnsServers(),
        externalIp,
        timestamp: Date.now(),
      };
    } catch {
      return this.getDefaultNetworkInfo();
    }
  }

  /** ✅ Default fallback network info */
  private static getDefaultNetworkInfo(): NetworkInfo {
    return {
      primaryIp: 'Unknown',
      macAddress: 'Unknown',
      gateway: 'Unknown',
      interfaces: ['Unknown'],
      interfaceDetails: [
        {
          name: 'Unknown',
          macAddress: 'Unknown',
          state: 'unknown',
          type: 'unknown',
        },
      ],
      dns: ['Unknown'],
      externalIp: 'Unknown',
      timestamp: Date.now(),
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
      // Gateway detection failed
      
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
            // Failed to get IP after all retries
          }
        } catch (urlError) {
          const error = urlError as Error;
          continue;
        }
      }
    } catch (error) {
      const err = error as Error;
      // External IP detection failed
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