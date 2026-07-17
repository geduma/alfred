const CLEANUP_INTERVAL = 3_600_000;

export class RateLimiter {
  private limits: Map<string, number[]> = new Map();
  private bursts: Map<string, number[]> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(autoCleanup = true) {
    if (autoCleanup) {
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  isAllowed(key: string, limit: number, windowSeconds: number, burstSize = 0): boolean {
    const now = Date.now();
    const timestamps = this.limits.get(key) || [];
    const recent = timestamps.filter(t => now - t < windowSeconds * 1000);

    if (recent.length >= limit) {
      if (burstSize > 0) {
        return this.tryBurst(key, burstSize, now);
      }
      return false;
    }

    recent.push(now);
    this.limits.set(key, recent);
    return true;
  }

  private tryBurst(key: string, burstSize: number, now: number): boolean {
    const burstTimestamps = this.bursts.get(key) || [];
    const recentBursts = burstTimestamps.filter(t => now - t < 60_000);

    if (recentBursts.length >= burstSize) {
      return false;
    }

    recentBursts.push(now);
    this.bursts.set(key, recentBursts);
    return true;
  }

  checkUser(userId: string, requestsPerHour: number): boolean {
    return this.isAllowed(`user:${userId}`, requestsPerHour, 3600, 5);
  }

  checkChannel(channel: string, requestsPerHour: number): boolean {
    return this.isAllowed(`channel:${channel}`, requestsPerHour, 3600, 10);
  }

  reset(key: string): void {
    this.limits.delete(key);
    this.bursts.delete(key);
  }

  getUsage(key: string): number {
    const now = Date.now();
    const timestamps = this.limits.get(key) || [];
    return timestamps.filter(t => now - t < 3600000).length;
  }

  getRemaining(key: string, limit: number): number {
    return Math.max(0, limit - this.getUsage(key));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.limits) {
      const recent = timestamps.filter(t => now - t < 7200_000);
      if (recent.length === 0) {
        this.limits.delete(key);
      } else {
        this.limits.set(key, recent);
      }
    }
    for (const [key, timestamps] of this.bursts) {
      const recent = timestamps.filter(t => now - t < 120_000);
      if (recent.length === 0) {
        this.bursts.delete(key);
      } else {
        this.bursts.set(key, recent);
      }
    }
  }
}