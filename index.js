const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let EARLY_LAUNCH_CONFIG_DIR = null;

function getAppConfigDir(appName) {
  if (EARLY_LAUNCH_CONFIG_DIR) {
    return EARLY_LAUNCH_CONFIG_DIR;
  }
  const home = os.homedir();
  const directPath = path.join(home, `.${appName}`);
  const configPath = path.join(home, ".config", appName);
  return fs.existsSync(directPath) ? directPath : configPath;
}

function writeLog(message, isError = false) {
  try {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0];
    const isClaude = process.argv.join(' ').includes('claude');
    const appName = isClaude ? "claude" : "opencode";
    const configDir = getAppConfigDir(appName);
    
    const logsDir = path.join(configDir, "logs", dateStr);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const logFile = path.join(logsDir, `updater-${dateStr}.log`);
    const prefix = isError ? "[ERROR]" : "[INFO]";
    const logMsg = `[${date.toISOString()}] ${prefix} ${message}\n`;
    
    fs.appendFileSync(logFile, logMsg);
  } catch (e) {
    // Silent fallback if logging fails
  }
  if (isError) console.error(message);
  else console.log(message);
}

function getReposDir() {
  const isClaude = process.argv.join(' ').includes('claude');
  const appName = isClaude ? "claude" : "opencode";
  return path.join(getAppConfigDir(appName), "repos");
}

function executeGit(command, cwd) {
  writeLog(`Executing git: ${command} in ${cwd}`);
  try {
    execSync(command, { cwd, stdio: "ignore" });
    return true;
  } catch (error) {
    writeLog(`Git error in ${cwd}: ${error.message}`, true);
    return false;
  }
}

const updaterAPI = {
  name: "plugin-updater",

  earlyLaunch: function(configDir) {
    EARLY_LAUNCH_CONFIG_DIR = configDir;
    global.__PLUGIN_UPDATER_HANDLED_BY_HUB__ = true;
  },

  updatePlugin: function(pluginName, gitUrl, branch = null, commitHash = null) {
    const reposDir = getReposDir();
    const targetDir = path.join(reposDir, pluginName);
    
    if (!fs.existsSync(targetDir)) {
      if (!fs.existsSync(reposDir)) fs.mkdirSync(reposDir, { recursive: true });
      const branchFlag = branch ? `--branch ${branch}` : "";
      executeGit(`git clone --recurse-submodules ${branchFlag} ${gitUrl} ${pluginName}`, reposDir);
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

  deployToExecutionDir: function(pluginName, executionPath) {
    const sourceDir = path.join(getReposDir(), pluginName);
    if (!fs.existsSync(sourceDir)) return false;

    const packageJsonPath = path.join(sourceDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        writeLog(`Running npm install for ${pluginName}`);
        execSync("npm install", { cwd: sourceDir, stdio: "ignore" });
        writeLog(`Finished npm install for ${pluginName}`);
        
        // Safely check if a build script exists before executing
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.build) {
            execSync("npm run build", { cwd: sourceDir, stdio: "ignore" });
            writeLog(`Finished npm run build for ${pluginName}`);
        } else {
            writeLog(`Skipped npm run build for ${pluginName} (no build script found)`);
        }
      } catch (error) {
        writeLog(`Build/Install failed for ${pluginName}: ${error.message}`, true);
      }
    }

    const distPath = path.join(sourceDir, "dist");
    const deploySource = fs.existsSync(distPath) ? distPath : sourceDir;
    const pluginExecutionPath = path.join(executionPath, pluginName);

    if (!fs.existsSync(pluginExecutionPath)) {
      fs.mkdirSync(pluginExecutionPath, { recursive: true });
    }

    try {
      writeLog(`Running cpSync for ${pluginName}`);
      fs.cpSync(deploySource, pluginExecutionPath, { recursive: true, force: true });
      writeLog(`Finished cpSync for ${pluginName}`);
    } catch (e) {
      writeLog(`cpSync failed for ${pluginName}: ${e.message}`, true);
    }
    return true;
  },

  rebuild: function(pluginName) {
    const isClaude = process.argv.join(' ').includes('claude');
    const configDir = getAppConfigDir(isClaude ? "claude" : "opencode");
    this.deployToExecutionDir(pluginName, path.join(configDir, "plugin"));
    return "Rebuilt " + pluginName;
  },

  downgrade: function(pluginName, commitHash) {
    const reposDir = getReposDir();
    const targetDir = path.join(reposDir, pluginName);
    if (fs.existsSync(targetDir)) {
      executeGit(`git fetch origin`, targetDir);
      executeGit(`git checkout ${commitHash}`, targetDir);
      executeGit(`git submodule update --init --recursive`, targetDir);
      return this.rebuild(pluginName);
    }
    return "Repo not found";
  },

  disable: function(plugin) {
    const isClaude = process.argv.join(' ').includes('claude');
    const configDir = getAppConfigDir(isClaude ? "claude" : "opencode");
    const pluginsJsonPath = path.join(configDir, "config", "plugins.json");
    if (fs.existsSync(pluginsJsonPath)) {
      let plugins = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"));
      const pluginIndex = plugins.findIndex(p => p.name === plugin.name);
      if (pluginIndex >= 0) {
        plugins[pluginIndex].enabled = false;
        fs.writeFileSync(pluginsJsonPath, JSON.stringify(plugins, null, 2), "utf-8");
      }
    }
    const pluginExecutionPath = path.join(configDir, "plugin", plugin.name);
    if (fs.existsSync(pluginExecutionPath)) {
      try { fs.rmSync(pluginExecutionPath, { recursive: true, force: true }); } catch (e) {}
    }
  },

  uninstall: function(plugin) {
    this.disable(plugin);
    const targetDir = path.join(getReposDir(), plugin.name);
    if (fs.existsSync(targetDir)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
};

const pluginUpdaterEntry = async function(input) {
  const configDir = (input && input.configDir) ? input.configDir : path.dirname(getReposDir());
  
  // 1. GUARANTEE BASE DIRECTORIES EXIST ON LAUNCH
  const reposDir = path.join(configDir, "repos");
  const pluginsDir = path.join(configDir, "plugin");
  if (!fs.existsSync(reposDir)) fs.mkdirSync(reposDir, { recursive: true });
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  if (!global.__PLUGIN_UPDATER_HANDLED_BY_HUB__) {
    updaterAPI.earlyLaunch(configDir);

    const pluginsJsonPath = path.join(configDir, "config", "plugins.json");
    if (fs.existsSync(pluginsJsonPath)) {
      try {
        const plugins = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf-8"));
        for (const plugin of plugins) {
          if (plugin.url && plugin.enabled !== false && plugin.type !== "npm") {
            const branch = plugin.branch || null;
            const commit = plugin.commit || null;
            updaterAPI.updatePlugin(plugin.name, plugin.url, branch, commit);
            updaterAPI.deployToExecutionDir(plugin.name, pluginsDir);
          }
        }
      } catch (e) {
        writeLog(`Failed to parse plugins.json: ${e.message}`, true);
      }
    }
  }
  return {};
};

const apiMethods = { ...updaterAPI };
delete apiMethods.name;
Object.assign(pluginUpdaterEntry, apiMethods);

// Guarantee the entry point can be activated as a standard plugin
pluginUpdaterEntry.activate = async function() { return await pluginUpdaterEntry(); };

module.exports = pluginUpdaterEntry;