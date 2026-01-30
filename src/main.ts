import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { LoggingService } from './modules/logging/logging.service';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import * as os from 'os';

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

  let isShuttingDown = false;
  const shutdown = async (reason: string, error?: unknown, exitCode: number = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

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