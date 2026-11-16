# Branch Review

A local VS Code extension. It adds a **Branch Review** view to the activity bar that lists every file changed since your branch left `develop`. That covers committed, staged, unstaged and untracked changes.

- Click a modified or renamed file to open a side-by-side diff. The left side is the file as it was at the branch point (read-only). The right side is your real file in the normal editor, so editing, IntelliSense, go-to-definition, references and refactors all work.
- Added or untracked files open normally. Deleted files show their base version.
- **Open All Unreviewed Changes** (the compare icon in the view title) opens every unreviewed file in one scrollable multi-diff editor. The right-hand sides are editable there too. The `…` menu has an option that includes reviewed files.
- The list refreshes when files change, and when you commit, check out a branch or pull.

## Reviewed files

- Tick a file's checkbox, or use **Mark as Reviewed** (✓) in the editor title bar while viewing it. Ticking a folder marks everything in it.
- A mark remembers the file's content. If the file changes afterwards, including your own edits, it shows as unreviewed again.
- The badge counts files left to review, and the view header shows `n/total reviewed`.
- The eye icon hides reviewed files. **Clear All Reviewed Marks** is in the `…` menu.
- **Branch Review: Toggle Reviewed (Active File)** is in the command palette, ready to bind to a key.

## Review notes

- Hover the gutter of any file in the repo and click **+** to add a note. It uses VS Code's comments UI, so notes show inline in normal editors and diff editors, and in the built-in Comments panel.
- Notes appear in the tree under their file. Notes on files that aren't in the changed list appear under **Notes on other files**. Click one to jump to it.
- You can reply, edit, resolve/reopen and delete notes, from the note itself or from the tree.
- Notes move with the code as you insert or delete lines in VS Code, and follow file renames made in VS Code. Changes made outside VS Code, such as `git checkout`, can leave them on the wrong line.
- Notes and marks are stored in VS Code's per-workspace storage. They aren't written to the repo and aren't sent anywhere.

## How the base is chosen

The base is `git merge-base HEAD develop`. If `origin/develop` exists and its merge-base is more recent, that one is used instead, so a stale local `develop` doesn't add extra files. If you merge develop into your branch, the merge-base moves forward and develop's changes drop out of the list, the same way a PR diff behaves.

To use a different branch, change the `branchReview.baseBranch` setting, or use **Set Base Branch…** in the `…` menu to override it for the current workspace.

### Full-width new files in Open All Changes

The multi-diff editor shows new files next to an empty left pane. Adding `"diffEditor.compactMode": true` to your settings makes files with only additions (or only deletions) render as one full-width editor. This setting is undocumented and affects every diff editor in VS Code.

## Install / update

```sh
npx @vscode/vsce package --skip-license --allow-missing-repository
code --install-extension branch-review-0.2.0.vsix --force
```

Then reload VS Code (**Developer: Reload Window**).

## Develop

Open this folder in VS Code and press F5 to launch an Extension Development Host. Plain JavaScript, no build step, no dependencies.
