# 用 isomorphic-git 实现 Sparse Checkout 的踩坑记录

## 起因

最近有个需求：要在 Cloudflare Worker 里实现 Git 操作，但有个限制 - 不能 clone 整个仓库，只能 checkout 单个文件，修改后提交。Cloudflare Worker 没有文件系统，也不能用 git 命令，所以必须用纯 JS 的 isomorphic-git 库。

听起来挺简单的对吧？结果踩了一堆坑，记录一下整个过程。

## 第一版：直接用 clone

一开始我想着，isomorphic-git 应该有 clone 功能，直接 clone 不就行了？于是写了第一版代码：

```javascript
await git.clone({
  fs, dir, url: GIT_URL, depth: 1, singleBranch: true
});
```

但很快我就意识到，clone 还是会下载整个仓库的历史和对象，只是工作目录只显示部分文件。这不符合"避免 clone 整个 repo"的需求。

## 第二版：init + fetch

那就不用 clone 了，用 init + fetch：

```javascript
await git.init({ fs, dir, defaultBranch: "main" });
await git.addRemote({ fs, dir, url: GIT_URL, remote: "origin" });
await git.fetch({
  fs, http, dir, url: GIT_URL, depth: 1, singleBranch: true, tags: false
});
```

这样只 fetch 最新的 commit，应该就够了吧？

## 第一个坑：hashObject 不存在

写完代码一跑，报错："git.hashObject is not a function"。

我一开始还自己撸了个 SHA-1 实现，但翻了文档，发现应该用 `git.writeBlob`：

```javascript
const newBlobOid = await git.writeBlob({
  fs, dir, blob: new TextEncoder().encode(content)
});
```

## 第二个坑：const 不能修改

接着又报错："TypeError: Assignment to constant variable"。

原来是有些变量用 const 声明了，后面又要修改。改成 let 就好了。

## 第三个坑：找不到 master 分支

又报错："NotFoundError: Could not find master"。

现在 Git 默认分支是 main，不是 master了。改成 `defaultBranch: "main"` 就好了。

## 最纠结的坑：文件覆盖问题

这个坑最折磨人，反复改了好几个方案才解决。

### 问题现象

最初实现的时候，每次提交后，仓库里就只剩下修改的那一个文件，其他文件全没了！

比如仓库里有：
- test.txt
- other.txt
- subdir/test.txt

修改 test.txt 后提交，仓库里就只剩 test.txt 了，other.txt 和 subdir/test.txt 全部消失。

### 第一次尝试：只传修改的文件

```javascript
const newTreeSha = await git.writeTree({
  fs,
  dir,
  tree: [{ path: "test.txt", oid: newBlobOid, mode: "100644", type: "blob" }]
});
```

结果可想而知，tree 里只有一个 entry，其他文件全丢了。

### 第二次尝试：读取原 tree，合并 entries

```javascript
const oldTree = await git.readTree({ fs, dir, oid: commit.commit.tree });
const newTreeSha = await git.writeTree({
  fs,
  dir,
  tree: [...oldTree.tree, { path: "test.txt", oid: newBlobOid, mode: "100644", type: "blob" }]
});
```

这个方案看起来合理，但有个问题：如果文件已经存在，会有重复的 entry！而且没法直接替换，只能追加。

### 第三次尝试：先删除旧的，再添加新的

```javascript
const oldTree = await git.readTree({ fs, dir, oid: commit.commit.tree });
const filteredEntries = oldTree.tree.filter(e => e.path !== "test.txt");
const newTreeSha = await git.writeTree({
  fs,
  dir,
  tree: [...filteredEntries, { path: "test.txt", oid: newBlobOid, mode: "100644", type: "blob" }]
});
```

这个方案对根目录文件有效，但子目录文件还是不行！因为 `git.readTree` 只能读根目录，`subdir/test.txt` 的 entry 在根目录的 tree 里是 `subdir` 这个 tree entry，不是文件本身。

### 第四次尝试：递归读取整个 tree

既然子目录的问题，那就递归读取整个 tree，把所有文件都找出来：

