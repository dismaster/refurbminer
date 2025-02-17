import * as os from 'os';

export class MemoryInfoUtil {
  /** ✅ Get total RAM */
  static getTotalMemory(): number {
    return os.totalmem();
  }

  /** ✅ Get free RAM */
  static getFreeMemory(): number {
    return os.freemem();
  }
}
