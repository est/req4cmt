# req4cmt

Works like a comment system for your blog or website, just like disqus without ads.

Runs on [Cloudflare worker](https://developers.cloudflare.com/workers/). Every data is self-contained in a git repo

like [staticman](https://github.com/eduardoboucas/staticman) and its successor [comment-worker](https://github.com/zanechua/comment-worker/issues/4), transfer HTTP POST content, append to a JSON file, commit to a git. May even allowing additional `blob` for picture attachments.

Instead of using Github proprertory API, `req4cmt` use [isomorphic-git](https://isomorphic-git.org/) to speak the git-http protocol, enabling read/write to any git remote.

评论插件。通过cf worker把内容写入到git-http远端，不依赖github api


## Plans

- [ ] attachments
- [ ] Github [pull requests](https://github.com/apps/req4cmt)