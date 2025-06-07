import { EnvironmentConfigUtil } from '../src/modules/flightsheet/utils/environment-config.util';

/**
 * Test script to verify environment detection functionality
 */
async function testEnvironmentDetection() {
  console.log('🧪 Testing Environment Detection...\n');

  try {
    // Test environment detection
    const environmentInfo = EnvironmentConfigUtil.detectEnvironment();
    
    console.log('📊 Environment Information:');
    console.log(`  - Environment: ${environmentInfo.isTermux ? 'Termux' : 'Linux'}`);
    console.log(`  - Total Memory: ${environmentInfo.totalMemoryGB.toFixed(2)} GB`);
    console.log(`  - CPU Cores: ${environmentInfo.cpuCores}`);
    console.log(`  - Architecture: ${environmentInfo.architecture}`);
    console.log(`  - Root Access: ${environmentInfo.hasRoot ? 'Yes' : 'No'}`);
    console.log(`  - Huge Pages Support: ${environmentInfo.hasHugePageSupport ? 'Yes' : 'No'}`);
    console.log(`  - Recommended RandomX Mode: ${environmentInfo.recommendedRandomXMode}`);
    console.log(`  - Should Use Huge Pages: ${environmentInfo.shouldUseHugePages ? 'Yes' : 'No'}\n`);

    // Test environment summary
    const summary = EnvironmentConfigUtil.getEnvironmentSummary(environmentInfo);
    console.log('📋 Environment Summary:');
    console.log(`  ${summary}\n`);

    // Test XMRig configuration optimization
    console.log('⚡ Testing XMRig Configuration Optimization...');
    
    // Sample base configuration (simplified)
    const baseConfig = {
      randomx: {
        mode: 'auto',
        '1gb-pages': true,
      },
      cpu: {
        'huge-pages': true,
        'huge-pages-jit': true,
        'memory-pool': true,
        yield: false,
        priority: null,
      },
      http: {
        host: '0.0.0.0',
        port: 4068,
      },
      colors: true,
      'print-time': 60,
      'health-print-time': 60,
    };

    const optimizedConfig = EnvironmentConfigUtil.generateOptimalXMRigConfig(
      baseConfig,
      environmentInfo
    );

    console.log('  Base Configuration:');
    console.log(`    - RandomX Mode: ${baseConfig.randomx.mode}`);
    console.log(`    - Huge Pages: ${baseConfig.cpu['huge-pages']}`);
    console.log(`    - Memory Pool: ${baseConfig.cpu['memory-pool']}`);
    console.log(`    - Print Time: ${baseConfig['print-time']}`);
    
    console.log('  Optimized Configuration:');
    console.log(`    - RandomX Mode: ${optimizedConfig.randomx.mode}`);
    console.log(`    - Huge Pages: ${optimizedConfig.cpu['huge-pages']}`);
    console.log(`    - Memory Pool: ${optimizedConfig.cpu['memory-pool']}`);
    console.log(`    - Print Time: ${optimizedConfig['print-time']}`);
    
    // Show optimization changes
    const changes = [];
    if (baseConfig.randomx.mode !== optimizedConfig.randomx.mode) {
      changes.push(`RandomX mode: ${baseConfig.randomx.mode} → ${optimizedConfig.randomx.mode}`);
    }
    if (baseConfig.cpu['huge-pages'] !== optimizedConfig.cpu['huge-pages']) {
      changes.push(`Huge pages: ${baseConfig.cpu['huge-pages']} → ${optimizedConfig.cpu['huge-pages']}`);
    }
    if (baseConfig.cpu['memory-pool'] !== optimizedConfig.cpu['memory-pool']) {
      changes.push(`Memory pool: ${baseConfig.cpu['memory-pool']} → ${optimizedConfig.cpu['memory-pool']}`);
    }
    if (baseConfig['print-time'] !== optimizedConfig['print-time']) {
      changes.push(`Print time: ${baseConfig['print-time']} → ${optimizedConfig['print-time']}`);
    }

    console.log(`\n🔧 Applied Optimizations: ${changes.length > 0 ? changes.join(', ') : 'None (configuration already optimal)'}`);
    
    console.log('\n✅ Environment detection test completed successfully!');
    
  } catch (error) {
    console.error('❌ Environment detection test failed:', error.message);
    console.error(error.stack);
  }
}

// Run the test
testEnvironmentDetection();
