import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Volume } from 'memfs'

// Create an in-memory filesystem
const fs = new Volume().promises

// Cloudflare Worker entry
export default {
  async fetch(request, env, ctx) {
	// Check if required environment variables are set
	if (!env.REPO || !env.TARGET) {
		return new Response('Missing required environment variables: REPO and TARGET', {
			status: 400,
			headers: { 'content-type': 'text/plain' }
		});
	}
	const dir = '.'  // git work dir

	// List all the branches on a repo
	const refs = await git.listServerRefs({
		http, url: env.REPO, prefix: "refs/heads/", protocolVersion: 1
	});
	console.log(refs);
	const oid = refs[0].oid
	const ref = refs[0].ref

	// clone the repo
	await git.clone({
		fs, http, dir,
		url: env.REPO,
		singleBranch: true, depth: 1
	})

	try{
		const { blob } = await git.readBlob({
			fs, dir, oid: oid,
			filepath: env.TARGET
		})
		console.log(blob)
	} catch(err) {
		console.log(err)
	}

	await fs.appendFile(env.TARGET, 'test123\n')
	await git.add({ fs, dir, filepath: env.TARGET })
	await git.commit({
		fs, dir,
		message: 'damn',
		author: { name: 'test', email: 'test@example.com' },
	})

	await git.push({
		fs, http, dir: '.',
		remote: 'origin',
		ref: ref,
	})

	return new Response('', {'status': 200})
  }
};
