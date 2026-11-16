// Review notes, built on VS Code's Comments API so they show inline in real editors and diff editors.
// Notes are stored in workspaceState and never leave the machine.
const vscode = require("vscode");
const crypto = require("crypto");

const CONTROLLER_ID = "branchReview.notes";

class NoteComment {
  constructor(data, thread) {
    this.data = data; // { id, body, created } (persisted)
    this.parent = thread;
    this.id = data.id;
    this.body = new vscode.MarkdownString(data.body);
    this.mode = vscode.CommentMode.Preview;
    this.author = { name: "Review note" };
    this.timestamp = new Date(data.created);
    this.contextValue = "note";
  }
}

const bodyText = (body) => (typeof body === "string" ? body : body.value);

class NotesController {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {(uri: vscode.Uri) => {root: string, relPath: string} | undefined} locate maps a file URI to its repo
   * @param {() => void} onDidChange called whenever notes are added, edited, moved or removed
   */
  constructor(context, locate, onDidChange) {
    this.memento = context.workspaceState;
    this.locate = locate;
    this.onDidChange = onDidChange;
    /** @type {Array<{id: string, root: string, path: string, startLine: number, endLine: number, resolved: boolean, comments: Array<{id: string, body: string, created: number}>}>} */
    this.records = this.memento.get("notes", []);
    this.threadByRecord = new Map(); // record id -> CommentThread
    this.recordByThread = new WeakMap(); // CommentThread -> record

    this.controller = vscode.comments.createCommentController(
      CONTROLLER_ID,
      "Branch Review Notes",
    );
    this.controller.options = {
      prompt: "Add a review note…",
      placeHolder: "Review note (Markdown supported)",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        if (doc.uri.scheme !== "file" || !this.locate(doc.uri)) return [];
        return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)];
      },
    };

    for (const r of this.records) this._createThread(r);

    this._saveTimer = undefined;
    this.disposables = [
      this.controller,
      vscode.workspace.onDidChangeTextDocument((e) => this._trackEdits(e)),
      vscode.workspace.onDidRenameFiles((e) => this._trackRenames(e)),
    ];
  }

  dispose() {
    clearTimeout(this._saveTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- queries used by the tree ----

  forFile(root, relPath) {
    return this.records
      .filter((r) => r.root === root && r.path === relPath)
      .sort((a, b) => a.startLine - b.startLine);
  }

  forRepo(root) {
    return this.records.filter((r) => r.root === root);
  }

  uriOf(record) {
    return vscode.Uri.joinPath(vscode.Uri.file(record.root), record.path);
  }

  rangeOf(record) {
    return new vscode.Range(record.startLine, 0, record.endLine, 0);
  }

  // ---- command handlers ----

  /** First comment on a new thread (the user clicked "+" in the gutter and typed). */
  async create(reply) {
    const { thread, text } = reply;
    const loc = this.locate(thread.uri);
    if (!loc) {
      vscode.window.showWarningMessage(
        "Branch Review notes can only be added to files inside a git repository.",
      );
      thread.dispose();
      return;
    }
    const record = {
      id: crypto.randomUUID(),
      root: loc.root,
      path: loc.relPath,
      startLine: thread.range?.start.line ?? 0,
      endLine: thread.range?.end.line ?? 0,
      resolved: false,
      comments: [],
    };
    this.records.push(record);
    this._bind(thread, record);
    this._addComment(record, text);
  }

  async reply(reply) {
    const record = this.recordByThread.get(reply.thread);
    if (record) this._addComment(record, reply.text);
  }

  edit(comment) {
    const thread = comment.parent;
    thread.comments = thread.comments.map((c) => {
      if (c.id === comment.id) c.mode = vscode.CommentMode.Editing;
      return c;
    });
  }

  save(comment) {
    const thread = comment.parent;
    const record = this.recordByThread.get(thread);
    if (!record) return;
    const data = record.comments.find((c) => c.id === comment.id);
    if (data) data.body = bodyText(comment.body);
    this._render(record);
    this._persist();
  }

  cancelEdit(comment) {
    const record = this.recordByThread.get(comment.parent);
    if (record) this._render(record);
  }

  deleteComment(comment) {
    const record = this.recordByThread.get(comment.parent);
    if (!record) return;
    record.comments = record.comments.filter((c) => c.id !== comment.id);
    if (!record.comments.length) return this.deleteNote(record);
    this._render(record);
    this._persist();
  }

  /** @param {object} recordOrThread a record (from the tree) or a CommentThread (from the comment widget) */
  deleteNote(recordOrThread) {
    const record = this._toRecord(recordOrThread);
    if (!record) {
      recordOrThread?.dispose?.(); // empty draft thread
      return;
    }
    this.records = this.records.filter((r) => r !== record);
    this.threadByRecord.get(record.id)?.dispose();
    this.threadByRecord.delete(record.id);
    this._persist();
  }

  setResolved(recordOrThread, resolved) {
    const record = this._toRecord(recordOrThread);
    if (!record) return;
    record.resolved = resolved;
    const thread = this.threadByRecord.get(record.id);
    if (thread && resolved)
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this._render(record);
    this._persist();
  }

  expand(record) {
    const thread = this.threadByRecord.get(record.id);
    if (thread)
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  // ---- internals ----

  _toRecord(x) {
    if (!x) return undefined;
    if (this.records.includes(x)) return x;
    return this.recordByThread.get(x);
  }

  _createThread(record) {
    const thread = this.controller.createCommentThread(
      this.uriOf(record),
      this.rangeOf(record),
      [],
    );
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this._bind(thread, record);
    this._render(record);
  }

  _bind(thread, record) {
    thread.canReply = true;
    this.threadByRecord.set(record.id, thread);
    this.recordByThread.set(thread, record);
  }

  _addComment(record, text) {
    record.comments.push({
      id: crypto.randomUUID(),
      body: text,
      created: Date.now(),
    });
    this._render(record);
    this._persist();
  }

  /** Push the record's state into its CommentThread. */
  _render(record) {
    const thread = this.threadByRecord.get(record.id);
    if (!thread) return;
    thread.label = record.resolved ? "Review note (resolved)" : "Review note";
    thread.contextValue = record.resolved ? "resolved" : "unresolved";
    if (vscode.CommentThreadState) {
      thread.state = record.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    }
    thread.comments = record.comments.map((c) => new NoteComment(c, thread));
  }

  _persist(immediate = true) {
    clearTimeout(this._saveTimer);
    const write = () => this.memento.update("notes", this.records);
    if (immediate) write();
    else this._saveTimer = setTimeout(write, 500);
    this.onDidChange();
  }

  /** Keep notes attached to the same code as lines are inserted or removed above or inside them. */
  _trackEdits(e) {
    if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
    const loc = this.locate(e.document.uri);
    if (!loc) return;
    const records = this.forFile(loc.root, loc.relPath);
    if (!records.length) return;

    let moved = false;
    for (const change of e.contentChanges) {
      const removed = change.range.end.line - change.range.start.line;
      const added = (change.text.match(/\n/g) || []).length;
      const delta = added - removed;
      if (!delta) continue;
      const { start, end } = change.range;
      for (const r of records) {
        if (
          end.line < r.startLine ||
          (end.line === r.startLine && end.character === 0)
        ) {
          // Entirely above the note: shift it.
          r.startLine += delta;
          r.endLine += delta;
        } else if (start.line <= r.endLine) {
          // Overlaps the note: stretch/shrink it, and pull the start up if lines above it were deleted.
          r.startLine = Math.min(
            r.startLine,
            Math.max(start.line, r.startLine + delta),
          );
          r.endLine = Math.max(r.startLine, r.endLine + delta);
        } else {
          continue;
        }
        r.startLine = Math.max(0, r.startLine);
        r.endLine = Math.max(r.startLine, r.endLine);
        moved = true;
      }
    }
    if (!moved) return;
    for (const r of records) {
      const thread = this.threadByRecord.get(r.id);
      if (thread) thread.range = this.rangeOf(r);
    }
    this._persist(false);
  }

  _trackRenames(e) {
    let changed = false;
    for (const { oldUri, newUri } of e.files) {
      const from = this.locate(oldUri);
      const to = this.locate(newUri);
      if (!from || !to) continue;
      for (const r of this.records) {
        const isExact = r.root === from.root && r.path === from.relPath;
        const isInFolder =
          r.root === from.root && r.path.startsWith(from.relPath + "/");
        if (!isExact && !isInFolder) continue;
        r.root = to.root;
        r.path = isExact
          ? to.relPath
          : to.relPath + r.path.slice(from.relPath.length);
        // Comment threads can't change URI, so recreate them.
        this.threadByRecord.get(r.id)?.dispose();
        this._createThread(r);
        changed = true;
      }
    }
    if (changed) this._persist();
  }
}

module.exports = { NotesController, CONTROLLER_ID };
