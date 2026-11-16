// Plain git helpers with no dependency on the vscode module, so they can be tested with node.
const cp = require("child_process");

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        // Read-only commands must not take the index lock or rewrite the index.
        // Otherwise the built-in git extension sees an index change and refreshes, which refreshes us again.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          if (allowFail) resolve(null);
          else
            reject(
              new Error((stderr && stderr.toString().trim()) || err.message),
            );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Finds the commit where HEAD branched off `branch`.
 * Tries both `branch` and `origin/branch` and uses whichever merge-base is more recent,
 * so a stale local develop doesn't pull extra commits into the review.
 * @returns {Promise<{ref: string, sha: string} | null>}
 */
async function resolveMergeBase(cwd, branch) {
  const candidates = [...new Set([branch, `origin/${branch}`])];
  const found = [];
  for (const ref of candidates) {
    const out = await git(cwd, ["merge-base", "HEAD", ref], {
      allowFail: true,
    });
    if (out) found.push({ ref, sha: out.toString().trim() });
  }
  if (!found.length) return null;
  let best = found[0];
  for (const b of found.slice(1)) {
    if (b.sha === best.sha) continue;
    // If `best` is an ancestor of `b`, then `b` is the more recent branch point.
    const isAncestor = await git(
      cwd,
      ["merge-base", "--is-ancestor", best.sha, b.sha],
      { allowFail: true },
    );
    if (isAncestor !== null) best = b;
  }
  return best;
}

/**
 * Lists every file that differs between `baseSha` and the working tree:
 * committed, staged, unstaged and untracked changes.
 * status: M modified, A added, D deleted, R renamed, C copied, U untracked
 * @returns {Promise<Array<{status: string, path: string, oldPath?: string}>>}
 */
async function getChanges(cwd, baseSha) {
  const diff = (
    await git(cwd, [
      "diff",
      "--name-status",
      "-z",
      "-M",
      "--no-ext-diff",
      "--no-color",
      baseSha,
      "--",
    ])
  ).toString("utf8");
  const parts = diff.split("\0");
  const changes = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    let status = code[0];
    if (status === "R" || status === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      changes.push({ status, oldPath, path: newPath });
    } else {
      const p = parts[i++];
      if (status === "T") status = "M"; // type change, e.g. file <-> symlink
      changes.push({
        status,
        path: p,
        oldPath: status === "A" ? undefined : p,
      });
    }
  }

  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const p of untracked) changes.push({ status: "U", path: p });

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

async function showFile(cwd, ref, relPath) {
  const out = await git(cwd, ["show", `${ref}:${relPath}`], {
    allowFail: true,
  });
  return out ? out.toString("utf8") : "";
}

async function listBranches(cwd) {
  const out = await git(
    cwd,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    {
      allowFail: true,
    },
  );
  if (!out) return [];
  return out
    .toString("utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("/HEAD"));
}

module.exports = { git, resolveMergeBase, getChanges, showFile, listBranches };
