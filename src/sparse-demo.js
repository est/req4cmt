import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Volume } from 'memfs';

const fs = new Volume().promises;
const dir = "/tmp/repo";

const GIT_URL = "http://host/demo.git";

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

async function commitAndPush(filepath, content, message) {
  console.log(`\n=== Processing ${filepath} ===`);
  
  await initAndFetch();
  
  const currentCommitSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" });
  const commit = await git.readCommit({ fs, dir, oid: currentCommitSha });
  const files = await readTreeRecursively(commit.commit.tree);
  
  console.log("   Current HEAD SHA:", currentCommitSha);
  console.log("   Files:", files.map(f => f.path));

  let existingContent = "";
  const targetEntry = files.find(f => f.path === filepath);
  
  if (targetEntry) {
    console.log("   Reading existing file...");
    const blob = await git.readBlob({ fs, dir, oid: targetEntry.oid });
    existingContent = new TextDecoder().decode(blob.blob);
    console.log("   Original content:", existingContent.trim());
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
  const newFiles = [];
  
  for (const f of files) {
    if (f.path !== filepath) {
      newFiles.push({ path: f.path, oid: f.oid, mode: f.mode });
    }
  }
  
  newFiles.push({ path: filepath, oid: newBlobOid, mode: "100644" });

  console.log("   Files:", newFiles.map(f => f.path));

  const newTreeSha = await buildNestedTree(newFiles);
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
