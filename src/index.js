import git from "isomorphic-git";
import http from "isomorphic-git/http/web";



export default {
  async fetch(request, env, ctx) {
    return new Response('Hello World!');
  }
};