```javascript
async function readTreeRecursively(treeOid, prefix = "") {
  const tree = await git.readTree({ fs, dir, oid: treeOid });
  const entries = [];

  for (const entry of tree.tree) {
    const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === "tree") {
      const subEntries = await readTreeRecursively(entry.oid, fullPath);
      entries.push(...subEntries);
    } else {
      entries.push({ path: fullPath, oid: entry.oid, mode: entry.mode });
    }
  }

  return entries;
}

// 使用
const allEntries = await readTreeRecursively(commit.commit.tree);
const filteredEntries = allEntries.filter(e => e.path !== "test.txt");
const newTreeSha = await git.writeTree({
  fs,
  dir,
  tree: [...filteredEntries, { path: "test.txt", oid: newBlobOid, mode: "100644", type: "blob" }]
});
```

这个方案能找到所有文件，包括子目录的。但是！`git.writeTree` 不接受带斜杠的路径，报错："The filepath 'subdir/test.txt' contains unsafe character sequences"。

### 第五次尝试：构建嵌套的 tree

既然 `git.writeTree` 不接受带斜杠的路径，那就构建嵌套的 tree 结构：

```javascript
async function buildNestedTree(files) {
  const root = {};

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }

    const filename = parts[parts.length - 1];
    current[filename] = { oid: file.oid, mode: file.mode };
  }

  async function writeTreeFromNode(node) {
    const entries = [];

    for (const [name, value] of Object.entries(node)) {
      if (value.oid) {
        entries.push({ path: name, oid: value.oid, mode: value.mode, type: "blob" });
      } else {
        const subtreeOid = await writeTreeFromNode(value);
        entries.push({ path: name, oid: subtreeOid, mode: "40000", type: "tree" });
      }
    }

    if (entries.length === 0) {
      return null;
    }

    return await git.writeTree({ fs, dir, tree: entries });
  }

  return await writeTreeFromNode(root);
}

// 使用
const allEntries = await readTreeRecursively(commit.commit.tree);
const filteredEntries = allEntries.filter(e => e.path !== "test.txt");
const newTreeSha = await buildNestedTree([
  ...filteredEntries,
  { path: "test.txt", oid: newBlobOid, mode: "100644" }
]);
```

这个方案终于成功了！但有个问题：每次都要递归读取整个 tree，然后重建整个 tree，效率太低了。特别是大仓库，会很慢。

### 第六次尝试：只更新必要的部分

能不能不读取整个 tree，只更新需要修改的部分？

```javascript
async function resolvePathToOid(treeOid, filepath) {
  const parts = filepath.split('/').filter(Boolean);
  let currentOid = treeOid;

  for (const part of parts) {
    const tree = await git.readTree({ fs, dir, oid: currentOid });
    const entry = tree.tree.find(e => e.path === part);
    if (!entry) return null;
    currentOid = entry.oid;
  }
  return currentOid;
}

async function updateTreeRecursively(treeOid, pathParts, newBlobOid) {
  const [currentPart, ...remainingParts] = pathParts;
  const tree = treeOid ? (await git.readTree({ fs, dir, oid: treeOid })).tree : [];

  let newEntries = [...tree];
  let targetEntryIndex = newEntries.findIndex(e => e.path === currentPart);

  if (remainingParts.length === 0) {
    const newEntry = { path: currentPart, oid: newBlobOid, mode: "100644", type: "blob" };
    if (targetEntryIndex >= 0) {
      newEntries[targetEntryIndex] = newEntry;
    } else {
      newEntries.push(newEntry);
    }
  } else {
    const subTreeOid = targetEntryIndex >= 0 ? newEntries[targetEntryIndex].oid : null;
    const newSubTreeOid = await updateTreeRecursively(subTreeOid, remainingParts, newBlobOid);
    const newEntry = { path: currentPart, oid: newSubTreeOid, mode: "40000", type: "tree" };

    if (targetEntryIndex >= 0) {
      newEntries[targetEntryIndex] = newEntry;
    } else {
      newEntries.push(newEntry);
    }
  }

  return await git.writeTree({ fs, dir, tree: newEntries });
}

// 使用
const newTreeSha = await updateTreeRecursively(
  commit.commit.tree,
  "test.txt".split('/').filter(Boolean),
  newBlobOid
);
```

这个方案完美！只遍历必要的路径，只更新需要的部分，效率高多了。

### 其他失败的尝试

还尝试过一些其他方案：

1. **用 git.updateIndex**：想通过 index 来管理文件，但 isomorphic-git 不支持 `git.readIndex`，也没法清空 index。

2. **用 git.resetIndex**：想重置 index，但这个函数需要 filepath 参数，没法清空整个 index。

3. **手动管理 index 对象**：想自己构建 index 对象传给 `git.writeTree`，但 `git.writeTree` 不接受 index 参数。

