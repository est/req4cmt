// @ts-check
// above line is for editor display only. Ignore it

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs'

const fs = new Volume().promises  // Create an in-memory filesystem

const dir = '.'  // in-memory git work dir

/**
Sparse Checkout Implementation

Goal: fetch only needed file, modify, and commit without cloning entire repo
Works in Cloudflare Worker (no git command, no filesystem, uses memfs)

1. git.clone downloads entire repo
   - Solution: git.init + git.fetch(depth=1) for latest commit only

2. git.readTree only reads root directory
   - Solution: resolvePathToOid recursively finds file by path

3. git.writeTree with flat path "subdir/test.txt" fails
   - Error: "The filepath contains unsafe character sequences"
   - Solution: updateTreeRecursively builds nested tree structure

4. Optimization: avoid reading entire tree
   - resolvePathToOid: finds file OID by traversing path
   - updateTreeRecursively: updates only necessary parts
 */

async function initAndFetch(git_http_url) {
	await git.init({ fs, dir });
	await git.addRemote({ fs, dir, url: git_http_url, remote: "origin" });
	await git.fetch({
		fs,
		http,
		dir,
		url: git_http_url,
		depth: 1,
		singleBranch: true,
		tags: false
	});
}

/**
 * Find file OID by traversing path
 * 
 * @param {string} treeOid - Tree OID
 * @param {string} filepath - File path like "subdir/test.txt"
 * @returns {Promise<string | null>} - Blob OID or null if not found
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
 * Recursively update tree structure
 * 
 * Why needed: Git trees are nested, can't use flat list
 * 
 * Failed approaches:
 * 1. git.writeTree with flat path "subdir/test.txt"
 *    - Error: "unsafe character sequences"
 * 2. git.updateIndex + git.writeTree()
 *    - git.resetIndex requires filepath, can't clear entire index
 * 
 * Solution:
 * - Traverse path level by level
 * - Replace/add blob at file level
 * - Recursively update subtrees
 * - Call git.writeTree at each level
 * 
 * @param {string | null} treeOid - Current tree OID, null = empty
 * @param {string[]} pathParts - Path parts like ["subdir", "test.txt"]
 * @param {string} newBlobOid - New blob OID
 * @returns {Promise<string>} - New tree OID
 */
async function updateTreeRecursively(treeOid, pathParts, newBlobOid) {
	const [currentPart, ...remainingParts] = pathParts;
	const tree = treeOid ? (await git.readTree({ fs, dir, oid: treeOid })).tree : [];

	let newEntries = [...tree];
	let targetEntryIndex = newEntries.findIndex(e => e.path === currentPart);

	if (remainingParts.length === 0) {
		// File level: replace/add blob entry
		/** @type {import('isomorphic-git').TreeEntry} */
		const newEntry = { path: currentPart, oid: newBlobOid, mode: "100644", type: "blob" };
		if (targetEntryIndex >= 0) {
			newEntries[targetEntryIndex] = newEntry;
		} else {
			newEntries.push(newEntry);
		}
	} else {
		// Directory level: recursively update subtree
		const subTreeOid = targetEntryIndex >= 0 ? newEntries[targetEntryIndex].oid : null;
		const newSubTreeOid = await updateTreeRecursively(subTreeOid, remainingParts, newBlobOid);
		/** @type {import('isomorphic-git').TreeEntry} */
		const newEntry = { path: currentPart, oid: newSubTreeOid, mode: "40000", type: "tree" };

		if (targetEntryIndex >= 0) {
			newEntries[targetEntryIndex] = newEntry;
		} else {
			newEntries.push(newEntry);
		}
	}

	return await git.writeTree({ fs, dir, tree: newEntries });
}

async function getFileContent(git_http_url, filepath) {
	await initAndFetch(git_http_url);
	const currentCommitSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" });
	const commit = await git.readCommit({ fs, dir, oid: currentCommitSha });

	const oid = await resolvePathToOid(commit.commit.tree, filepath);
	if (!oid) return "";

	const blob = await git.readBlob({ fs, dir, oid });
	return new TextDecoder().decode(blob.blob);
}

