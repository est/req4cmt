// @ts-check

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs'

const fs = new Volume().promises  // Create an in-memory filesystem
const dir = '.'  // in-memory git work dir

async function append_line(git_http_url, filepath, info){
	if (! info.content ) return null
	await git.clone({
		fs, http, dir,
		url: git_http_url, singleBranch: true, depth: 1
	})
	await fs.mkdir(path.dirname(filepath), {recursive: true})
	await fs.appendFile(filepath, info.content)
	await git.add({ fs, dir, filepath: filepath })
	await git.commit({
		fs, dir,
		message: info.message || 'add new',
		author: { name: info.name || 'guest', email: 'guest@example.com' },
	})
	const r = await git.push({
		fs, http, dir,
	})
	return r
}

export default {  // Cloudflare Worker entry
  async fetch(request, env, ctx) {
	// Check if required environment variables are set
	if (!env.REPO || !env.TARGET) {
		return Response.json({'error': 'Missing REPO or TARGET'}, {
			status: 400,
		});
	}
	const ct = request.headers.get('Content-Type') || ''
	let info = {
		'message': 'add new',
		'name': 'guest',
		'content': 'guest',
	}
	if (request.method == 'POST' &&  (
		ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')
	)) {
		const data = await request.formData()
		const cf = request.cf
		info = {
			message: `add new

asn: ${cf.asn || ''}
asnOrg: ${cf.asOrganization || ''}
botScore: ${cf.botManagement.verifiedBot?-1:cf.botManagement.score}
http: ${cf.httpProtocol || ''}
tls: ${cf.tlsVersion || ''}
country: ${cf.country || ''}
city: ${cf.city || ''}
timezone: ${cf.timezone || ''}
`,
			name: data.get('name'),
			content: data.get('content'),
		}
	}
	const r = await append_line(env.REPO, env.TARGET, info)
	return Response.json(r, {'status': 200})
  }
};
