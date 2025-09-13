// @ts-check
// above line is for editor display only. Ignore it

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs'

const fs = new Volume().promises  // Create an in-memory filesystem

const dir = '.'  // in-memory git work dir

async function git_checkout(git_http_url, filepath){	
	// fast partial clone + single file checkout magic
	await git.clone({
		fs, http, dir, url: git_http_url,
		depth: 1, noCheckout: true, singleBranch: true, noTags: true,
	})
	const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' })
	await git.readTree({fs, dir, oid}) // important!
	await git.checkout({
		fs, dir,
		filepaths: [filepath], force: true,
	})
}

async function append_line(git_http_url, filepath, data){
	if (! data.content ) return null
	await git_checkout(git_http_url, filepath)
	await fs.mkdir(path.dirname(filepath), {recursive: true})
	await fs.appendFile(filepath, data.content)
	const t1 = await git.readTree({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' })})
	t1.tree.forEach(entry => console.log(entry.path));
	await git.add({ fs, dir, filepath })
	await git.commit({
		fs, dir,
		message: data.message || 'add new',
		author: {
			name: data.name || 'guest',
			email: data.email || 'guest@example.com' },
	})

	const t2 = await git.readTree({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' })})
	t2.tree.forEach(entry => console.log(entry.path));
	
	/*
	const stagedFiles = await git.statusMatrix({ fs, dir });
	for (const [filepath, head, workdir, stage] of stagedFiles) {
		if (head !== stage) {
			const diff = await git.diff({ fs, dir, filepath, staged: true });
			console.log(`Diff for ${filepath}:\n${diff}`);
		}
	}*/
	return
	const r = await git.push({
		fs, http, dir,
	})
	return r
}

const DEFAULT_EMAIL = '?@c.est.im'
function parse_content(text){
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
	if (first_nl > 0){
		line_1st = text.slice(0, first_nl).trim()
		content = text.slice(first_nl + 1)
	}
	// name + email + link
	const f1 = /([^<>]+)\s*<(\S+@\S+\.\S+)>\s*(https?:\/\/\S+)/.exec(line_1st)
	if (f1){
		return {
			name: f1[1].trim(),
			email: f1[2].trim(),
			link: f1[3].trim(),
			content: content,
		}
	}
	// name + link
	const f2 = /([^<>]+)\s*(https?:\/\/\S+)/.exec(line_1st)
	if (f2){
		return {
			name: f2[1].trim(),
			email: DEFAULT_EMAIL,
			link: f2[2].trim(),
			content: content,
		}
	}
	// name + email
	const f3 = /([^<>]+)\s*<(\S+@\S+\.\S+)>/.exec(line_1st)
	if (f3){
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
	const CORS = {...BASE_CORS,  // cors for all
		'Access-Control-Allow-Origin': request.headers.get('Origin') || '*'}
	if (request.method == 'OPTIONS'){
		return new Response('', {status: 204, headers: CORS})
	}
	if (!env.REPO) {  // Check if required environment variables are set
		return Response.json({'error': 'Missing REPO'}, {status: 400});
	}
	let req_path = /^\/+(\S+)$/.exec(new URL(request.url).pathname)?.[1] || ''
	const new_h = {
		...CORS,
		"Content-Type": 'application/x-ndjson',
		'Content-Disposition': 'inline',
		'X-Content-Type-Options': 'nosniff'}
	// only path ends with .jsonl
	if (request.method == 'GET' && req_path.endsWith('.jsonl')){
		if (env.REPO.includes('github.com/')) {  // proxy github
			const repo_path = new URL(env.REPO).pathname.replace(/\.git$/, "")
			const req_url = `https://raw.githubusercontent.com${repo_path}/refs/heads/master/${req_path}`
			let req
			try{
				req = await fetch(req_url)
			} catch(e) {
				console.debug('timeout ' + req_url)
			}
			if (req?.status == 200){
				new_h['Cache-Control'] = 'public, max-age=3'
				return new Response(req.body, {headers: new_h})
			} else {  // return empty regardless
				return new Response('', {headers: new_h})
			}
		} else {
			await git_checkout(env.REPO, req_path)
			let data = ''
			try{
				data = await fs.readFile(req_path, 'utf8')
			} catch (ex) {
				if (ex.code != 'ENOENT'){
					console.info(ex)
				}
			}
			return new Response(data, {headers: new_h})
		}
	}
	if (request.method != 'POST') {  // only allow POST
		// console.debug(request.method + ' ' + req_path)
		return Response.json({'error': 'req4cmt is ready. Use proper GET/POST'}, {status: 405, headers: CORS});
	}
	// page_url as domain+path, or try parse from `referer` header
	// @ToDo: sanitize it
	const page_url = req_path || /^https?:\/\/([^\/]+(?:\/[^?#]*)?)/.exec(request.headers.get('Referer') || '')?.[1]
	if (!page_url || page_url.includes('..')) {
		return Response.json({'error': 'bad referer. Stop!'}, {status: 400, headers: CORS});
	}
	const cl = request.headers.get('Content-Length')  // DoS attack
	if (cl && parseInt(cl) > 1024 * 1024) {  // 1MB is too large. even with attachments
		return Response.json({'error': 'body too large. Stop.'}, {status: 400, headers: CORS});
	}
	const ct = request.headers.get('Content-Type') || ''  // consider ban the naughty IP next
	if (!(
		ct.includes('multipart/form-data') ||
		ct.includes('application/x-www-form-urlencoded')
	)) {
		return Response.json({'error': 'No form data. Stop.'}, {status: 400, headers: CORS});
	}

	const cf = request.cf
	const tail_msg = {
		asn: cf.asn, asnOrg: cf.asOrganization,
		botScore: cf.botManagement?.verifiedBot ? -1 : cf.botManagement?.score || '-',
		http: cf.httpProtocol, tls: cf.tlsVersion,
		country: cf.country, city: cf.city, timezone: cf.timezone}
	// construct a GIT commit
	const form = await request.formData()  // or Object.fromEntries(form.entries())

	// honeypot. bots tend to fill `name` and `email`
	if (form.get('name') || form.get('email')) {  // fooled lol
		return Response.json({'error': 'yeah right'}, {headers: CORS})
	}
	const form_content = (form.get('content') || '').trim()
	if (form_content.length > 1024 * 1024) {  // prevent over large text again
		return Response.json({'error': 'content too large. Bye'}, {status: 400, headers: CORS});
	} else if (!form_content) {  // too short
		return Response.json({'error': 'empty'}, {headers: CORS})
	}
	// let info = parse_content(form_content)
	const info = {
		content: form_content,
		name: (form.get('x-name') || '?').slice(0, 200).trim() || '?',
		email: (/(\S+@\S+\.\S+)/.exec(form.get('x-email'))?.[1] || DEFAULT_EMAIL).slice(0, 200),
		link: (form.get('x-link') || '').slice(0, 1024 * 4),  // 4k should be enough
	}
	console.log(page_url, info)
	info.content = JSON.stringify({
		name: info.name, link: info.link, at: new Date().toISOString(),
		content: info.content}) + '\n'
	info.message = `new content ${info.content.length} chars by ${info.name}\n\n` + Object.entries(tail_msg).map(
		([k, v]) => `${k}: ${v}`).join('\n')
	let r
	// try{
	r = await append_line(env.REPO, page_url + '.jsonl', info)
	// } catch (ex) {
		// console.error('failed', ex)
		return Response.json({'error': 'git failed'}, {status: 504, headers: CORS})
	// }
	if ((request.headers.get('Accept') || '').startsWith('text/html')){ // noscript redir
		return Response.redirect('https://' + page_url)
	} else {
		return Response.json(r, {headers: CORS})
	}
  }
};
