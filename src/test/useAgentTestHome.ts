import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * useAgent.js statically imports config.js, whose CONFIG_DIR is computed
 * from os.homedir() once at module-load time. Importing this file first (see
 * useAgent.test.tsx) points HOME at a scratch directory before that happens,
 * so the setProviderEverywhere/setModelEverywhere tests' saveConfig() calls
 * never touch the developer's real ~/.kritya/config.json.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-useagent-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
