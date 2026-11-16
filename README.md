# Branch Review

A local VS Code extension. It adds a **Branch Review** view to the activity bar that lists every file changed since your branch left `develop`. That covers committed, staged, unstaged and untracked changes.

- Click a modified or renamed file to open a side-by-side diff. The left side is the file as it was at the branch point (read-only). The right side is your real file in the normal editor, so editing, IntelliSense, go-to-definition, references and refactors all work.
- Added or untracked files open normally. Deleted files show their base version.
- **Open All Changes** (the compare icon in the view title) opens every file in one scrollable multi-diff editor. The right-hand sides are editable there too.
- The list refreshes when files change, and when you commit, check out a branch or pull.

## How the base is chosen

The base is `git merge-base HEAD develop`. If `origin/develop` exists and its merge-base is more recent, that one is used instead, so a stale local `develop` doesn't add extra files. If you merge develop into your branch, the merge-base moves forward and develop's changes drop out of the list, the same way a PR diff behaves.

To use a different branch, change the `branchReview.baseBranch` setting, or use the branch icon in the view title to override it for the current workspace.

## Install / update

```sh
npx @vscode/vsce package --skip-license --allow-missing-repository
code --install-extension branch-review-0.1.0.vsix --force
```

Then reload VS Code (**Developer: Reload Window**).

## Develop

Open this folder in VS Code and press F5 to launch an Extension Development Host. Plain JavaScript, no build step, no dependencies.
