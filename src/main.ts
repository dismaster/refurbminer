import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { LoggingService } from './modules/logging/logging.service';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import * as os from 'os';
import { promises as fs } from 'fs';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const loggingService = app.get(LoggingService);

  loggingService.log(
    `🧾 Startup baseline: node=${process.version}, platform=${process.platform}, arch=${process.arch}, os=${os.release()}`,
    'INFO',
    'app',
  );

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter(loggingService));

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  // Enable CORS
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: ${await app.getUrl()}`);

  const startedAt = Date.now();
  let isShuttingDown = false;
  let shutdownReason: string | null = null;

  const writeShutdownTrace = async (
    reason: string,
    details?: Record<string, unknown>,
  ) => {
    try {
      const tracesDir = join(process.cwd(), 'logs');
      await fs.mkdir(tracesDir, { recursive: true });
      const tracePath = join(tracesDir, 'shutdown-trace.log');
      const traceLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        reason,
        pid: process.pid,
        ppid: process.ppid,
        uptimeSeconds: Math.round(process.uptime()),
        runtimeMs: Date.now() - startedAt,
        platform: process.platform,
        node: process.version,
        details: details ?? {},
      });
      await fs.appendFile(tracePath, `${traceLine}\n`, 'utf8');
    } catch {
      // Do not fail shutdown diagnostics due to file I/O issues
    }
  };

  const shutdown = async (reason: string, error?: unknown, exitCode: number = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownReason = reason;

    const errorMessage = error instanceof Error ? error.message : error ? String(error) : '';
    const stack = error instanceof Error ? error.stack : undefined;

    try {
      loggingService.log(
        `🛑 Shutdown requested: ${reason}${errorMessage ? ` - ${errorMessage}` : ''}`,
        exitCode === 0 ? 'INFO' : 'ERROR',
        'app',
        stack ? { stack } : undefined,
      );
    } catch {
      // Fallback to console if logger is unavailable
      console.error(`Shutdown requested: ${reason}`, errorMessage);
    }

    await writeShutdownTrace(reason, {
      errorMessage,
      hasStack: !!stack,
      memory: process.memoryUsage(),
      cwd: process.cwd(),
      argv: process.argv,
    });

    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout after 10 seconds')), 10000),
        ),
      ]);
    } catch (closeError) {
      console.error('Error during graceful shutdown:', closeError);
    } finally {
      process.exit(exitCode);
    }
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(`signal:${signal}`, undefined, 0);
  };

  // Prepend so we record the signal cause before other shutdown listeners run.
  process.prependListener('SIGTERM', () => handleSignal('SIGTERM'));
  process.prependListener('SIGINT', () => handleSignal('SIGINT'));
  process.prependListener('SIGHUP', () => handleSignal('SIGHUP'));

  // Useful on Windows terminals and some process managers.
  if (process.platform === 'win32') {
    process.prependListener('SIGBREAK', () => handleSignal('SIGBREAK'));
  }

  process.on('beforeExit', (code) => {
    void writeShutdownTrace('beforeExit', {
      code,
      shutdownReason,
    });
  });

  process.on('exit', (code) => {
    const message = `🧾 Process exit code=${code}${shutdownReason ? `, reason=${shutdownReason}` : ''}`;
    try {
      loggingService.log(message, code === 0 ? 'INFO' : 'ERROR', 'app');
    } catch {
      console.error(message);
    }
  });

  process.on('uncaughtException', (error) => {
    // Check if this is a console I/O error during shutdown (from update process)
    const isIOError = error instanceof Error && (
      error.message.includes('EIO') ||
      error.message.includes('EPIPE') ||
      error.message.includes('EBADF')
    );
    
    if (isIOError) {
      // Suppress I/O errors during shutdown gracefully
      console.error('I/O error during shutdown (likely from update process), exiting gracefully');
      process.exit(0);
    }
    
    void shutdown('uncaughtException', error, 1);
  });

  process.on('unhandledRejection', (reason) => {
    void shutdown('unhandledRejection', reason, 1);
  });

}

bootstrap();