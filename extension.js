const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { listBranches } = require("./git");
const { ReviewedStore } = require("./reviewed");
const { NotesController } = require("./notes");
const {
  ReviewProvider,
  BaseContentProvider,
  StatusDecorationProvider,
  baseUri,
  workingUri,
  CONTENT_SCHEME,
} = require("./tree");

const VIEW_ID = "branchReview.changes";

/** Finds the enclosing git repo for a file by walking up to the nearest .git (works before the git extension has scanned). */
const rootCache = new Map();
function locate(uri) {
  if (uri.scheme !== "file") return undefined;
  const file = uri.fsPath;
  let dir = path.dirname(file);
  const visited = [];
  let root;
  while (true) {
    if (rootCache.has(dir)) {
      root = rootCache.get(dir);
      break;
    }
    visited.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) {
      root = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      root = null;
      break;
    }
    dir = parent;
  }
  visited.forEach((d) => rootCache.set(d, root));
  if (!root) return undefined;
  return { root, relPath: path.relative(root, file).split(path.sep).join("/") };
}

async function openChanges(node, opts = {}) {
  if (!node || node.kind !== "file") return;
  const { change, state } = node;
  const right = workingUri(state, change.path);
  const name = path.posix.basename(change.path);

  if (change.status === "A" || change.status === "U") {
    return vscode.commands.executeCommand("vscode.open", right, opts);
  }
  const left = baseUri(state, change.oldPath || change.path);
  if (change.status === "D") {
    return vscode.commands.executeCommand("vscode.open", left, opts);
  }
  const oldName = path.posix.basename(change.oldPath || change.path);
  const label = oldName !== name ? `${oldName} → ${name}` : name;
  return vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${label} (${state.base.ref} ↔ Working Tree)`,
    opts,
  );
}

async function openAllChanges(provider, { includeReviewed }) {
  const resources = [];
  let skipped = 0;
  for (const state of provider.states) {
    if (!state.base) continue;
    for (const c of state.changes) {
      if (!includeReviewed && provider.isReviewed(state, c)) {
        skipped++;
        continue;
      }
      const right = workingUri(state, c.path);
      if (c.status === "A" || c.status === "U")
        resources.push([right, undefined, right]);
      else if (c.status === "D")
        resources.push([right, baseUri(state, c.path), undefined]);
      else resources.push([right, baseUri(state, c.oldPath || c.path), right]);
    }
  }
  if (!resources.length) {
    if (skipped) {
      const pick = await vscode.window.showInformationMessage(
        `Branch Review: all ${skipped} changed files are marked reviewed.`,
        "Open All Anyway",
      );
      if (pick) return openAllChanges(provider, { includeReviewed: true });
    } else {
      vscode.window.showInformationMessage(
        "Branch Review: no changes to show.",
      );
    }
    return;
  }
  const suffix =
    includeReviewed || !skipped ? "" : ` (${resources.length} unreviewed)`;
  await vscode.commands.executeCommand(
    "vscode.changes",
    `Branch Review vs ${provider.baseBranch}${suffix}`,
    resources,
  );
}

async function setBaseBranch(provider, context) {
  const cwd = provider.states[0]?.root;
  const branches = cwd ? await listBranches(cwd) : [];
  const configured =
    vscode.workspace.getConfiguration("branchReview").get("baseBranch") ||
    "develop";
  const items = [
    {
      label: `$(settings-gear) Use setting default (${configured})`,
      value: undefined,
    },
    ...branches.map((b) => ({
      label: b,
      value: b,
      description: b === provider.baseBranch ? "current" : undefined,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Compare against… (current: ${provider.baseBranch})`,
    matchOnDescription: true,
  });
  if (!pick) return;
  await context.workspaceState.update("baseBranch", pick.value);
  provider.refresh();
}

