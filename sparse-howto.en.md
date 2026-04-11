# Sparse File Update with isomorphic-git

## Background

This project needs to read & update a single file in a Git repository from a Cloudflare Worker.

That environment has two important limits:

- there is no local filesystem in the usual sense
- there is no `git` CLI

Because of that, the implementation uses `isomorphic-git`, `isomorphic-git/http/web`, and `memfs` to do everything in pure JavaScript.

The goal is not a full clone. The worker should fetch only the latest repository state, read one target file, append new content, create a commit, and push it back.

## Main Challenges

The first challenge is avoiding a normal clone. A regular clone brings in the whole repository state, which is unnecessary for this use case. The final code solves this by initializing an empty repository in memory and fetching only the latest commit with shallow fetch settings.

The second challenge is file lookup inside Git trees. `git.readTree` only reads one tree object at a time, so a nested path such as `subdir/test.txt` cannot be resolved in one step. The implementation therefore walks the path segment by segment until it reaches the target blob.

The third challenge is writing the updated repository tree correctly. Git trees are hierarchical, so updating a file inside a subdirectory means rebuilding every tree node along that path. The final implementation updates only the affected branch of the tree instead of rebuilding the entire repository tree.

## Final Implementation

The final solution is centered around four pieces:

### 1. Initialize an in-memory repository and fetch the latest commit

`initAndFetch()` creates a Git repository inside `memfs`, adds `origin`, and runs a shallow fetch:

- `depth: 1`
- `singleBranch: true`
- `tags: false`

This gives the worker enough information to read the current HEAD and create a new commit, without doing a full clone.

### 2. Resolve the target file by path

`resolvePathToOid(treeOid, filepath)` starts from the commit's root tree and walks through each path segment. For example, for `foo/bar.jsonl`, it reads:

1. the root tree
2. the `foo` subtree
3. the `bar.jsonl` blob

If the file already exists, the function returns its blob OID. If not, it returns `null`.

### 3. Write the new blob and rebuild only the necessary tree path

After reading the existing file content, the worker appends the new content and stores it with `git.writeBlob()`.

Then `updateTreeRecursively(treeOid, pathParts, newBlobOid)` rebuilds only the tree nodes on the target path:

- if the current level is the file itself, it replaces or inserts the blob entry
- if the current level is a directory, it recursively updates the child subtree
- each level writes a new tree object with `git.writeTree()`

This preserves every unrelated file in the repository while updating only the requested path.

### 4. Create and push the commit

Once the new root tree is ready, the worker creates a commit with:

- the new tree OID
- the previous HEAD as parent
- author and message derived from the request

Finally, it pushes the commit back to `origin`.

## How It Is Used in This Project

In [`src/index.js`](/Users/me/edev/req4cmt/src/index.js), the Worker exposes two main behaviors:

- `GET /something.jsonl` reads a single file from the remote repository and returns its content
- `POST /something` appends a JSON line to `something.jsonl`, commits the change, and pushes it

The sparse Git logic is shared by:

- `getFileContent()`, which reads one file from the latest commit
- `append_line()`, which updates one file and creates a commit

[`src/sparse-demo.js`](/Users/me/edev/req4cmt/src/sparse-demo.js) contains a smaller standalone version of the same idea for local testing and verification.

## Result

The final implementation behaves like a practical sparse update workflow:

- fetch the latest repository snapshot
- resolve one target file
- update only that file's blob and its ancestor trees
- commit and push the result

This is a good fit for Cloudflare Workers because it avoids a full clone, does not rely on shell access, and works entirely with JavaScript Git primitives.
