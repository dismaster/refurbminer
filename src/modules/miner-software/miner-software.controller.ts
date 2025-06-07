import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { MinerSoftwareService } from './miner-software.service';

@Controller('miner-software')
export class MinerSoftwareController {
  constructor(private readonly minerSoftwareService: MinerSoftwareService) {}

  /**
   * Get system compatibility information
   */
  @Get('compatibility')
  async getCompatibility() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    return {
      compatible: compatibility.hasAES && compatibility.is64Bit,
      details: compatibility,
    };
  }

  /**
   * Get all miners status
   */
  @Get('status')
  async getAllMinersStatus() {
    return await this.minerSoftwareService.getAllMinersStatus();
  }

  /**
   * Get specific miner information
   */
  @Get(':miner/info')
  getMinerInfo(@Param('miner') minerName: string) {
    return this.minerSoftwareService.getMinerInfo(minerName);
  }

  /**
   * Validate specific miner
   */
  @Get(':miner/validate')
  async validateMiner(@Param('miner') minerName: string) {
    return await this.minerSoftwareService.validateMiner(minerName);
  }

  /**
   * Get download information for a miner
   */
  @Get(':miner/download-info')
  async getDownloadInfo(@Param('miner') minerName: string) {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    const downloadInfo = this.minerSoftwareService.getDownloadInfo(minerName, compatibility);
    
    if (!downloadInfo) {
      return {
        available: false,
        message: `No download information available for ${minerName} on this system`,
      };
    }

    return {
      available: true,
      ...downloadInfo,
      requiresSourceBuild: downloadInfo.url === 'SOURCE_BUILD',
    };
  }

  /**
   * Set executable permissions for a miner
   */
  @Post(':miner/set-executable')
  async setExecutablePermissions(@Param('miner') minerName: string) {
    const success = await this.minerSoftwareService.setExecutablePermissions(minerName);
    
    return {
      success,
      message: success 
        ? `Executable permissions set for ${minerName}` 
        : `Failed to set executable permissions for ${minerName}`,
    };
  }

  /**
   * Health check endpoint for miner software
   */
  @Get('health')
  async healthCheck() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    const allMiners = await this.minerSoftwareService.getAllMinersStatus();
    
    const healthyMiners = Object.values(allMiners).filter(
      miner => miner.exists && miner.executable && miner.compatible
    );
    
    return {
      systemCompatible: compatibility.hasAES && compatibility.is64Bit,
      minersInstalled: Object.keys(allMiners).length,
      minersHealthy: healthyMiners.length,
      details: {
        compatibility,
        miners: allMiners,
      },
    };
  }

  /**
   * Download optimal ccminer version for the current system
   */
  @Post('ccminer/download')
  async downloadOptimalCcminer() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    const success = await this.minerSoftwareService.downloadOptimalCcminer(compatibility);
    
    return {
      success,
      message: success 
        ? 'Optimal ccminer downloaded successfully' 
        : 'Failed to download optimal ccminer',
      compatibility: {
        os: compatibility.os,
        architecture: compatibility.architecture,
        hasAES: compatibility.hasAES,
        is64Bit: compatibility.is64Bit,
        isTermux: compatibility.isTermux,
      },
    };
  }

  /**
   * Get recommended ccminer branch for current system
   */
  @Get('ccminer/branch')
  async getRecommendedCcminerBranch() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    const branch = await this.minerSoftwareService.selectCcminerBranch(compatibility);
    
    return {
      recommendedBranch: branch,
      compatibility,
      downloadUrl: `https://raw.githubusercontent.com/Darktron/pre-compiled/${branch}/ccminer`,
    };
  }

  /**
   * Check XMRig compilation prerequisites
   */
  @Get('xmrig/prerequisites')
  async checkXmrigPrerequisites() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    const prerequisites = await this.minerSoftwareService.checkXmrigPrerequisites(compatibility);
    
    return {
      ...prerequisites,
      systemInfo: {
        isTermux: compatibility.isTermux,
        hasRoot: compatibility.hasRoot,
        architecture: compatibility.architecture,
      },
    };
  }

  /**
   * Compile and install XMRig (Termux only)
   */
  @Post('xmrig/compile')
  async compileXmrig() {
    const compatibility = await this.minerSoftwareService.checkCPUCompatibility();
    
    if (!compatibility.isTermux) {
      return {
        success: false,
        message: 'XMRig compilation is only supported in Termux environment',
        isTermux: compatibility.isTermux,
      };
    }

    const success = await this.minerSoftwareService.compileAndInstallXmrig(compatibility);
    
    return {
      success,
      message: success 
        ? 'XMRig compiled and installed successfully' 
        : 'XMRig compilation failed',
      isTermux: compatibility.isTermux,
      architecture: compatibility.architecture,
    };
  }
}
