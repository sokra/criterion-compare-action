const { inspect } = require("util");
const { basename, join, resolve } = require("path");
const { mkdtemp, copyFile, rm, readFile, mkdir } = require("fs/promises");
const exec = require("@actions/exec");
const core = require("@actions/core");
const github = require("@actions/github");

const context = github.context;

function handleBoolean(str) {
  if (str === "true") return true;
  if (str === "false") return false;
  if (str === "0") return false;
  if (str === "no") return false;
  if (str === "off") return false;
  if (str) return true;
  return false;
}

async function main() {
  const inputs = {
    token: core.getInput("token", { required: true }),
    branchName: core.getInput("branchName", { required: true }),
    title: core.getInput("title"),
    quiet: handleBoolean(core.getInput("quiet")),
    silent: handleBoolean(core.getInput("silent")),
    cwd: core.getInput("cwd"),
    benchName: core.getInput("benchName"),
    features: core.getInput("features"),
    defaultFeatures: core.getInput("defaultFeatures"),
  };
  core.debug(`Inputs: ${inspect(inputs)}`);

  const options = {};
  if (inputs.cwd) {
    options.cwd = inputs.cwd;
  }
  const cwd = inputs.cwd ? resolve(process.cwd(), inputs.cwd) : process.cwd();

  let benchCmd = ["bench"];
  if (inputs.benchName) {
    benchCmd = benchCmd.concat(["--bench", inputs.benchName]);
  }

  if (!inputs.defaultFeatures) {
    benchCmd = benchCmd.concat(["--no-default-features"]);
  }

  if (inputs.features) {
    benchCmd = benchCmd.concat(["--features", inputs.features]);
  }

  core.debug("### Compiling ###");
  async function getExecutables() {
    let output = "";
    await exec.exec(
      "cargo",
      benchCmd.concat(["--no-run", "--message-format", "json"]),
      {
        ...options,
        silent: true,
        listeners: {
          stdout: (data) => {
            output += data.toString();
          },
        },
      }
    );
    let executables = [];
    for (const line of output.split("\n")) {
      if (!line) continue;
      const data = JSON.parse(line);
      if (!data.target) continue;
      const kind = data.target.kind[0];
      if (!["bench", "bin"].includes(kind)) continue;
      const name = data.target.name;
      const path = data.executable;
      if (!path) continue;
      executables.push({ path, kind, name });
    }
    return executables;
  }
  async function listCases(executable) {
    let output = "";
    await exec.exec(executable, ["--bench", "--list"], {
      ...options,
      listeners: {
        stdout: (data) => {
          output += data.toString();
        },
      },
    });
    let cases = new Set();
    for (const line of output.split("\n")) {
      const match = /^(.+): bench\r?$/.exec(line);
      if (match) {
        cases.add(match[1]);
      }
    }
    return cases;
  }
  async function listAllCases(executables) {
    let object = {};
    for (const { path, kind } of executables) {
      if (kind !== "bench") continue;
      let cases = await listCases(path);
      for (const testCase of cases) {
        object[testCase] = path;
      }
    }
    return object;
  }
  async function moveExecutables(executables) {
    const newExecutables = [];
    await mkdir(join(cwd, "target"), { recursive: true });
    const dir = await mkdtemp(join(cwd, "target", "criterion-compare"));
    for (const executable of executables) {
      const name = basename(executable.path);
      const path = join(dir, name);
      await copyFile(executable.path, path);
      newExecutables.push({ ...executable, path });
    }
    return newExecutables;
  }
  function createBinExeEnv(executables) {
    let env = {};
    for (const { name, path, kind } of executables) {
      if (kind === "bench") continue;
      env[`CARGO_BIN_EXE_${name}`] = path;
    }
    return env;
  }
  await exec.exec("cargo", benchCmd.concat(["--no-run"]), options);
  core.debug("Changes compiled");

  const changesExecutables = await getExecutables();
  const movedChangesExecutables = await moveExecutables(changesExecutables);
  const changesTestCases = await listAllCases(movedChangesExecutables);
  const changesEnv = createBinExeEnv(movedChangesExecutables);
  core.debug("Changes listed");

  await exec.exec("git", [
    "checkout",
    core.getInput("branchName") || github.base_ref,
  ]);
  core.debug("Checked out to base branch");

  await exec.exec("cargo", benchCmd.concat(["--no-run"]), options);
  core.debug("Base compiled");

  const baseExecutables = await getExecutables();
  const movedBaseExecutables = await moveExecutables(baseExecutables);
  const baseTestCases = await listAllCases(movedBaseExecutables);
  const baseEnv = createBinExeEnv(movedBaseExecutables);
  core.debug("Base listed");

  await exec.exec("git", ["checkout", "-"]);
  core.debug("Checked out to changes branch");

  core.debug("Clear baselines");
  rm(join(cwd, "target/criterion"), {
    recursive: true,
    force: true,
  });

  core.debug("### Benchmark starting ###");
  let onBaseBranch = false;
  const allTestCases = new Set([
    ...Object.keys(changesTestCases),
    ...Object.keys(baseTestCases),
  ]);
  for (const testCase of allTestCases) {
    const changesExecutable = changesTestCases[testCase];
    const baseExecutable = baseTestCases[testCase];

    if (changesExecutable) {
      if (onBaseBranch) {
        await exec.exec("git", ["checkout", "-"]);
        core.debug(`${testCase}: Checked out to changes branch`);
        onBaseBranch = false;
      }

      await exec.exec(
        changesExecutable,
        ["--bench", testCase, "--save-baseline", "changes", "--noplot"],
        {
          ...options,
          env: {
            ...process.env,
            ...changesEnv,
          },
        }
      );
      core.debug(`${testCase}: Changes benchmarked`);
    }

    if (baseExecutable) {
      if (!onBaseBranch) {
        await exec.exec("git", [
          "checkout",
          core.getInput("branchName") || github.base_ref,
        ]);
        core.debug(`${testCase}: Checked out to base branch`);
        onBaseBranch = true;
      }

      await exec.exec(
        baseExecutable,
        ["--bench", testCase, "--save-baseline", "base", "--noplot"],
        {
          ...options,
          env: {
            ...process.env,
            ...baseEnv,
          },
        }
      );
      core.debug(`${testCase}: Base benchmarked`);
    }
  }

  if (onBaseBranch) {
    await exec.exec("git", ["checkout", "-"]);
    core.debug("Checked out to changes branch");
    onBaseBranch = false;
  }

  const data = await readCriterionData(cwd, allTestCases);

  const {
    significant,
    comment: commentBody,
    summary,
  } = convertToMarkdown(data, inputs.title);

  // Display results here in any case
  console.log(summary);

  if ((!inputs.quiet || significant) && !inputs.silent) {
    try {
      // An authenticated instance of `@octokit/rest`
      const octokit = github.getOctokit(inputs.token);

      const contextObj = { ...context.issue };

      const { data: comment } = await octokit.rest.issues.createComment({
        owner: contextObj.owner,
        repo: contextObj.repo,
        issue_number: contextObj.number,
        body: commentBody,
      });
      core.info(
        `Created comment id '${comment.id}' on issue '${contextObj.number}' in '${contextObj.repo}'.`
      );
      core.setOutput("comment-id", comment.id);
    } catch (err) {
      // forkedRepos only have READ ONLY access on GITHUB_TOKEN
      // https://github.community/t5/GitHub-Actions/quot-Resource-not-accessible-by-integration-quot-for-adding-a/td-p/33925
      core.warning(`Failed to comment: ${err}`);
      core.info("Commenting is not possible from forks.");
    }
  }

  core.debug("Succesfully run!");
}

