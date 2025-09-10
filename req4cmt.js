(function(){

async function post_cmt() {
  evt = this.event
  evt.preventDefault()
  let req
  try {
    req = await fetch(evt.action, {
      method: "POST", referrerPolicy: "unsafe-url",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(new FormData(evt.target))
    })
  } catch (e) {
    console.log(e)
    evt.submitter.value = '❌'
  }
  let rsp
  try {
    rsp = await r.json()
  } catch (e) {
    rsp = {}
  }
  const is_ok = req.status == 200 && !rsp.error
  evt.submitter.value = is_ok ? '✅' : '⚠️'
  if (is_ok){
    location.assign(location.href)
  }
  return false;
}
function ne(tag, attr={}){
  const e=document.createElement(tag)
  if(attr.$){
    e.textContent = attr.$
    delete attr.$
  }
  Object.entries(attr).forEach(([k,v])=>e.setAttribute(k,v))
  return e
}
function load_cmts(api){
  // load from github via CF
  fetch(api).then(x=>x.text()).then(body => {
    body.split(/\r?\n/).forEach(line=>{
      let data;
      try{
        data = JSON.parse(line)
      } catch(e){
        return
      }
      const dt = ne('dt')
      dt.appendChild(ne('small', {$: new Date(data.at).toLocaleString('en-CA',{hour12: false}).replace(',', '')}))
      dt.appendChild(document.createTextNode(' '))
      if (data.link){
        dt.appendChild(ne('a', {href: data.link, $: data.name}))
      } else {
        dt.appendChild(b = ne('b', {$: data.name}))
      }
      req4cmt_thread.appendChild(dt)
      const dd = ne('dd', {$: data.content})
      req4cmt_thread.appendChild(dd)
    })
  })
}

async function init(){
  // add hidden inputs
  const submit = req4cmt_thread.querySelector('form input[type="submit"]')
  'name email link'.split(' ').forEach(k=>{
    submit.insertAdjacentElement('beforebegin', ne('input', {name: `x-${k}`, placeholder: k}));
    submit.insertAdjacentText('beforebegin', ' ');
  })
  const page_url = new URL(location.href)
  const js_url = new URL(document.currentScript.src)
  const api = `https://${js_url.host}/${page_url.host}${page_url.pathname}`
  document.currentScript.insertAdjacentHTML('afterend', `
<div id="req4cmt_thread">
  <form action="${api}" method="post" onsubmit="post_cmt();">
  <input type="hidden" name="name" placeholder="guest">
  <input type="hidden" name="email" placeholder="dont@spam.me">
  <textarea name="content"></textarea>
  <input type="submit" value="Go">
  </form>
  <br/>
  <dl>
  </dl>
</div>`)
  load_cmts(req4cmt_thread.querySelector('form').action + '.jsonl')
}
document.addEventListener("DOMContentLoaded", init)

})()
