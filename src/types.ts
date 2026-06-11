export interface Plugin {
  name: string;
  url?: string;
  branch?: string;
  enabled?: boolean;
  autoUpdate?: boolean;
  updateInterval?: number; // hours between git fetch checks, default 1
}

export interface NpmPlugin {
  name: string;
  version: string;
  installed: boolean;
  raw: string;
}

export interface DaemonManifest {
  script: string;
  runtime?: string;
  port?: number;
  healthCheckUrl?: string;
}
