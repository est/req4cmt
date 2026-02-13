import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs';

const fs = new Volume().promises;
const dir = "/tmp/repo";

const GIT_URL = "http://host/demo.git";
const TARGET_FILE = "test.txt";

async function sparseCheckout() {
  console.log("1. Initializing empty repo...");
  await git.init({ fs, dir, defaultBranch: "main" });

  console.log("2. Adding remote...");
  await git.addRemote({ fs, dir, url: GIT_URL, remote: "origin" });

  console.log("3. Fetching with depth=1...");
  await git.fetch({
    fs,
    http,
    dir,
    url: GIT_URL,
    depth: 1,
    singleBranch: true,
    tags: false
  });

  console.log("4. Getting current HEAD...");
  const currentCommitSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" });
  console.log("   Current HEAD SHA:", currentCommitSha);

  console.log("5. Reading tree...");
  const commit = await git.readCommit({ fs, dir, oid: currentCommitSha });
  const tree = await git.readTree({ fs, dir, oid: commit.commit.tree });
  
  const files = [];
  for (const entry of tree.tree) {
    files.push({ path: entry.path, oid: entry.oid, type: entry.type });
  }
  console.log("   Files:", files.map(f => f.path));

  console.log("6. Processing target file...");
  let targetEntry = files.find(f => f.path === TARGET_FILE);
  let content;
  
  if (targetEntry) {
    console.log("   Reading existing file...");
    const blob = await git.readBlob({ fs, dir, oid: targetEntry.oid });
    content = new TextDecoder().decode(blob.blob);
    console.log("   Original content:", content.trim());
    content = content + "updated8\n";
  } else {
    console.log("   Creating new file...");
    content = "hello world\n";
  }

  console.log("7. Writing new blob...");
  const newBlobOid = await git.writeBlob({
    fs,
    dir,
    blob: new TextEncoder().encode(content)
  });
  console.log("   New blob OID:", newBlobOid);

  console.log("8. Building new tree...");
  const newTreeEntries = [];
  for (const f of files) {
    if (f.path === TARGET_FILE) {
      newTreeEntries.push({ path: f.path, oid: newBlobOid, mode: "100644", type: "blob" });
    } else {
      newTreeEntries.push({ path: f.path, oid: f.oid, mode: f.type === "blob" ? "100644" : "040000", type: f.type });
    }
  }
  
  if (!targetEntry) {
    newTreeEntries.push({ path: TARGET_FILE, oid: newBlobOid, mode: "100644", type: "blob" });
  }

  const newTreeSha = await git.writeTree({ fs, dir, tree: newTreeEntries });
  console.log("   New tree SHA:", newTreeSha);

  console.log("9. Committing...");
  const commitOid = await git.commit({
    fs,
    dir,
    message: "Update test.txt via isomorphic-git",
    author: {
      name: "demo",
      email: "demo@example.com"
    },
    tree: newTreeSha,
    parent: [currentCommitSha]
  });
  console.log("   Commit SHA:", commitOid);

  console.log("10. Pushing...");
  try {
    await git.push({
      fs,
      http,
      dir,
      remote: "origin",
      ref: "main",
      force: true
    });
    console.log("   Push success!");
  } catch (err) {
    console.error("   Push failed:", err.message);
  }
}

sparseCheckout().catch(console.error);
