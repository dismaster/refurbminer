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
    let primaryIp = 'Unknown';
    let gateway = 'Unknown';
    let externalIp = 'Unknown';
    let interfaces: string[] = [];

    // Try to get interface and IP from ifconfig with suppressed stderr
    try {
      const ifconfigOutput = execSync('ifconfig 2>/dev/null', { encoding: 'utf8' });
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
          execSync('termux-wifi-connectioninfo', { encoding: 'utf8' })
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

    // Get external IP using curl only
    try {
      const urls = [
        'https://api.ipify.org',
        'https://ifconfig.me',
        'https://icanhazip.com'
      ];
      
      for (const url of urls) {
        try {
          const result = execSync(
            `curl -s --max-time 3 ${url}`,
            { encoding: 'utf8' }
          ).trim();
          
          if (result && result.match(/^\d+\.\d+\.\d+\.\d+$/)) {
            externalIp = result;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      console.debug('External IP detection failed:', error.message);
    }

    // If we still don't have interfaces, add a default
    if (interfaces.length === 0) {
      interfaces.push('Unknown');
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
      { encoding: 'utf8' }
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
      { encoding: 'utf8' }
    ).trim();
    
    const pingMatch = pingOutput.match(/From ([0-9.]+)/);
    if (pingMatch && pingMatch[1]) {
      return pingMatch[1];
    }
  } catch (error) {
    console.debug('Gateway detection failed:', error.message);
    
    // Last resort: try to derive gateway from IP
    try {
      const ip = execSync('getprop dhcp.wlan0.ipaddress', { encoding: 'utf8' }).trim();
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

}