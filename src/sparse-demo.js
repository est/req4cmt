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