async function append_line(git_http_url, filepath, data) {
	if (!data.content) return null;

	await initAndFetch(git_http_url);

	const currentCommitSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" });
	const commit = await git.readCommit({ fs, dir, oid: currentCommitSha });

	const existingOid = await resolvePathToOid(commit.commit.tree, filepath);
	let content = "";
	if (existingOid) {
		const blob = await git.readBlob({ fs, dir, oid: existingOid });
		content = new TextDecoder().decode(blob.blob);
	}

	content = content + data.content;

	const newBlobOid = await git.writeBlob({
		fs,
		dir,
		blob: new TextEncoder().encode(content)
	});

	const newTreeSha = await updateTreeRecursively(commit.commit.tree, filepath.split('/').filter(Boolean), newBlobOid);

	await git.commit({
		fs, dir,
		message: data.message || 'add new',
		author: {
			name: data.name || 'guest',
			email: data.email || 'guest@example.com'
		},
		tree: newTreeSha,
		parent: [currentCommitSha]
	});

	const r = await git.push({
		fs, http, dir,
		remote: "origin",
		// ref: "main", force: true
	});
	
	return r;
}

const DEFAULT_EMAIL = '?@c.est.im'
function parse_content(text) {
	/*
	parse these:
	  - name <email> link
	  - name link
	  - name <email>
	  - name
	*/
	let line_1st = ''
	let content = text
	const first_nl = text.indexOf("\n")
	if (first_nl > 0) {
		line_1st = text.slice(0, first_nl).trim()
		content = text.slice(first_nl + 1)
	}
	// name + email + link
	const f1 = /([^<>]+)\s*<(\S+@\S+\.\S+)>\s*(https?:\/\/\S+)/.exec(line_1st)
	if (f1) {
		return {
			name: f1[1].trim(),
			email: f1[2].trim(),
			link: f1[3].trim(),
			content: content,
		}
	}
	// name + link
	const f2 = /([^<>]+)\s*(https?:\/\/\S+)/.exec(line_1st)
	if (f2) {
		return {
			name: f2[1].trim(),
			email: DEFAULT_EMAIL,
			link: f2[2].trim(),
			content: content,
		}
	}
	// name + email
	const f3 = /([^<>]+)\s*<(\S+@\S+\.\S+)>/.exec(line_1st)
	if (f3) {
		return {
			name: f3[1].trim(),
			email: f3[2].trim(),
			content: content,
		}
	}
	return {
		name: '?',
		email: DEFAULT_EMAIL,
		content: text
	}
}

const BASE_CORS = {
	// 'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Allow-Credentials': 'true',
	'Access-Control-Max-Age': '86400'
}

