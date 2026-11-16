const vscode = require("vscode");
const path = require("path");
const {
  resolveMergeBase,
  getChanges,
  showFile,
  listBranches,
} = require("./git");

const VIEW_ID = "branchReview.changes";
const CONTENT_SCHEME = "branch-review"; // read-only base-version documents
const ITEM_SCHEME = "branch-review-item"; // tree item URIs, used for icons and decorations only

const STATUS = {
  M: { label: "Modified", color: "gitDecoration.modifiedResourceForeground" },
  A: { label: "Added", color: "gitDecoration.addedResourceForeground" },
  U: { label: "Untracked", color: "gitDecoration.untrackedResourceForeground" },
  D: { label: "Deleted", color: "gitDecoration.deletedResourceForeground" },
  R: { label: "Renamed", color: "gitDecoration.renamedResourceForeground" },
  C: { label: "Copied", color: "gitDecoration.addedResourceForeground" },
};

/** URI for the base version of a file. The file path stays in the URI so language detection works. */
function baseUri(state, relPath) {
  return vscode.Uri.joinPath(state.rootUri, relPath).with({
    scheme: CONTENT_SCHEME,
    query: JSON.stringify({
      cwd: state.root,
      ref: state.base.sha,
      path: relPath,
    }),
  });
}

function workingUri(state, relPath) {
  return vscode.Uri.joinPath(state.rootUri, relPath);
}

class ReviewProvider {
  constructor(context, gitApi) {
    this.context = context;
    this.gitApi = gitApi;
    this.states = []; // one per repository
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this._running = false;
    this._pending = false;
    this._timer = undefined;
  }

  get baseBranch() {
    return (
      this.context.workspaceState.get("baseBranch") ||
      vscode.workspace.getConfiguration("branchReview").get("baseBranch") ||
      "develop"
    );
  }

  get viewAsTree() {
    return this.context.globalState.get("viewAsTree", true);
  }

