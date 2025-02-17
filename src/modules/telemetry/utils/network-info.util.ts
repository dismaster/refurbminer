import { execSync } from 'child_process';
import * as https from 'https';

export class NetworkInfoUtil {
  /** ✅ Get network details based on system type */
  static getNetworkInfo(systemType: string): any {
    switch (systemType) {
      case 'termux':
        return this.getTermuxNetworkInfo();
      case 'raspberry-pi':
      case 'linux':
        return this.getLinuxNetworkInfo();
      default:
        return this.getDefaultNetworkInfo();
    }
  }

  /** ✅ Get network info on Linux / Raspberry Pi */
  private static getLinuxNetworkInfo() {
    try {
      // Get all IPv4 addresses excluding loopback
      const ipOutput = execSync(
        "ip -4 addr show | grep inet | grep -v '127.0.0.1' | awk '{print $2}'", 
        { encoding: 'utf8' }
      ).split('\n').filter(Boolean);

      const gateway = execSync(
        "ip route | awk '/default/ {print $3}'", 
        { encoding: 'utf8' }
      ).trim();

      const interfaces = execSync(
        "ls /sys/class/net", 
        { encoding: 'utf8' }
      ).trim().split('\n');

      // Get external IP
      const externalIp = execSync(
        "curl -s https://api.ipify.org", 
        { encoding: 'utf8' }
      ).trim();

      return {
        primaryIp: ipOutput.length > 0 ? ipOutput[0].split('/')[0] : 'Unknown',
        externalIp: externalIp || 'Unknown',
        gateway: gateway || 'Unknown',
        interfaces: interfaces.length > 0 ? interfaces : ['Unknown']
      };
    } catch {
      return this.getDefaultNetworkInfo();
    }
  }

/** ✅ Get network info on Termux (Android) */
private static getTermuxNetworkInfo() {
  try {
    // Get external IP only (doesn't require special permissions)
    const externalIp = execSync(
      "curl -s https://api.ipify.org", 
      { encoding: 'utf8' }
    ).trim();

    let primaryIp = 'Unknown';
    let gateway = 'Unknown';
    let interfaces: string[] = [];

    try {
      // Get IP address for wlan0
      const ipOutput = execSync(
        "ip -4 addr show wlan0 2>/dev/null | grep inet", 
        { encoding: 'utf8' }
      ).trim();
      
      if (ipOutput) {
        const ipMatch = ipOutput.match(/inet\s+([0-9.]+)/);
        if (ipMatch && ipMatch[1]) {
          primaryIp = ipMatch[1];
        }
      }

      // Try to get gateway from route info
      const routeOutput = execSync(
        "ip route", 
        { encoding: 'utf8' }
      ).trim();
      
      if (routeOutput) {
        // First try default route
        const defaultMatch = routeOutput.match(/default via ([0-9.]+)/);
        if (defaultMatch && defaultMatch[1]) {
          gateway = defaultMatch[1];
        } else {
          // If no default route, try to extract network gateway
          const networkMatch = routeOutput.match(/([0-9.]+)\/\d+/);
          if (networkMatch && networkMatch[1]) {
            const network = networkMatch[1].split('.');
            network[3] = '1';
            gateway = network.join('.');
          }
        }
      }

      // Get interfaces using a more reliable method
      const interfaceOutput = execSync(
        "ip -br link show | awk '{print $1}'",
        { encoding: 'utf8' }
      ).trim();

      if (interfaceOutput) {
        interfaces = interfaceOutput
          .split('\n')
          .map(iface => iface.trim())
          .filter(iface => 
            iface &&
            iface !== 'dummy0' &&
            !iface.startsWith('ip') &&
            !iface.startsWith('sit') &&
            !iface.startsWith('rmnet') &&
            !iface.startsWith('umts') &&
            !iface.startsWith('rev_') &&
            !iface.includes('_') &&
            !iface.includes('@') &&
            iface !== 'p2p0'
          );
      }

      // If no interfaces found, fallback to basic ones
      if (!interfaces.length) {
        interfaces = ['lo', 'wlan0'];
      }

    } catch (error) {
      console.error(`❌ Failed to get network details: ${error.message}`);
    }

    return {
      primaryIp,
      externalIp: externalIp || 'Unknown',
      gateway,
      interfaces: interfaces.length ? interfaces : ['Unknown']
    };
  } catch {
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
}