async function readJson(path) {
  try {
    const data = await readFile(path);
    return JSON.parse(data.toString("utf-8"));
  } catch {
    return null;
  }
}

function getStats(data) {
  if (!data) return null;
  if (data.slope) {
    return {
      value: data.slope.point_estimate / 1000 / 1000 / 1000,
      stdErr: data.slope.standard_error / 1000 / 1000 / 1000,
    };
  } else if (data.mean) {
    return {
      value: data.mean.point_estimate / 1000 / 1000 / 1000,
      stdErr: data.mean.standard_error / 1000 / 1000 / 1000,
    };
  } else {
    return null;
  }
}

async function readCriterionData(cwd, testCases) {
  const dir = join(cwd, "target", "criterion");

  let entries = [];

  for (const testCase of testCases) {
    const basePath = join(dir, testCase, "base", "estimates.json");
    const changesPath = join(dir, testCase, "changes", "estimates.json");
    const base = await readJson(basePath);
    const changes = await readJson(changesPath);
    const baseStats = getStats(base);
    const changesStats = getStats(changes);

    entries.push([testCase, baseStats, changesStats]);
  }

  entries.sort((a, b) => {
    if (a[0] < b[0]) {
      return -1;
    }
    if (a[0] > b[0]) {
      return 1;
    }
    return 0;
  });

  return entries;
}

