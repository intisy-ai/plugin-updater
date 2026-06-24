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
        GH_REPOS[GitHub (intisy/plugin-*)]
        LOCAL_WORKSPACE[(.config/github/repos/intisy/)]
        CC_PLUGINS[(.claude/plugin/)]
        OC_PLUGINS[(.config/opencode/plugin/)]
        
        GIT_MGR <-->|git clone/pull| GH_REPOS
        GIT_MGR -->|Updates source| LOCAL_WORKSPACE
        DEPLOYER -->|Copies compiled output| CC_PLUGINS
        DEPLOYER -->|Copies compiled output| OC_PLUGINS
    end
```

## Cross-app plugin sync (`sync: true`)

A `plugins.json` entry flagged `sync: true` is mirrored into the **other** app's `plugins.json`, so a plugin enabled in OpenCode is also installed in Claude Code (and vice versa). At the start of `earlyLaunch`, plugin-updater loads [sync-bridge](https://github.com/intisy/sync-bridge)'s library bundle (`dist/lib.js`) and calls `syncPlugins()`, then re-reads the list so a freshly-synced-in plugin is cloned and built in the **same** launch. It is additive (never removes) and a no-op when sync-bridge isn't installed.

```jsonc
{ "name": "antigravity-auth", "url": "https://github.com/intisy/antigravity-auth", "enabled": true, "autoUpdate": false, "sync": true }
```

Set it from the CLI with `--sync`:
```bash
plugin-updater add https://github.com/intisy/antigravity-auth --sync
```

## API

| Method | Description |
|---|---|
| `rebuild(pluginItem)` | Pull latest and redeploy |
| `downgrade(pluginItem, commitHash)` | Checkout specific commit |
| `disable(pluginItem)` | Cleanup on disable |
| `uninstall(pluginItem)` | Remove repo and deployed files |
| `registerTests(testApi)` | Register sync verification tests |

## License

MIT
