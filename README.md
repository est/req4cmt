# req4cmt

A comment system for your blog or website, just like disqus without ads.

Runs on [Cloudflare worker](https://developers.cloudflare.com/workers/). Every data is self-contained in a git repo

inspired by [staticman](https://github.com/eduardoboucas/staticman) and its successor [comment-worker](https://github.com/zanechua/comment-worker/issues/4), transfer HTTP POST content, append to a JSON file, commit to a git. May even allowing additional `blob` for picture attachments in the future.

Instead of using Github proprertory API, `req4cmt` use [isomorphic-git](https://isomorphic-git.org/) to speak the git-http protocol, enabling read/write to any git remote.

评论插件。通过cf worker把内容写入到git-http远端，不依赖github api

## Setup

1. fork the repo and deploy to Cloudflare Worker. Assign a domain or use the default like `req4cmt.myaccount.workers.dev`
2. Create another empty repo for data storage, like `github.com/gh_user/my_comments`
3. in your Worker settings, create a new environment secret
4. the secret name is `REPO`, value is the git http url like `https://req4cmt:PAT@github.com/gh_user/my_comments.git`
5. the `PAT` in the above url is a fine-grained [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) with just one `repo` scope to `gh_user/my_comments` with `conrtent` read/write permission. You can create a token under your github [personal settings - Developer Settings](https://github.com/settings/personal-access-tokens).
6. if you are using Gitlab or others, similar private tokens can be found
7. embed a snippet to your HTML page. `<script defer src="https://req4cmt.myaccount.workers.dev/req4cmt.js"></script>`
8. A new `<div>` with a `<form>` and a `<dl>` will appear for your HTML page just below the `<script>` tag


## Plans

- [ ] git committer
- [ ] attachments
- [ ] Github [pull requests](https://github.com/apps/req4cmt) for moderation
- [ ] add cache and reduce API calls
- [ ] rich content formatting like `pre` or markdown
- [ ] `at` someone for notification?
- [ ] also as a [Github App](https://github.com/apps/req4cmt)
