import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';
import { ConfigService } from './modules/config/config.service';
import { MinerManagerService } from './modules/miner-manager/miner-manager.service';
import { MinerDataService } from './modules/miner-data/miner-data.service';
import { EnhancedTelemetryService } from './modules/telemetry/enhanced-telemetry.service';

@Controller()
export class AppController {
    constructor(
        private readonly configService: ConfigService,
        private readonly minerManagerService: MinerManagerService,
        private readonly minerDataService: MinerDataService,
        private readonly telemetryService: EnhancedTelemetryService,
    ) {}

    @Get()
    root(@Res() res: Response) {
        return res.sendFile(join(process.cwd(), 'dist', 'public', 'index.html'));
    }

    @Get('health')
    async health() {
        const minerRunning = await this.minerManagerService.isMinerRunningAsync();

        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            minerRunning,
            lastMinerStartAt: this.minerManagerService.getLastMinerStartAt(),
            lastTelemetrySentAt: this.minerDataService.getLastTelemetrySentAt(),
            lastTelemetryGeneratedAt: this.telemetryService.getLastTelemetryGeneratedAt(),
            lastConfigSyncAt: this.configService.getLastSyncSuccessAt(),
        };
    }
}