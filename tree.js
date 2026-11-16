const vscode = require("vscode");
const path = require("path");
const { resolveMergeBase, getChanges, showFile } = require("./git");
const { fingerprint } = require("./reviewed");

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

/** The URI an editor shows for this change: the working file, or the base version for deletions. */
function editorUri(state, change) {
  return change.status === "D"
    ? baseUri(state, change.path)
    : workingUri(state, change.path);
}

class ReviewProvider {
  constructor(context, gitApi, reviewed) {
    this.context = context;
    this.gitApi = gitApi;
    this.reviewed = reviewed;
    this.notes = undefined; // set after construction (NotesController needs a provider-backed locate fn)
    this.states = []; // one per repository
    this.byEditorUri = new Map(); // editor uri string -> { state, change }
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

  get hideReviewed() {
    return this.context.workspaceState.get("hideReviewed", false);
  }

  isReviewed(state, change) {
    const mark = this.reviewed.get(state.root, change.path);
    return mark !== undefined && mark === state.fingerprints.get(change.path);
  }

  scheduleRefresh(delay = 400) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), delay);
  }

  /** Re-run git and re-hash files, then rebuild the tree. */
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
    this.rebuild();
    if (this._pending) {
      this._pending = false;
      this.scheduleRefresh(0);
    }
  }

  /** Rebuild the tree from already-loaded git data (after marks, notes or view options change). */
  rebuild() {
    this.byEditorUri.clear();
    for (const s of this.states) {
      s.nodes = s.base ? this._buildNodes(s) : [];
      for (const change of s.changes)
        this.byEditorUri.set(editorUri(s, change).toString(), {
          state: s,
          change,
        });
    }
    this._updateView();
    this._updateContextKeys();
    this._onDidChange.fire();
  }

  async _loadRepo(repo, branch) {
    const root = repo.rootUri.fsPath;
    const state = {
      root,
      rootUri: repo.rootUri,
      name: path.basename(root),
      base: null,
      changes: [],
      fingerprints: new Map(),
      error: null,
    };
    try {
      state.base = await resolveMergeBase(root, branch);
      if (!state.base) {
        state.error = `Base branch '${branch}' not found`;
        return state;
      }
      state.changes = await getChanges(root, state.base.sha);
      await Promise.all(
        state.changes.map(async (c) =>
          state.fingerprints.set(
            c.path,
            await fingerprint(workingUri(state, c.path).fsPath, c.status),
          ),
        ),
      );
    } catch (e) {
      state.error = e.message;
    }
    return state;
  }

  /** Re-hash a single file now, so a mark made straight after saving uses the saved content. */
  async refreshFingerprint(state, change) {
    const fp = await fingerprint(
      workingUri(state, change.path).fsPath,
      change.status,
    );
    state.fingerprints.set(change.path, fp);
    return fp;
  }

  _buildNodes(state) {
    let changes = state.changes;
    if (this.hideReviewed)
      changes = changes.filter((c) => !this.isReviewed(state, c));
    const files = changes.map((change) => ({ kind: "file", state, change }));

    const extra = [];
    const changed = new Set(state.changes.map((c) => c.path));
    const otherNotes =
      this.notes?.forRepo(state.root).filter((r) => !changed.has(r.path)) ?? [];
    if (otherNotes.length)
      extra.push({ kind: "otherNotes", state, records: otherNotes });

    if (!this.viewAsTree) return [...files, ...extra];

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
    return [...finish(root), ...extra];
  }

  /** All file nodes under a folder node. */
  filesUnder(node) {
    if (node.kind === "file") return [node];
    if (node.kind !== "folder") return [];
    return node.children.flatMap((c) => this.filesUnder(c));
  }

  _counts() {
    let total = 0;
    let reviewed = 0;
    for (const s of this.states) {
      for (const c of s.changes) {
        total++;
        if (this.isReviewed(s, c)) reviewed++;
      }
    }
    return { total, reviewed };
  }

  _updateView() {
    const view = this.treeView;
    if (!view) return;
    const { total, reviewed } = this._counts();
    const left = total - reviewed;
    view.badge = left
      ? {
          value: left,
          tooltip: `${left} of ${total} changed files left to review`,
        }
      : undefined;
    const progress = total ? ` · ${reviewed}/${total} reviewed` : "";

    if (!this.states.length) {
      view.message = "No git repository found in this workspace.";
      view.description = undefined;
    } else if (this.states.length === 1) {
      const s = this.states[0];
      if (s.error) view.message = s.error;
      else if (!s.changes.length) view.message = `No changes vs ${s.base.ref}.`;
      else if (this.hideReviewed && !left)
        view.message = `All ${total} files reviewed (reviewed files are hidden).`;
      else view.message = undefined;
      view.description = s.base
        ? `vs ${s.base.ref} @ ${s.base.sha.slice(0, 7)}${progress}`
        : undefined;
    } else {
      view.message = undefined;
      view.description = `vs ${this.baseBranch}${progress}`;
    }
  }

  /** Lets editor title buttons know whether the open file is part of the review, and its reviewed state. */
  _updateContextKeys() {
    const reviewed = [];
    const unreviewed = [];
    for (const [uri, { state, change }] of this.byEditorUri) {
      (this.isReviewed(state, change) ? reviewed : unreviewed).push(uri);
    }
    vscode.commands.executeCommand(
      "setContext",
      "branchReview.reviewedFiles",
      reviewed,
    );
    vscode.commands.executeCommand(
      "setContext",
      "branchReview.unreviewedFiles",
      unreviewed,
    );
  }

  getChildren(node) {
    if (!node) {
      if (this.states.length === 1) return this.states[0].nodes || [];
      return this.states.map((state) => ({ kind: "repo", state }));
    }
    switch (node.kind) {
      case "repo":
        return node.state.nodes || [];
      case "folder":
        return node.children;
      case "file":
        return (
          this.notes?.forFile(node.state.root, node.change.path) ?? []
        ).map((record) => ({
          kind: "note",
          state: node.state,
          record,
          fileNode: node,
        }));
      case "otherNotes":
        return [...node.records]
          .sort(
            (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine,
          )
          .map((record) => ({
            kind: "note",
            state: node.state,
            record,
            showPath: true,
          }));
      default:
        return [];
    }
  }

  getTreeItem(node) {
    switch (node.kind) {
      case "repo":
        return this._repoItem(node);
      case "folder":
        return this._folderItem(node);
      case "file":
        return this._fileItem(node);
      case "note":
        return this._noteItem(node);
      case "otherNotes": {
        const item = new vscode.TreeItem(
          "Notes on other files",
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.description = `${node.records.length}`;
        item.tooltip = "Review notes on files that are not in the changed list";
        return item;
      }
    }
  }

  _repoItem(node) {
    const s = node.state;
    const item = new vscode.TreeItem(
      s.name,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = new vscode.ThemeIcon("repo");
    if (s.error) item.description = s.error;
    else {
      const done = s.changes.filter((c) => this.isReviewed(s, c)).length;
      item.description = `vs ${s.base.ref} @ ${s.base.sha.slice(0, 7)} · ${done}/${s.changes.length} reviewed`;
    }
    item.tooltip = s.root;
    return item;
  }

  _folderItem(node) {
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
    const files = this.filesUnder(node);
    const allReviewed =
      files.length > 0 &&
      files.every((f) => this.isReviewed(f.state, f.change));
    item.checkboxState = {
      state: allReviewed
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: allReviewed
        ? "Mark folder as unreviewed"
        : "Mark everything in this folder as reviewed",
    };
    return item;
  }

  _fileItem(node) {
    const { change, state } = node;
    const reviewed = this.isReviewed(state, change);
    const noteCount = this.notes?.forFile(state.root, change.path).length ?? 0;
    const name = path.posix.basename(change.path);
    const dir = path.posix.dirname(change.path);

    const item = new vscode.TreeItem(
      name,
      noteCount
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = vscode.Uri.joinPath(state.rootUri, change.path).with({
      scheme: ITEM_SCHEME,
      query: reviewed ? `${change.status};reviewed` : change.status,
    });
    item.iconPath = vscode.ThemeIcon.File;
    const desc = [];
    if (!this.viewAsTree && dir !== ".") desc.push(dir);
    if (change.oldPath && change.oldPath !== change.path)
      desc.push(`← ${change.oldPath}`);
    item.description = desc.join("  ");
    item.tooltip = `${change.path} · ${STATUS[change.status]?.label ?? change.status}${reviewed ? " · reviewed" : ""}`;
    item.contextValue = `file-${change.status}-${reviewed ? "reviewed" : "unreviewed"}`;
    item.checkboxState = {
      state: reviewed
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: reviewed ? "Mark as unreviewed" : "Mark as reviewed",
    };
    item.command = {
      command: "branchReview.openChanges",
      title: "Open Changes",
      arguments: [node],
    };
    return item;
  }

  _noteItem(node) {
    const r = node.record;
    const first =
      (r.comments[0]?.body ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
    const label =
      first.length > 80 ? first.slice(0, 79) + "…" : first || "(empty note)";
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
    );
    const lines =
      r.startLine === r.endLine
        ? `L${r.startLine + 1}`
        : `L${r.startLine + 1}-${r.endLine + 1}`;
    const bits = [node.showPath ? `${r.path}:${lines}` : lines];
    if (r.comments.length > 1) bits.push(`${r.comments.length - 1} more`);
    if (r.resolved) bits.push("resolved");
    item.description = bits.join(" · ");
    item.tooltip = new vscode.MarkdownString(
      r.comments.map((c) => c.body).join("\n\n---\n\n"),
    );
    item.iconPath = r.resolved
      ? new vscode.ThemeIcon(
          "pass",
          new vscode.ThemeColor("testing.iconPassed"),
        )
      : new vscode.ThemeIcon("comment");
    item.contextValue = r.resolved ? "note-resolved" : "note-unresolved";
    item.command = {
      command: "branchReview.note.reveal",
      title: "Go to Note",
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
    const [status, reviewed] = uri.query.split(";");
    const s = STATUS[status];
    if (!s) return undefined;
    if (reviewed) {
      return new vscode.FileDecoration(
        status,
        `${s.label} · reviewed`,
        new vscode.ThemeColor("disabledForeground"),
      );
    }
    return new vscode.FileDecoration(
      status,
      s.label,
      new vscode.ThemeColor(s.color),
    );
  }
}

module.exports = {
  ReviewProvider,
  BaseContentProvider,
  StatusDecorationProvider,
  baseUri,
  workingUri,
  CONTENT_SCHEME,
};
