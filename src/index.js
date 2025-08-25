import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs'

// Create an in-memory filesystem
const fs = new Volume().promises
const dir = '.'  // git work dir

async function test1(){
	// List all the branches on a repo
	const refs = await git.listServerRefs({
		http, url: env.REPO, prefix: "refs/heads/", protocolVersion: 1
	});
	console.log(refs);
	const oid = refs[0].oid
	const ref = refs[0].ref


	try{
		const { blob } = await git.readBlob({
			fs, dir, oid: oid,
			filepath: env.TARGET
		})
		console.log(blob)
	} catch(err) {
		console.log(err)
	}
}

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
	// clone the repo
	await git.clone({
		fs, http, dir,
		url: env.REPO, singleBranch: true, depth: 1
	})
	const branches = await git.listBranches({ fs, dir });
	const head_branch = branches.find(b => 
		git.resolveRef({ fs, dir, ref: b }).then(commit => commit === headCommit)
	);
	console.info('branch=' + head_branch)
	// await git.checkout({fs, dir, ref: head_branch, force: true});  // reset to latest

	await fs.mkdir(path.dirname(env.TARGET), {recursive: true})
	await fs.appendFile(env.TARGET, 'test ' + new Date().toISOString()  + '\n')
	// console.info('content=\n'+ await fs.readFile(env.TARGET))
	await git.add({ fs, dir, filepath: env.TARGET })
	const c = await git.commit({
		fs, dir,
		message: 'test1',
		author: { name: 'test1', email: 'test1@example.com' },
	})
	console.info('commit=' + c)

	const r = await git.push({
		fs, http, dir: '.',
		remote: 'origin',
		ref: head_branch,
	})

	return new Response(JSON.stringify(r), {'status': 200})
  }
};
