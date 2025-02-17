import * as fs from 'fs';

export class StorageInfoUtil {
  /** ✅ Get total storage in bytes */
  static getTotalStorage(): number {
    try {
      const stat = fs.statfsSync('/');
      return stat.blocks * stat.bsize; // ✅ Total size in bytes
    } catch (error) {
      console.error('❌ Failed to get total storage:', error.message);
      return 0;
    }
  }

  /** ✅ Get free storage in bytes */
  static getFreeStorage(): number {
    try {
      const stat = fs.statfsSync('/');
      return stat.bfree * stat.bsize; // ✅ Using `.bfree` as per TypeScript definitions
    } catch (error) {
      console.error('❌ Failed to get free storage:', error.message);
      return 0;
    }
  }
}
