export class RateLimiter {
  private limits: Map<string, number[]> = new Map();

  isAllowed(key: string, limit: number, windowSeconds: number): boolean {
    const now = Date.now();
    const timestamps = this.limits.get(key) || [];
    const recent = timestamps.filter(t => now - t < windowSeconds * 1000);

    if (recent.length >= limit) {
      return false;
    }

    recent.push(now);
    this.limits.set(key, recent);

    return true;
  }

  checkUser(userId: string, requestsPerHour: number): boolean {
    return this.isAllowed(`user:${userId}`, requestsPerHour, 3600);
  }

  checkChannel(channel: string, requestsPerHour: number): boolean {
    return this.isAllowed(`channel:${channel}`, requestsPerHour, 3600);
  }

  reset(key: string): void {
    this.limits.delete(key);
  }

  getUsage(key: string): number {
    const now = Date.now();
    const timestamps = this.limits.get(key) || [];
    return timestamps.filter(t => now - t < 3600000).length;
  }
}
