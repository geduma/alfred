export interface HealthMonitorConfig {
  enabled: boolean;
  check_interval_minutes: number;
  severity_threshold: 'warn' | 'error';
  notifications: {
    telegram?: { enabled: boolean; chat_id?: string };
  };
}

export interface HealthFinding {
  severity: 'warn' | 'error';
  category: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample: string;
}
