export interface Plugin {
  name: string;
  url?: string;
  branch?: string;
  enabled?: boolean;
  // inherit (or absent) follows the home's auto_update_mode; on and off override it.
  // Older entries used true (= inherit) and false (= off), which still read correctly.
  autoUpdate?: boolean | "inherit" | "on" | "off";
  updateInterval?: number; // hours between git fetch checks, default 1
  sync?: boolean; // mirror this entry into the other app's plugins.json (via sync-bridge)
  commitHash?: string | null; // pin to a specific commit (e.g. after a downgrade); persists across earlyLaunch runs
  // inherit (or absent) follows the home's experimental flag; stable and experimental override it.
  channel?: "inherit" | "stable" | "experimental";
}

export interface NpmPlugin {
  name: string;
  version: string;
  installed: boolean;
  raw: string;
  /** The package's entry file in this home, absent when nothing resolves it. */
  entryPath?: string;
}

export interface DaemonManifest {
  script: string;
  runtime?: string;
  port?: number;
  healthCheckUrl?: string;
}