export default {  // Cloudflare Worker entry
	async fetch(request, env, ctx) {
		const CORS = {
			...BASE_CORS,  // cors for all
			'Access-Control-Allow-Origin': request.headers.get('Origin') || '*'
		}
		if (request.method == 'OPTIONS') {
			return new Response('', { status: 204, headers: CORS })
		}
		if (!env.REPO) {  // Check if required environment variables are set
			return Response.json({ 'error': 'Missing REPO' }, { status: 400 });
		}
		let req_path = /^\/+(\S+)$/.exec(new URL(request.url).pathname)?.[1] || ''
		const new_h = {
			...CORS,
			"Content-Type": 'application/x-ndjson',
			'Content-Disposition': 'inline',
			'X-Content-Type-Options': 'nosniff'
		}
		// only path ends with .jsonl
		if (request.method == 'GET' && req_path.endsWith('.jsonl')) {
			if (env.REPO.includes('github.com/')) {  // proxy github
				const repo_path = new URL(env.REPO).pathname.replace(/\.git$/, "")
				const req_url = `https://raw.githubusercontent.com${repo_path}/refs/heads/master/${req_path}`
				let req
				try {
					req = await fetch(req_url)
				} catch (e) {
					console.log('timeout ' + req_url)
				}
				if (req?.status == 200) {
					new_h['Cache-Control'] = 'public, max-age=3'
					return new Response(req.body, { headers: new_h })
				} else {  // return empty regardless
					return new Response('', { headers: new_h })
				}
			} else {  // partial clone and return
				let data = ''
				try {
					data = await getFileContent(env.REPO, req_path)
				} catch (ex) {
					if (ex.code != 'ENOENT') {
						console.log('partial clone failed ', ex)
					}
				}
				return new Response(data, { headers: new_h })
			}
		}
		if (request.method != 'POST') {  // only allow POST
			// console.log(request.method + ' ' + req_path)
			return Response.json({ 'error': 'req4cmt is ready. Use proper GET/POST' }, { status: 405, headers: CORS });
		}
		// page_url as domain+path, or try parse from `referer` header
		// @ToDo: sanitize it
		const page_url = req_path || /^https?:\/\/([^\/]+(?:\/[^?#]*)?)/.exec(request.headers.get('Referer') || '')?.[1]
		if (!page_url || page_url.includes('..')) {
			return Response.json({ 'error': 'bad referer. Stop!' }, { status: 400, headers: CORS });
		}
		const cl = request.headers.get('Content-Length')  // DoS attack
		if (cl && parseInt(cl) > 1024 * 1024) {  // 1MB is too large. even with attachments
			return Response.json({ 'error': 'body too large. Stop.' }, { status: 400, headers: CORS });
		}
		const ct = request.headers.get('Content-Type') || ''  // consider ban naughty IP next
		if (!(
			ct.includes('multipart/form-data') ||
			ct.includes('application/x-www-form-urlencoded')
		)) {
			return Response.json({ 'error': 'No form data. Stop.' }, { status: 400, headers: CORS });
		}

		const cf = request.cf
		const tail_msg = {
			asn: cf.asn, asnOrg: cf.asOrganization, lang: request.headers.get('accept-language'),
			botScore: cf.botManagement?.verifiedBot ? -1 : cf.botManagement?.score || '-',
			http: cf.httpProtocol, tls: cf.tlsVersion,
			country: cf.country, region: cf.region, city: cf.city, timezone: cf.timezone
		}
		// construct a GIT commit
		const form = await request.formData()  // or Object.fromEntries(form.entries())

		// honeypot. bots tend to fill `name` and `email`
		if (form.get('name') || form.get('email')) {  // fooled lol
			return Response.json({ 'error': 'yeah right' }, { headers: CORS })
		}
		const form_content = (form.get('content') || '').trim()
		if (form_content.length > 1024 * 1024) {  // prevent over large text again
			return Response.json({ 'error': 'content too large. Bye' }, { status: 400, headers: CORS });
		} else if (!form_content) {  // too short
			return Response.json({ 'error': 'empty' }, { headers: CORS })
		}
		// let info = parse_content(form_content)
		const info = {
			content: form_content,
			name: (form.get('x-name') || '?').slice(0, 200).trim() || '?',
			email: (/([^@\s]+@[^@\s]+\.[^@\s]+)/.exec(form.get('x-email'))?.[1] || DEFAULT_EMAIL).slice(0, 200),
			link: (form.get('x-link') || '').slice(0, 1024 * 4),  // 4k should be enough
		}
		console.log(page_url, info)
		info.content = JSON.stringify({
			name: info.name, link: info.link, at: new Date().toISOString(),
			content: info.content
		}) + '\n'
		info.message = `new content ${info.content.length} chars by ${info.name}\n\n` + Object.entries(tail_msg).map(
			([k, v]) => `${k}: ${v}`).join('\n')
		let r
		try {
			r = await append_line(env.REPO, page_url + '.jsonl', info)
		} catch (ex) {
			console.log('failed', ex)
			return Response.json({ 'error': 'git failed' }, { status: 504, headers: CORS })
		}
		if ((request.headers.get('Accept') || '').startsWith('text/html')) { // noscript redir
			return Response.redirect('https://' + page_url)
		} else {
			return Response.json(r, { headers: CORS })
		}
	}
};
