const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPOS_DIR = path.join(require('os').homedir(), '.config', 'github');

function executeGit(cmd, dir) {
  try {
    return execSync(cmd, { cwd: dir, timeout: 60000, stdio: "ignore" });
  } catch (e) {
    console.error(`[Updater] Git command failed: ${cmd} in ${dir}`);
    return false;
  }
}

module.exports = {
  name: "plugin-updater",

  /**
   * Called by the launcher (OpenCode/Claude Code) to sync a specific plugin
   */
  updatePlugin: function(pluginName, gitUrl, branch = null, commitHash = null) {
    const targetDir = path.join(REPOS_DIR, pluginName);
    
    // 1. Ensure directory exists and clone or pull
    if (!fs.existsSync(targetDir)) {
      if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });
      const branchFlag = branch ? `--branch ${branch}` : "";
      executeGit(`git clone --recurse-submodules ${branchFlag} ${gitUrl} ${pluginName}`, REPOS_DIR);
    } else {
      executeGit("git fetch origin", targetDir);
      if (commitHash) {
        executeGit(`git checkout ${commitHash}`, targetDir);
      } else if (branch) {
        executeGit(`git checkout ${branch}`, targetDir);
        executeGit(`git pull --ff-only origin ${branch}`, targetDir);
      } else {
        executeGit("git checkout main || git checkout master", targetDir);
        executeGit("git pull --ff-only", targetDir);
      }
      executeGit("git submodule update --init --recursive", targetDir);
    }

    return true;
  },

  /**
   * Called to deploy the compiled output to the execution directory
   */
  deployToExecutionDir: function(pluginName, executionPath) {
    const sourceDir = path.join(REPOS_DIR, pluginName);
    if (!fs.existsSync(sourceDir)) return false;

    // Build if package.json exists
    if (fs.existsSync(path.join(sourceDir, "package.json"))) {
      try {
        execSync("npm install", { cwd: sourceDir, stdio: "ignore" });
        execSync("npm run build", { cwd: sourceDir, stdio: "ignore" });
      } catch (e) {
        // Fallback or ignore if no build step
      }
    }

    // Determine deployment source (prefer dist, fallback to root)
    const distPath = path.join(sourceDir, "dist");
    const deploySource = fs.existsSync(distPath) ? distPath : sourceDir;

    // Create a specific folder for this plugin inside the execution path
    const pluginExecutionPath = path.join(executionPath, pluginName);
    if (!fs.existsSync(pluginExecutionPath)) {
      fs.mkdirSync(pluginExecutionPath, { recursive: true });
    }

    try {
      // Platform agnostic copy (using Node fs)
      fs.cpSync(deploySource, pluginExecutionPath, { recursive: true, force: true });
      return true;
    } catch (e) {
      console.error(`[Updater] Deploy failed: ${e.message}`);
      return false;
    }
  },

  rebuild: function(pluginObjOrName) {
    const pluginName = typeof pluginObjOrName === 'string' ? pluginObjOrName : pluginObjOrName.name;
    const targetDir = path.join(REPOS_DIR, pluginName);
    if (fs.existsSync(targetDir)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (e) {}
    }
    return null; // Return null for success
  },

  disable: function(plugin) {
    // Just delete the deployed folder, the hub will update plugins.json
    try {
      const configDir = path.join(require('os').homedir(), ".config", "opencode");
      const pluginExecutionPath = path.join(configDir, "plugin", plugin.name);
      if (fs.existsSync(pluginExecutionPath)) {
        fs.rmSync(pluginExecutionPath, { recursive: true, force: true });
      }
    } catch (e) {}
  },

  uninstall: function(plugin) {
    this.disable(plugin);
    const targetDir = path.join(REPOS_DIR, plugin.name);
    if (fs.existsSync(targetDir)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (e) {}
    }
  },

  /**
   * Specific logic to install/update the launcher itself
   */
  installLauncher: function() {
    // Logic to install opencode-hub / claude-hub if they are missing
    this.updatePlugin("core-hub", "https://github.com/intisy/core-hub.git");
    this.updatePlugin("opencode-hub", "https://github.com/intisy/opencode-hub.git");
    this.updatePlugin("claude-hub", "https://github.com/intisy/claude-hub.git");
  }
};
