export interface Plugin {
  name: string;
  url?: string;
  branch?: string;
  enabled?: boolean;
  autoUpdate?: boolean;
  updateInterval?: number; // hours between git fetch checks, default 1
  sync?: boolean; // mirror this entry into the other app's plugins.json (via sync-bridge)
  commitHash?: string | null; // pin to a specific commit (e.g. after a downgrade); persists across earlyLaunch runs
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
