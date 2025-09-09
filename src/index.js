// @ts-check
// above line is for editor display only. Ignore it

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import path from "path";
import { Volume } from 'memfs'

const fs = new Volume().promises  // Create an in-memory filesystem
const dir = '.'  // in-memory git work dir

async function append_line(git_http_url, filepath, data){
	if (! data.content ) return null
	await git.clone({
		fs, http, dir,
		url: git_http_url, singleBranch: true, depth: 1
	})
	await fs.mkdir(path.dirname(filepath), {recursive: true})
	await fs.appendFile(filepath, data.content)
	await git.add({ fs, dir, filepath: filepath })
	await git.commit({
		fs, dir,
		message: data.message || 'add new',
		author: {
			name: data.name || 'guest',
			email: data.email || 'guest@example.com' },
	})
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

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Allow-Credentials': 'true',
	'Access-Control-Max-Age': '86400'
}

export default {  // Cloudflare Worker entry
  async fetch(request, env, ctx) {
	// Check if required environment variables are set
	if (request.method == 'OPTIONS'){
		return new Response('', {status: 204, headers: CORS})
	}
	if (!env.REPO) {
		return Response.json({'error': 'Missing REPO'}, {status: 400});
	}
	// proxy github, only path ends with .jsonl
	const url_path = new URL(request.url).pathname
	if (request.method == 'GET' && url_path.endsWith('.jsonl')){
		const repo_path = new URL(env.REPO).pathname.replace(/\.git$/, "")
		const req = await fetch(`https://raw.githubusercontent.com${repo_path}/refs/heads/master${url_path}`)
		return new Response(req.body, {status: req.status, headers: req.headers})
	}
	// only allow POST
	if (request.method != 'POST') {
		// cors for all
		return Response.json({'error': 'use POST'}, {status: 405, headers: {
			...CORS,
			'Access-Control-Allow-Origin': request.headers.get('Origin') || '*'}});
	}
	// page_url as domain+path from `referer` header
	const page_url = /^https?:\/\/([^\/]+(?:\/[^?#]*)?)/.exec(request.headers.get('Referer') || '')?.[1]
	if (!page_url || page_url.includes('..')) {
		return Response.json({'error': 'bad referer. Stop!'}, {status: 400, headers: CORS});
	}
	const ct = request.headers.get('Content-Type') || ''
	if (!(
		ct.includes('multipart/form-data') ||
		ct.includes('application/x-www-form-urlencoded')
	
	)) {
		return Response.json({'error': 'No form data. Stop.'}, {status: 400, headers: CORS});
	}

	const cf = request.cf
	const tail_msg = {
		asn: cf.asn,
		asnOrg: cf.asOrganization,
		botScore: cf.botManagement?.verifiedBot ? -1 : cf.botManagement?.score || '-',
		http: cf.httpProtocol,
		tls: cf.tlsVersion,
		country: cf.country,
		city: cf.city,
		timezone: cf.timezone}
	// construct a GIT commit
	const form = await request.formData()  // or Object.fromEntries(form.entries())
	if (form.get('name') || form.get('email') || !form.get('content')) {  // fooled lol
		return Response.json({'error': 'yeah right'}, {status: 200, headers: CORS})
	}

	// let info = parse_content(form.get('content'))
	const info = {
		content: (form.get('content') || '').trim(),
		name: (form.get('x-name') || '?').trim() || '?',
		email: /(\S+@\S+\.\S+)/.exec(form.get('x-email'))?.[1] || DEFAULT_EMAIL,
		link: form.get('x-link'),
	}
	if (!info.content){
		return Response.json({'error': 'empty'}, {status: 200, headers: CORS})
	}
	info.content = JSON.stringify({
		name: info.name, link: info.link, at: new Date().toISOString(),
		content: info.content}) + '\n'
	info.message = `new content ${info.content.length} chars by ${info.name}\n\n` + Object.entries(tail_msg).map(
		([k, v]) => `${k}: ${v}`).join('\n')
	const r = await append_line(env.REPO, page_url + '.jsonl', info)
	return Response.json(r, {'status': 200, headers: CORS})
  }
};
