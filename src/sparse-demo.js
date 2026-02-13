import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Volume } from 'memfs';

const fs = new Volume().promises;
const dir = "/tmp/repo";

const GIT_URL = "http://host/demo.git";

/**
 * Sparse Checkout 实现总结
 * 
 * 目标：只 checkout 单个文件，修改后提交，避免克隆整个仓库
 * 
 * 遇到的坑和解决思路：
 * 
 * 1. 初始问题：使用 git.clone 会克隆整个仓库
 *    - 失败：git.clone 会下载所有历史和文件
 *    - 解决：使用 git.init + git.fetch(depth=1) 只获取最新提交
 * 
 * 2. 读取文件问题：git.readTree 只读取根目录
 *    - 失败：直接在根目录 tree 中查找 "subdir/test.txt" 找不到
 *    - 失败思路：尝试使用 git.walk，但需要复杂的回调
 *    - 解决：实现 readTreeRecursively 递归读取整个树
 * 
 * 3. 构建树的问题：直接传入扁平列表报错 "unsafe character sequences"
 *    - 失败：git.writeTree({tree: [{path: "subdir/test.txt", ...}]})
 *      错误：The filepath "subdir/test.txt" contains unsafe character sequences
 *    - 失败思路2：使用 git.updateIndex + git.writeTree()
 *      问题：git.resetIndex 需要 filepath 参数，不能清空整个 index
 *      问题：git.writeTree() 不带参数会从 index 读取，但需要正确构建 index
 *    - 解决：实现 buildNestedTree 递归构建嵌套树结构
 *      先构建对象树，然后递归调用 git.writeTree
 * 
 * 4. 优化思路：避免读取整个树
 *    - 实现 resolvePathToOid：沿着路径查找文件 OID
 *    - 实现 updateTreeRecursively：递归更新树，只修改必要部分
 *    - 优点：不需要读取所有文件，只沿着路径操作
 */

async function initAndFetch() {
  await git.init({ fs, dir, defaultBranch: "main" });
  await git.addRemote({ fs, dir, url: GIT_URL, remote: "origin" });
  await git.fetch({
    fs,
    http,
    dir,
    url: GIT_URL,
    depth: 1,
    singleBranch: true,
    tags: false
  });
}

/**
 * 沿着路径查找文件的 OID
 * 
 * 为什么需要：git.readTree 只能读取单层树，需要递归查找
 * 
 * @param {string} treeOid - 树的 OID
 * @param {string} filepath - 文件路径，如 "subdir/test.txt"
 * @returns {Promise<string | null>} - 文件的 blob OID，如果不存在返回 null
 */
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

/**
 * 递归更新树结构
 * 
 * 为什么需要：Git 树是嵌套结构，不能直接用扁平列表更新
 * 
 * 失败的思路：
 * 1. 直接用 git.writeTree 传入扁平列表
 *    错误：The filepath "subdir/test.txt" contains unsafe character sequences
 * 2. 使用 git.updateIndex + git.writeTree()
 *    问题：git.resetIndex 需要 filepath，无法清空整个 index
 *    问题：git.writeTree() 不带参数从 index 读取，但 index 构建复杂
 * 
 * 正确做法：
 * - 递归遍历路径的每一层
 * - 在每一层读取树，找到目标条目
 * - 如果是最后一层，替换/添加 blob 条目
 * - 如果不是最后一层，递归更新子树
 * - 每层都调用 git.writeTree 生成新的树 OID
 * 
 * @param {string | null} treeOid - 当前树的 OID，null 表示空树
 * @param {string[]} pathParts - 路径部分数组，如 ["subdir", "test.txt"]
 * @param {string} newBlobOid - 新的 blob OID
 * @returns {Promise<string>} - 新的树 OID
 */
async function updateTreeRecursively(treeOid, pathParts, newBlobOid) {
  const [currentPart, ...remainingParts] = pathParts;
  const tree = treeOid ? (await git.readTree({ fs, dir, oid: treeOid })).tree : [];

  let newEntries = [...tree];
  let targetEntryIndex = newEntries.findIndex(e => e.path === currentPart);

  if (remainingParts.length === 0) {
    // 到达文件层，替换或添加 blob 条目
    const newEntry = { path: currentPart, oid: newBlobOid, mode: "100644", type: "blob" };
    if (targetEntryIndex >= 0) {
      newEntries[targetEntryIndex] = newEntry;
    } else {
      newEntries.push(newEntry);
    }
  } else {
    // 还在目录层，递归更新子树
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

async function commitAndPush(filepath, content, message) {
  console.log(`\n=== Processing ${filepath} ===`);

  await initAndFetch();

  const currentCommitSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" });
  const commit = await git.readCommit({ fs, dir, oid: currentCommitSha });

  console.log("   Current HEAD SHA:", currentCommitSha);

  const existingOid = await resolvePathToOid(commit.commit.tree, filepath);
  let existingContent = "";

  if (existingOid) {
    console.log("   Reading existing file...");
    const blob = await git.readBlob({ fs, dir, oid: existingOid });
    existingContent = new TextDecoder().decode(blob.blob);
    console.log("   Original content length:", existingContent.length);
  } else {
    console.log("   File not found, creating new file...");
  }

  const finalContent = existingContent + content;

  console.log("   Writing new blob...");
  const newBlobOid = await git.writeBlob({
    fs,
    dir,
    blob: new TextEncoder().encode(finalContent)
  });
  console.log("   New blob OID:", newBlobOid);

  console.log("   Building new tree...");
  const newTreeSha = await updateTreeRecursively(commit.commit.tree, filepath.split('/').filter(Boolean), newBlobOid);
  console.log("   New tree SHA:", newTreeSha);

  console.log("   Committing...");
  const commitOid = await git.commit({
    fs,
    dir,
    message,
    author: {
      name: "demo",
      email: "demo@example.com"
    },
    tree: newTreeSha,
    parent: [currentCommitSha]
  });
  console.log("   Commit SHA:", commitOid);

  console.log("   Pushing...");
  await git.push({
    fs,
    http,
    dir,
    remote: "origin",
    ref: "main",
    force: true
  });
  console.log("   Push success!");
}

async function main() {
  console.log("=== Test 1: Create new file subdir/test2.txt ===");
  await commitAndPush("subdir/test2.txt", "This is test2.txt content\n", "Create subdir/test2.txt");

  console.log("\n=== Test 2: Append to subdir/test.txt ===");
  await commitAndPush("subdir/test.txt", "Appended content to test.txt\n", "Append to subdir/test.txt");

  console.log("\n=== Test 3: Create new file other2.txt ===");
  await commitAndPush("other2.txt", "This is other2.txt content\n", "Create other2.txt");

  console.log("\n=== All tests completed ===");
}

main().catch(console.error);