  scheduleRefresh(delay = 400) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    if (this._running) {
      this._pending = true;
      return;
    }
    this._running = true;
    try {
      const branch = this.baseBranch;
      const repos = [...this.gitApi.repositories].sort((a, b) =>
        a.rootUri.fsPath.localeCompare(b.rootUri.fsPath),
      );
      this.states = await Promise.all(
        repos.map((repo) => this._loadRepo(repo, branch)),
      );
    } finally {
      this._running = false;
    }
    this._onDidChange.fire();
    this._updateView();
    if (this._pending) {
      this._pending = false;
      this.scheduleRefresh(0);
    }
  }

  async _loadRepo(repo, branch) {
    const root = repo.rootUri.fsPath;
    const state = {
      root,
      rootUri: repo.rootUri,
      name: path.basename(root),
      base: null,
      changes: [],
      error: null,
    };
    try {
      state.base = await resolveMergeBase(root, branch);
      if (!state.base) {
        state.error = `Base branch '${branch}' not found`;
        return state;
      }
      state.changes = await getChanges(root, state.base.sha);
      state.nodes = this._buildNodes(state);
    } catch (e) {
      state.error = e.message;
    }
    return state;
  }

  _buildNodes(state) {
    const files = state.changes.map((change) => ({
      kind: "file",
      state,
      change,
    }));
    if (!this.viewAsTree) return files;

    const root = { children: new Map() };
    for (const f of files) {
      const segments = f.change.path.split("/");
      let dir = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (!dir.children.has(seg)) {
          dir.children.set(seg, {
            kind: "folder",
            state,
            name: seg,
            relPath: segments.slice(0, i + 1).join("/"),
            children: new Map(),
          });
        }
        dir = dir.children.get(seg);
      }
      dir.children.set(segments[segments.length - 1] + "\0file", f);
    }

    // Folders first, then files, alphabetical. Merge single-child folder chains (a/b/c) like the SCM view does.
    const finish = (dir) => {
      const kids = [...dir.children.values()];
      for (const k of kids) {
        if (k.kind !== "folder") continue;
        while (k.children.size === 1) {
          const only = [...k.children.values()][0];
          if (only.kind !== "folder") break;
          k.name = `${k.name}/${only.name}`;
          k.relPath = only.relPath;
          k.children = only.children;
        }
        k.children = finish(k);
      }
      return kids.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        const an =
          a.kind === "folder" ? a.name : path.posix.basename(a.change.path);
        const bn =
          b.kind === "folder" ? b.name : path.posix.basename(b.change.path);
        return an.localeCompare(bn);
      });
    };
    return finish(root);
  }

  _updateView() {
    const view = this.treeView;
    if (!view) return;
    const total = this.states.reduce((n, s) => n + s.changes.length, 0);
    view.badge = total
      ? { value: total, tooltip: `${total} files changed since branching` }
      : undefined;

    if (!this.states.length) {
      view.message = "No git repository found in this workspace.";
      view.description = undefined;
    } else if (this.states.length === 1) {
      const s = this.states[0];
      view.message = s.error
        ? s.error
        : s.changes.length
          ? undefined
          : `No changes vs ${s.base.ref}.`;
      view.description = s.base
        ? `vs ${s.base.ref} @ ${s.base.sha.slice(0, 7)}`
        : undefined;
    } else {
      view.message = undefined;
      view.description = `vs ${this.baseBranch}`;
    }
  }

  getChildren(node) {
    if (!node) {
      if (this.states.length === 1) return this.states[0].nodes || [];
      return this.states.map((state) => ({ kind: "repo", state }));
    }
    if (node.kind === "repo") return node.state.nodes || [];
    if (node.kind === "folder") return node.children;
    return [];
  }

  getTreeItem(node) {
    if (node.kind === "repo") {
      const s = node.state;
      const item = new vscode.TreeItem(
        s.name,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("repo");
      item.description = s.error
        ? s.error
        : `vs ${s.base.ref} @ ${s.base.sha.slice(0, 7)} · ${s.changes.length} files`;
      item.tooltip = s.root;
      return item;
    }

    if (node.kind === "folder") {
      const item = new vscode.TreeItem(
        node.name,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.resourceUri = vscode.Uri.joinPath(
        node.state.rootUri,
        node.relPath,
      ).with({ scheme: ITEM_SCHEME });
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "folder";
      return item;
    }

    const { change, state } = node;
    const name = path.posix.basename(change.path);
    const dir = path.posix.dirname(change.path);
    const item = new vscode.TreeItem(
      name,
      vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = vscode.Uri.joinPath(state.rootUri, change.path).with({
      scheme: ITEM_SCHEME,
      query: change.status,
    });
    item.iconPath = vscode.ThemeIcon.File;
    const desc = [];
    if (!this.viewAsTree && dir !== ".") desc.push(dir);
    if (change.oldPath && change.oldPath !== change.path)
      desc.push(`← ${change.oldPath}`);
    item.description = desc.join("  ");
    item.tooltip = `${change.path} · ${STATUS[change.status]?.label ?? change.status}`;
    item.contextValue = `file-${change.status}`;
    item.command = {
      command: "branchReview.openChanges",
      title: "Open Changes",
      arguments: [node],
    };
    return item;
  }
}

class BaseContentProvider {
  async provideTextDocumentContent(uri) {
    const { cwd, ref, path: relPath } = JSON.parse(uri.query);
    return showFile(cwd, ref, relPath);
  }
}

class StatusDecorationProvider {
  provideFileDecoration(uri) {
    if (uri.scheme !== ITEM_SCHEME || !uri.query) return undefined;
    const s = STATUS[uri.query];
    if (!s) return undefined;
    return new vscode.FileDecoration(
      uri.query,
      s.label,
      new vscode.ThemeColor(s.color),
    );
  }
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

async function openAllChanges(provider) {
  const resources = [];
  for (const state of provider.states) {
    if (!state.base) continue;
    for (const c of state.changes) {
      const right = workingUri(state, c.path);
      if (c.status === "A" || c.status === "U")
        resources.push([right, undefined, right]);
      else if (c.status === "D")
        resources.push([right, baseUri(state, c.path), undefined]);
      else resources.push([right, baseUri(state, c.oldPath || c.path), right]);
    }
  }
  if (!resources.length) {
    vscode.window.showInformationMessage("Branch Review: no changes to show.");
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.changes",
    `Branch Review vs ${provider.baseBranch}`,
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

  const provider = new ReviewProvider(context, gitApi);
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.treeView = treeView;

  const setTreeContext = () =>
    vscode.commands.executeCommand(
      "setContext",
      "branchReview.viewAsTree",
      provider.viewAsTree,
    );
  setTreeContext();

  // Refresh whenever any repository's state changes (HEAD moves, working tree edits, commits, etc.)
  const repoSubs = new Map();
  const watchRepo = (repo) => {
    if (repoSubs.has(repo)) return;
    repoSubs.set(
      repo,
      repo.state.onDidChange(() => provider.scheduleRefresh()),
    );
  };
  gitApi.repositories.forEach(watchRepo);

  context.subscriptions.push(
    treeView,
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
    { dispose: () => repoSubs.forEach((d) => d.dispose()) },

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
      openAllChanges(provider),
    ),
    vscode.commands.registerCommand("branchReview.setBaseBranch", () =>
      setBaseBranch(provider, context),
    ),
    vscode.commands.registerCommand("branchReview.viewAsTree", async () => {
      await context.globalState.update("viewAsTree", true);
      setTreeContext();
      provider.refresh();
    }),
    vscode.commands.registerCommand("branchReview.viewAsList", async () => {
      await context.globalState.update("viewAsTree", false);
      setTreeContext();
      provider.refresh();
    }),
  );

  provider.refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
