# plugin-updater

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

- `src/` — TypeScript source (`index` engine + `git`, `npm`, `deploy`, `config`, `log`, `env`, `syncbridge`, `cli`, `commands`).
- `core/` — git submodule ([`intisy-ai/core`](https://github.com/intisy-ai/core)): shared config + the cross-app command framework, bundled to `core/dist/index.js`.
- `dist/` — compiled output (generated; not committed). `dist/index.js` is the plugin entry + the `node … config` CLI; `dist/cli.js` is the `plugin-updater` bin.

## Installation

plugin-updater is the one plugin added directly to OpenCode's `opencode.jsonc` (every other plugin goes through `plugins.json`); the loaders also resolve and run it on startup. To add it manually:
```bash
npm install -g plugin-updater
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

## Commands

Deployed automatically to both apps on each `earlyLaunch` (`~/.config/opencode/command/` and `~/.claude/commands/`):

| Command | Description |
| --- | --- |
| `/plugin-updater-config` | View/change plugin-updater config: `list`, `get <key>`, `set <key> <value>`. 100% of the config is reachable here. |

(The loaders own `/plugins`; plugin-updater drives the actual install/update lifecycle behind it.)

## Configuration

> Config files are **never auto-created on launch** — settings are registered with defaults (core `defineConfig`) and edited in the loader's **Plugins → Configure** screen (or `/<plugin>-config`); a file is written only when you change a value. **Global console logging** for every plugin is toggled in `config/settings.json` (`logConsole: true`, the opencode.json-equivalent).

Config file: `~/.config/opencode/config/plugin-updater.json` (preferred) or `~/.config/opencode/plugin-updater.json` (fallback); same under `~/.claude` for Claude Code.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `logging` | boolean | `true` | Write a per-session log file. Set `false` to disable. |

## Dependencies

- **`core`** (required) — bundled git submodule (config + command framework); no separate install.
- **`sync-bridge`** (optional) — loaded at runtime for `syncPlugins()`; absent, cross-app sync no-ops.

## Logging

Logs to `~/.config/opencode/logs/YYYY-MM-DD/plugin-updater-HH-MM-SS.log` (Claude: under `~/.claude/`). Set `"logging": false` to disable.

## License

MIT
