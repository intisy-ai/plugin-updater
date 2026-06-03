# Plugin Updater - Specifications & Test Requirements

## Goal
Reliable core update mechanism for all OpenCode and Claude Code plugins.

## Requirements
- [ ] **Installation Order**: Must be installed FIRST in OpenCode, as it is responsible for installing all other plugins.
- [ ] **Reliability**: Must never fail or crash, as the entire ecosystem depends on it.
- [ ] **Launch Detection**: 
  - If a Hub plugin (opencode-hub / claude-hub) is active, defer the update invocation until the Hub is launched.
  - If launched via the normal application command (no hub), it must still execute its update routine automatically.