const SIGNIFICANT_FACTOR = 2;

function isSignificant(changesDur, changesErr, baseDur, baseErr) {
  const changesMin = changesDur - SIGNIFICANT_FACTOR * changesErr;
  const changesMax = changesDur + SIGNIFICANT_FACTOR * changesErr;
  const baseMin = baseDur - SIGNIFICANT_FACTOR * baseErr;
  const baseMax = baseDur + SIGNIFICANT_FACTOR * baseErr;
  const isFaster = changesMax < baseMin;
  const isSlower = baseMax < changesMin;
  return isFaster || isSlower;
}

function diffPercentage(changes, base) {
  return (changes / base - 1) * 100;
}

function significantDiffPercentage(changesDur, changesErr, baseDur, baseErr) {
  const changesMin = changesDur - SIGNIFICANT_FACTOR * changesErr;
  const changesMax = changesDur + SIGNIFICANT_FACTOR * changesErr;
  const baseMin = baseDur - SIGNIFICANT_FACTOR * baseErr;
  const baseMax = baseDur + SIGNIFICANT_FACTOR * baseErr;

  if (changesMax < baseMin) {
    return diffPercentage(changesMax, baseMin);
  } else if (baseMax < changesMin) {
    return diffPercentage(changesMin, baseMax);
  } else {
    return 0;
  }
}

function formatPercentage(value) {
  if (value == 0) return "";
  return (value <= 0 ? "" : "+") + value.toFixed(2) + "%";
}

function formatStats(stats) {
  if (!stats) return "N/A";
  let v = stats.value;
  let e = stats.stdErr;
  if (v > 10) {
    return `${v.toFixed(2)}s ± ${e.toFixed(2)}s`;
  }
  v *= 1000;
  e *= 1000;
  if (v > 10) {
    return `${v.toFixed(2)}ms ± ${e.toFixed(2)}ms`;
  }
  v *= 1000;
  e *= 1000;
  return `${v.toFixed(2)}µs ± ${e.toFixed(2)}µs`;
}

function convertToMarkdown(data, title) {
  let significant = [];
  let rows = [];
  data.forEach(([name, base, changes]) => {
    let baseUndefined = !base;
    let changesUndefined = !changes;

    if (!name || (baseUndefined && changesUndefined)) {
      return "";
    }

    let baseDuration = formatStats(base);
    let changesDuration = formatStats(changes);

    let difference = "N/A";
    let significantDifference = "N/A";
    if (!baseUndefined && !changesUndefined) {
      difference = diffPercentage(changes.value, base.value);
      significantDifference = significantDiffPercentage(
        changes.value,
        changes.stdErr,
        base.value,
        base.stdErr
      );
      difference = formatPercentage(difference);
      significantDifference = formatPercentage(significantDifference);
      if (
        isSignificant(changes.value, changes.stdErr, base.value, base.stdErr)
      ) {
        if (changes.value < base.value) {
          baseDuration = `**${baseDuration}**`;
        } else if (changes.value > base.value) {
          changesDuration = `**${changesDuration}**`;
        }
      }
    }

    name = name.replace(/\|/g, "\\|");

    const line = `| ${name} | ${baseDuration} | ${changesDuration} | ${difference} | ${significantDifference} |`;
    if (significantDifference) {
      significant.push(line);
    }
    rows.push(line);
  });

  const header = `| Test | Base         | PR               | % | Significant % |
|------|--------------|------------------|---|--------------|`;

  const shortSha = context.sha ? context.sha.slice(0, 7) : "unknown";
  let comment;
  if (significant.length > 0) {
    comment = `## ${title || "Benchmark"} for ${shortSha}

${header}
${significant.join("\n")}
  
<details>
  <summary>Click to view full benchmark</summary>
  
${header}
${rows.join("\n")}
  
</details>
`;
  } else {
    comment = `## ${title || "Benchmark"} for ${shortSha}

<details>
  <summary>Click to view benchmark</summary>

${header}
${rows.join("\n")}

</details>
`;
  }
  const summary = `## ${title || "Benchmark"} for ${shortSha}
  
${header}
${rows.join("\n")}`;
  return {
    significant: significant.length > 0,
    comment,
    summary,
  };
}

// IIFE to be able to use async/await
(async () => {
  try {
    await main();
  } catch (e) {
    console.log(e.stack);
    core.setFailed(`Unhanded error:\n${e}`);
  }
})();