4. **用 git.add**：想用 `git.add` 来添加文件，但 `git.add` 需要文件系统里的文件，而 memfs 里没有这个文件。

### 最终方案

最终采用的是第六次尝试的方案：
- `resolvePathToOid`：按路径查找文件的 OID
- `updateTreeRecursively`：递归更新树，只修改必要的部分

这个方案既正确又高效，完美解决了文件覆盖的问题。

## 简化代码测试

简化代码后，测试一下往 test.txt 里加一行 "updated8"。测试成功，看起来没问题了。

## 移植到 index.js

把 demo.js 的逻辑移植到 src/index.js，替换原来的 git_checkout，优化 GET/POST 处理。

## 第四个坑：硬编码分支

发现代码里硬编码了 `defaultBranch: "main"`，这样不好，因为有些仓库可能用其他分支名。移除这个参数，让 isomorphic-git 自己判断。

## 第五个坑：正则表达式变更

对比了一下，主要改动是：
- 提取路径的正则：`/\/([^\/]+)$/` 改成 `/\/([^\/]+)\/?$/`（处理结尾斜杠）
- 邮箱验证的正则：`/^[^@]+@[^@]+\.[^@]+$/`（更严格的邮箱格式）

这些改动是为了更健壮地处理各种输入。

## 第六个坑：子目录文件找不到

意识到一个关键问题：`git.readTree` 只能读取根目录的 tree，如果文件在子目录（比如 `foo/bar.jsonl`），会找不到。

测试了一下，确实有问题。于是实现了 `readTreeRecursively` 递归读取整个树结构，然后还需要 `buildNestedTree` 来构建嵌套的树结构，因为 Git 的 tree 是嵌套的，不能直接用平铺的路径。

## 第七个坑：仓库损坏了

测试的时候发现 repo 里居然有两个 test.txt！把什么东西搞坏了。

原因是 tree 构建不正确，导致文件重复。写了个 fix-repo.js 修复，用 Set 去重。

## 第八个坑：writeTree 的路径限制

继续测试，报错："The filepath 'subdir/test.txt' contains unsafe character sequences"。

这是因为 `git.writeTree` 不接受带斜杠的路径，必须构建嵌套的 tree。`buildNestedTree` 就是干这个的。

## 第九个坑：updateIndex 不支持

尝试用 `git.updateIndex` 来构建 index，结果发现 isomorphic-git 不支持 `git.readIndex`，也找不到 `git.resetIndex`。

算了，还是自己构建 tree 吧。

## 优化：更高效的实现

代码太庞大了，有没有更好的方法？特别是 isomorphic-git 里可能有现成的。

翻了文档，没找到现成的。但可以优化一下，不用每次都读取整个树。

于是实现了两个新函数：

1. `resolvePathToOid`：按路径查找文件的 OID，只遍历必要的路径
2. `updateTreeRecursively`：递归更新树，只修改必要的部分

这样效率高多了，不用每次都读取整个树结构。

## 最终测试

测试了三个场景：
1. 创建新文件 subdir/test2.txt
2. 追加内容到 subdir/test.txt
3. 创建新文件 other2.txt

每个操作都是独立的 commit，没动的文件保持原样。测试成功！

## 总结

整个过程踩了不少坑，但最终实现了目标：

1. **避免 clone 整个 repo**：用 `git.init + git.fetch(depth=1)` 只获取最新 commit
2. **处理子目录文件**：用 `resolvePathToOid` 递归查找文件
3. **构建正确的 Git tree**：用 `updateTreeRecursively` 递归更新树结构
4. **Cloudflare Worker 兼容**：用 memfs 模拟文件系统，用 isomorphic-git 的 HTTP 客户端

关键是要理解 Git 的底层模型 - tree 是嵌套的，不能直接用平铺的路径。isomorphic-git 提供了基本的 Git 操作，但高级功能需要自己实现。

代码已经放在 [sparse-demo.js](file:///Users/me/edev/req4cmt/src/sparse-demo.js) 和 [index.js](file:///Users/me/edev/req4cmt/src/index.js) 里，有详细的注释说明各个函数的作用和遇到的问题。

## 参考资料

- [isomorphic-git 文档](https://isomorphic-git.org/)
- [Git 内部原理 - Git 对象模型](https://git-scm.com/book/zh/v2/Git-%E5%86%85%E9%83%A8%E5%8E%9F%E7%90%86-Git-%E5%AF%B9%E8%B1%A1)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
