import git from "isomorphic-git";
import http from "isomorphic-git/http/web";



export default {
  async fetch(request, env, ctx) {
    const r = await git.getRemoteInfo({ http, url: env.REPO })
    console.info(r)

    return new Response('Hello World!');
  }
};
