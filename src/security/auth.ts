import { getLogger } from '../utils/logger';

export class Authenticator {
  private gatewayToken: string;

  constructor(gatewayToken: string) {
    this.gatewayToken = gatewayToken;
  }

  validateGatewayToken(token: string): boolean {
    const valid = token === this.gatewayToken;
    if (!valid) {
      getLogger().warn('Invalid gateway auth token attempt');
    }
    return valid;
  }

  isUserAllowed(userId: string, allowList: string[]): boolean {
    if (allowList.length === 0) return true;
    return allowList.includes(userId);
  }
}