async function activate(context) {
  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (!gitExt) {
    vscode.window.showErrorMessage(
      "Branch Review needs the built-in Git extension.",
    );
    return;
  }
  const gitApi = (
    gitExt.isActive ? gitExt.exports : await gitExt.activate()
  ).getAPI(1);

  const reviewed = new ReviewedStore(context.workspaceState);
  const provider = new ReviewProvider(context, gitApi, reviewed);
  const notes = new NotesController(context, locate, () => provider.rebuild());
  provider.notes = notes;

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    manageCheckboxStateManually: true,
  });
  provider.treeView = treeView;

  const setContexts = () => {
    vscode.commands.executeCommand(
      "setContext",
      "branchReview.viewAsTree",
      provider.viewAsTree,
    );
    vscode.commands.executeCommand(
      "setContext",
      "branchReview.hideReviewed",
      provider.hideReviewed,
    );
  };
  setContexts();

  // ---- reviewed marks ----

  /** Finds the change shown in an editor, from either side of a diff. */
  const changeForUri = (uri) => {
    const direct = provider.byEditorUri.get(uri.toString());
    if (direct) return direct;
    if (uri.scheme === CONTENT_SCHEME) {
      const { cwd, path: p } = JSON.parse(uri.query);
      const state = provider.states.find((s) => s.root === cwd);
      const change = state?.changes.find((c) => (c.oldPath || c.path) === p);
      if (change) return { state, change };
    }
    return undefined;
  };

  /** Resolves command arguments (tree node(s), editor URI, or nothing = active editor) to changes. */
  const targetsFrom = (arg, selected) => {
    if (arg instanceof vscode.Uri) return [changeForUri(arg)].filter(Boolean);
    if (!arg) {
      const uri = vscode.window.activeTextEditor?.document.uri;
      return uri ? [changeForUri(uri)].filter(Boolean) : [];
    }
    const nodes = selected?.length ? selected : [arg];
    return nodes
      .flatMap((n) => provider.filesUnder(n))
      .map((n) => ({ state: n.state, change: n.change }));
  };

  const setReviewed = async (targets, value) => {
    for (const { state, change } of targets) {
      if (value)
        await reviewed.set(
          state.root,
          change.path,
          await provider.refreshFingerprint(state, change),
        );
      else await reviewed.unset(state.root, change.path);
    }
    provider.rebuild();
  };

  const markFromCommand = (value) => async (arg, selected) => {
    const targets = targetsFrom(arg, selected);
    if (!targets.length) {
      vscode.window.showInformationMessage(
        "Branch Review: this file is not one of the changed files.",
      );
      return;
    }
    await setReviewed(targets, value);
  };

  // ---- refresh triggers ----

  const repoSubs = new Map();
  const watchRepo = (repo) => {
    if (repoSubs.has(repo)) return;
    repoSubs.set(
      repo,
      repo.state.onDidChange(() => provider.scheduleRefresh()),
    );
  };
  gitApi.repositories.forEach(watchRepo);

  const toRecord = (x) => (x?.kind === "note" ? x.record : x);

  context.subscriptions.push(
    treeView,
    notes,
    vscode.workspace.registerTextDocumentContentProvider(
      CONTENT_SCHEME,
      new BaseContentProvider(),
    ),
    vscode.window.registerFileDecorationProvider(
      new StatusDecorationProvider(),
    ),
    gitApi.onDidOpenRepository((repo) => {
      watchRepo(repo);
      provider.scheduleRefresh();
    }),
    gitApi.onDidCloseRepository((repo) => {
      repoSubs.get(repo)?.dispose();
      repoSubs.delete(repo);
      provider.scheduleRefresh();
    }),
    vscode.workspace.onDidSaveTextDocument(() => provider.scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("branchReview")) provider.refresh();
    }),
    treeView.onDidChangeVisibility(
      (e) => e.visible && provider.scheduleRefresh(0),
    ),
    treeView.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        const targets = provider
          .filesUnder(node)
          .map((n) => ({ state: n.state, change: n.change }));
        await setReviewed(
          targets,
          state === vscode.TreeItemCheckboxState.Checked,
        );
      }
    }),
    { dispose: () => repoSubs.forEach((d) => d.dispose()) },

    // view
    vscode.commands.registerCommand("branchReview.refresh", () =>
      provider.refresh(),
    ),
    vscode.commands.registerCommand("branchReview.openChanges", (node) =>
      openChanges(node),
    ),
    vscode.commands.registerCommand("branchReview.openFile", (node) => {
      if (node?.kind === "file")
        vscode.commands.executeCommand(
          "vscode.open",
          workingUri(node.state, node.change.path),
        );
    }),
    vscode.commands.registerCommand("branchReview.openBaseFile", (node) => {
      if (node?.kind === "file" && node.change.oldPath)
        vscode.commands.executeCommand(
          "vscode.open",
          baseUri(node.state, node.change.oldPath),
        );
    }),
    vscode.commands.registerCommand("branchReview.openAllChanges", () =>
      openAllChanges(provider, { includeReviewed: false }),
    ),
    vscode.commands.registerCommand(
      "branchReview.openAllChangesIncludingReviewed",
      () => openAllChanges(provider, { includeReviewed: true }),
    ),
    vscode.commands.registerCommand("branchReview.setBaseBranch", () =>
      setBaseBranch(provider, context),
    ),
    vscode.commands.registerCommand("branchReview.viewAsTree", async () => {
      await context.globalState.update("viewAsTree", true);
      setContexts();
      provider.rebuild();
    }),
    vscode.commands.registerCommand("branchReview.viewAsList", async () => {
      await context.globalState.update("viewAsTree", false);
      setContexts();
      provider.rebuild();
    }),

    // reviewed
    vscode.commands.registerCommand(
      "branchReview.markReviewed",
      markFromCommand(true),
    ),
    vscode.commands.registerCommand(
      "branchReview.markUnreviewed",
      markFromCommand(false),
    ),
    vscode.commands.registerCommand("branchReview.toggleReviewed", async () => {
      const targets = targetsFrom(undefined);
      if (!targets.length) {
        vscode.window.showInformationMessage(
          "Branch Review: the active editor is not one of the changed files.",
        );
        return;
      }
      const { state, change } = targets[0];
      await setReviewed(targets, !provider.isReviewed(state, change));
    }),
    vscode.commands.registerCommand("branchReview.clearReviewed", async () => {
      const ok = await vscode.window.showWarningMessage(
        "Clear all reviewed marks in this workspace?",
        { modal: true },
        "Clear",
      );
      if (!ok) return;
      await reviewed.clear();
      provider.rebuild();
    }),
    vscode.commands.registerCommand("branchReview.hideReviewed", async () => {
      await context.workspaceState.update("hideReviewed", true);
      setContexts();
      provider.rebuild();
    }),
    vscode.commands.registerCommand("branchReview.showReviewed", async () => {
      await context.workspaceState.update("hideReviewed", false);
      setContexts();
      provider.rebuild();
    }),

    // notes (comment widget passes CommentReply / CommentThread / Comment; tree passes note nodes)
    vscode.commands.registerCommand("branchReview.note.create", (reply) =>
      notes.create(reply),
    ),
    vscode.commands.registerCommand("branchReview.note.reply", (reply) =>
      notes.reply(reply),
    ),
    vscode.commands.registerCommand("branchReview.note.edit", (comment) =>
      notes.edit(comment),
    ),
    vscode.commands.registerCommand("branchReview.note.save", (comment) =>
      notes.save(comment),
    ),
    vscode.commands.registerCommand("branchReview.note.cancelEdit", (comment) =>
      notes.cancelEdit(comment),
    ),
    vscode.commands.registerCommand(
      "branchReview.note.deleteComment",
      (comment) => notes.deleteComment(comment),
    ),
    vscode.commands.registerCommand("branchReview.note.delete", (x) =>
      notes.deleteNote(toRecord(x)),
    ),
    vscode.commands.registerCommand("branchReview.note.resolve", (x) =>
      notes.setResolved(toRecord(x), true),
    ),
    vscode.commands.registerCommand("branchReview.note.unresolve", (x) =>
      notes.setResolved(toRecord(x), false),
    ),
    vscode.commands.registerCommand(
      "branchReview.note.reveal",
      async (node) => {
        const record = node.record;
        const selection = notes.rangeOf(record);
        const f = node.fileNode;
        if (f && ["M", "R", "C"].includes(f.change.status))
          await openChanges(f, { selection });
        else
          await vscode.commands.executeCommand(
            "vscode.open",
            notes.uriOf(record),
            { selection },
          );
        notes.expand(record);
      },
    ),
  );

  provider.refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
