/**
 * Helper functions for error handling and retry mechanisms 
 * for the Refurbminer application.
 */

/**
 * Safely executes a synchronous function with proper error handling
 * @param operation Function to execute
 * @param fallbackValue Fallback value if operation fails
 * @param operationName Name of operation for logging
 * @param logger Optional logging function
 * @returns Result of operation or fallback value
 */
export function safeExecute<T>(
  operation: () => T,
  fallbackValue: T,
  operationName: string = 'operation',
  logger?: (message: string, level: string, context: string) => void
): T {
  try {
    return operation();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (logger) {
      logger(
        `❌ Failed to execute ${operationName}: ${errorMessage}`,
        'ERROR',
        'telemetry'
      );
    } else {
      console.error(`Failed to execute ${operationName}: ${errorMessage}`);
    }
    
    return fallbackValue;
  }
}

/**
 * Safely executes an asynchronous function with retry mechanism
 * @param operation Async function to execute
 * @param fallbackValue Fallback value if operation fails after all retries
 * @param operationName Name of operation for logging
 * @param maxRetries Maximum number of retry attempts
 * @param retryDelay Delay between retries in milliseconds
 * @param logger Optional logging function
 * @returns Promise that resolves to operation result or fallback value
 */
export async function safeExecuteAsync<T>(
  operation: () => Promise<T>,
  fallbackValue: T,
  operationName: string = 'operation',
  maxRetries: number = 3,
  retryDelay: number = 1000,
  logger?: (message: string, level: string, context: string) => void
): Promise<T> {
  let retries = 0;
  
  while (retries <= maxRetries) {
    try {
      return await operation();
    } catch (error) {
      retries++;
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const logLevel = retries >= maxRetries ? 'ERROR' : 'WARN';
      
      if (logger) {
        logger(
          `❌ Failed to execute ${operationName} (attempt ${retries}/${maxRetries + 1}): ${errorMessage}`,
          logLevel,
          'telemetry'
        );
      } else {
        console[logLevel === 'ERROR' ? 'error' : 'warn'](
          `Failed to execute ${operationName} (attempt ${retries}/${maxRetries + 1}): ${errorMessage}`
        );
      }
      
      // If we have more retries, wait before next attempt
      if (retries <= maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  if (logger) {
    logger(
      `🔄 Using fallback value for ${operationName} after ${maxRetries + 1} failed attempts`,
      'WARN',
      'telemetry'
    );
  } else {
    console.warn(`Using fallback value for ${operationName} after ${maxRetries + 1} failed attempts`);
  }
  
  return fallbackValue;
}
