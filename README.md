# req4cmt

A comment plugin for your blog or website, just like disqus without ads.

It requires **NO** cookie, no signups, no login, no bullshit. Just type your comment in a `textarea` and submit.

To render the `textarea`, a few kilobyes static uncompressed `req4cmt.js` is loaded.

Then the .js do a `fetch` and render the comment list

Runs on [Cloudflare worker](https://developers.cloudflare.com/workers/) for free. Every data is self-contained in a git repo

inspired by [staticman](https://github.com/eduardoboucas/staticman) and its successor [comment-worker](https://github.com/zanechua/comment-worker/issues/4), transfer HTTP POST content, append to a JSON file, commit to a git. May even allowing additional `blob` for picture attachments in the future.

Instead of using Github proprietary API, `req4cmt` use [isomorphic-git](https://isomorphic-git.org/) to speak the git-http protocol, enabling read/write to *any* git remote.

评论插件。通过cf worker把内容写入到git-http远端，不依赖github api

## Demo

Visit my blog: <https://blog.est.im/2025/stdout-07>

## Setup

1. fork the repo and deploy to Cloudflare Worker. Assign a domain or use the default like `req4cmt.myaccount.workers.dev`
2. Create another empty repo for data storage, like `github.com/gh_user/my_comments`
3. in your Worker settings, create a new environment secret
4. the secret name is `REPO`, value is the git http url like `https://req4cmt:PAT@github.com/gh_user/my_comments.git`
5. the `PAT` in the above url is a fine-grained [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) with just one `repo` scope to `gh_user/my_comments` with `content` read/write permission. You can create a token under your github [personal settings - Developer Settings](https://github.com/settings/personal-access-tokens).
6. if you are using Gitlab or others, similar private tokens can be found
7. embed a snippet to your HTML page. `<script defer src="https://req4cmt.myaccount.workers.dev/req4cmt.js"></script>`
8. A new `<div>` with a `<form>` and a `<dl>` will appear for your HTML page just below the `<script>` tag

The UI is too ugly? Modify the `<div id="req4cmt_thread">` inside `dist/req4cmt.js` yourself.

## Plans

- [ ] git committer
- [ ] attachments
- [ ] Github [pull requests](https://github.com/apps/req4cmt) for moderation
- [ ] add cache and reduce API calls
- [ ] rich content formatting like `pre` or markdown
- [ ] `at` someone for notification?
- [ ] also as a [Github App](https://github.com/apps/req4cmt)
- [X] limit length
- [X] 20250912 git-http fetch file for private repos, replace github download.

## failures and non-goals

### 1. partial fetch (2025-09-13)

To accelerate `git clone`, in theory we only need to fetch the latest commit and the individual .jsonl file.

I failed attemped to implement this. isomorphic-git does not handle single file checkout well. When `.commit()` Other files gets deleted. WTF?

Also the `git.clone()` at minimal depth=1 would still load every .jsonl from a shallow commit.

Scaling might be an issue in the future.

###  2. no `append` to git commits

How to append new lines to a large .jsonl file, without downloading the previous file content?

git use `sha1` for hashing (mostly). `sha1` can be "streamed" by serializing its internal state, in Python you can pickle a `hashlib.sha1` instance.

Sadly, the git blob is hashed as `"blob " + <decimal size> + "\0" + <file content>`

every new line is appended, the `<decimal size>` changes, makes the header different. To make a new git commit, download the entire file, re-hash is a must .

Learned from ChatGPT today (2025-09-30). Saved me lot of time.

### 3. why not use SQLite/D1 or some proper database?

The same reason why choosing static site over Wordpress, which uses a database

I dislike managing DBs. Think of all those mess with backups, migrations, imports, exports, difference between mysql/pg/sqlite/etc. Tons of operating cost just for the sake of few blog comments

### 4. wasted CPU and memory, git is too heavy for comments

For a blog comment plugin, most of IOs are read. The worker will load single .jsonl from raw.githubusercontent.com if you are using github.

In case of writes, req4cmt worker will clone the repo (as minimal as possible), append the new line, and commit it back to the remote.

Let's be realistic, your blog won't have millions of comments. The clone should be fast.

And optimistically, There won't be too many visitor writing comments at the same time. So a basic git optimistic lock should be good enough

### 5. comments are risky, moderation is hard!

It's a git of .jsonl files, one comment for one line per commit, just `git clone`, `sed` them and `git push`

To erase the history entirely, use `git cherry-pick` and `git push -f`

Not a shell user? I don't think you'd run a static generated site anyway.

Future work:   
 -  allow req4cmt to commit to a different branch
 - use "Pull Request" to review them before merge.

### 6. How to fight spam?

Look at the source. You can insert you clever if-else there.

or `git filter-branch` the commits just in case.
