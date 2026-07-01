# plugin-updater

[![npm version](https://img.shields.io/npm/v/plugin-updater)](https://www.npmjs.com/package/plugin-updater)
[![npm downloads](https://img.shields.io/npm/dm/plugin-updater)](https://www.npmjs.com/package/plugin-updater)
[![CI](https://img.shields.io/github/actions/workflow/status/intisy-ai/plugin-updater/publish.yml)](https://github.com/intisy-ai/plugin-updater/actions)

Plugin lifecycle manager for OpenCode and Claude Code launchers. Handles install, update, rebuild, downgrade, and uninstall operations for all plugins.

## Under-the-Hood Architecture

```mermaid
flowchart TD
    %% Triggers
    subgraph Execution_Triggers [Execution Triggers]
        CLI_BOOT[CLI Startup (claude/oc)]
        TUI_MENU[Launcher TUI Actions]

        CLI_BOOT -->|Auto-runs hook on start| UPDATER_CORE
        TUI_MENU -->|Manual rebuild/downgrade/uninstall| UPDATER_CORE
    end

    %% Core Logic
    subgraph Plugin_Updater [Updater Core Logic]
        UPDATER_CORE[Updater Engine]
        API_LAYER[global.OpenCodeAPI Interop]
        GIT_MGR[Git Operations Manager]
        DEPLOYER[Plugin Deployer]

        UPDATER_CORE <-->|Requests repo paths| API_LAYER
        UPDATER_CORE -->|Trigger sync| GIT_MGR
        UPDATER_CORE -->|Trigger deploy| DEPLOYER
    end

    %% External & Storage
    subgraph Storage_and_Network [Storage & External]
        GH_REPOS[GitHub (intisy-ai/plugin-*)]
        LOCAL_WORKSPACE[(.config/github/repos/intisy-ai/)]
        CC_PLUGINS[(.claude/plugin/)]
        OC_PLUGINS[(.config/opencode/plugin/)]

        GIT_MGR <-->|git clone/pull| GH_REPOS
        GIT_MGR -->|Updates source| LOCAL_WORKSPACE
        DEPLOYER -->|Copies compiled output| CC_PLUGINS
        DEPLOYER -->|Copies compiled output| OC_PLUGINS
    end
```

## Structure

- `src/`
  - TypeScript source (`index` engine + `git`, `npm`, `deploy`, `config`, `log`, `env`, `syncbridge`, `cli`, `commands`).
- `dist/`
  - `dist/index.js` — plugin entry + the `node … config` CLI; `dist/cli.js` — the `plugin-updater` bin.

## Installation

### Via plugin-updater (recommended)

```bash
npx plugin-updater@latest init https://github.com/intisy-ai/plugin-updater
```

### Via npm

```bash
npm install plugin-updater
```

## Adding plugins

plugin-updater is the one plugin added directly to OpenCode's `opencode.jsonc` (every other plugin goes through `plugins.json`); the loaders also resolve and run it on startup. To register a plugin from the CLI:
```bash
plugin-updater add https://github.com/intisy-ai/<plugin>      # register a git plugin
plugin-updater add https://github.com/intisy-ai/<plugin> --sync  # …and mirror it to the other app
```

## Cross-app plugin sync (`sync: true`)

A `plugins.json` entry flagged `sync: true` is mirrored into the **other** app's `plugins.json`, so a plugin enabled in OpenCode is also installed in Claude Code (and vice versa). At the start of `earlyLaunch`, plugin-updater loads [sync-bridge](https://github.com/intisy-ai/sync-bridge)'s library bundle (`dist/lib.js`) and calls `syncPlugins()`, then re-reads the list so a freshly-synced-in plugin is cloned and built in the **same** launch. It is additive (never removes) and a no-op when sync-bridge isn't installed.

```jsonc
{ "name": "antigravity-auth", "url": "https://github.com/intisy-ai/antigravity-auth", "enabled": true, "autoUpdate": false, "sync": true }
```

Set it from the CLI with `--sync`:
```bash
plugin-updater add https://github.com/intisy-ai/antigravity-auth --sync
```

## API

| Method | Description |
|---|---|
| `rebuild(pluginItem)` | Pull latest and redeploy |
| `downgrade(pluginItem, commitHash)` | Checkout specific commit |
| `disable(pluginItem)` | Cleanup on disable |
| `uninstall(pluginItem)` | Remove repo and deployed files |
| `registerTests(testApi)` | Register sync verification tests |

## Configuration

Config file: `<configDir>/config/plugin-updater.json` (edit via the loader or `/plugin-updater-config set`).

```json
{
  "logging": true,
  "default_update_interval_hours": 1,
  "git_timeout_seconds": 120,
  "npm_timeout_seconds": 300,
  "build_timeout_seconds": 300,
  "daemon_health_timeout_ms": 1500,
  "self_update": true,
  "update_on_launch": true
}
```

| Key | Default |
| --- | --- |
| `logging` | `true` |
| `default_update_interval_hours` | `1` |
| `git_timeout_seconds` | `120` |
| `npm_timeout_seconds` | `300` |
| `build_timeout_seconds` | `300` |
| `daemon_health_timeout_ms` | `1500` |
| `self_update` | `true` |
| `update_on_launch` | `true` |

## Commands

| Command | Description | Arguments |
| --- | --- | --- |
| `/plugin-updater-config` | View/change plugin-updater configuration | `list | get <key> | set <key> <value>` |
| `/config` | View/change ANY plugin's settings and the global settings | `[global | <plugin>] [list | get <key> | set <key> <value>]` |

## Dependencies

- `core`
- `sync-bridge`

## Logging

Logs are written to `<configDir>/logs/YYYY-MM-DD/plugin-updater-HH-MM-SS.log` and are toggled by
this plugin's `logging` config (default on). Console mirroring is global, off by default,
and controlled by the shared `config/settings.json` `logConsole` flag.

## License

MIT.
