(function(){

async function post_cmt(evt) {
  if (!evt){
    evt = this.event  // called as onsubmit="xxx"
  }
  evt.preventDefault()
  evt.stopPropagation()
  let req
  const fd = new FormData(evt.target)
  try {
    req = await fetch(evt.target.action, {
      method: "POST", referrerPolicy: "unsafe-url",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fd)
    })
  } catch (e) {
    console.info('[req4cmt] failed ' + e)
    evt.submitter.value = '❌'
  }
  let rsp
  try {
    rsp = await req.json()
  } catch (e) {
    rsp = {}
  }
  const is_ok = req.status == 200 && !rsp.error
  evt.submitter.value = is_ok ? '✅' : '⚠️'
  if (is_ok){
    const ta = evt.target.querySelector('textarea')
    const dl = evt.target.querySelector('dl')
    const name = fd.get('name') || '?'
    const dt = ne('dt')
    dt.appendChild(ne('small', {$: new Date().toLocaleString('en-CA',{hour12: false}).replace(',', '')}))
    dt.appendChild(document.createTextNode(' '))
    if (link){
      dt.appendChild(ne('a', {href: fd.get('link') || '', $: name}))
    } else {
      dt.appendChild(ne('b', {$: name}))
    }
    dl.insertBefore(dt, dl.firstChild)
    const dd = ne('dd', {$: fd.get('content')})
    dl.insertBefore(dd, dl.children[1])
    ta.value = ''
    ta.placeholder = 'new comments will appear eventually.\n新评论将稍后刷新'
    setTimeout(load_cmts, 3000, evt.target)
  }
  return false;
}
function ne(tag, attr={}){ // new-element
  const e=document.createElement(tag)
  if(attr.$){
    e.textContent = attr.$
    delete attr.$
  }
  Object.entries(attr).forEach(([k,v])=>e.setAttribute(k,v))
  return e
}
async function load_cmts(form){
  // load from github via CF
  let body
  try{
    body = await (await fetch(form.action + '.jsonl', {headers: {"Accept": "application/x-ndjson"}})).text()
  } catch(e) {
    console.info('[req4cmt] failed ' + e)
    return
  }
  const dl = form.querySelector('dl')
  dl.replaceChildren() // clear
  body.split(/\r?\n/).reverse().forEach(line=>{
      let data;
      try{
        data = JSON.parse(line)
      } catch(e){
        return
      }
      const dt = ne('dt')
      dt.appendChild(ne('small', {$: new Date(data.at).toLocaleString(
        'en-CA',{hour12: false}).replace(',', '')}))  // easy ISO format
      dt.appendChild(document.createTextNode(' '))
      if (data.link){
        dt.appendChild(ne('a', {href: data.link, $: data.name}))
      } else {
        dt.appendChild(b = ne('b', {$: data.name}))
      }
      dl.appendChild(dt)
      const dd = ne('dd', {$: data.content})
      dl.appendChild(dd)
    })
}

async function init(){
  const page_url = new URL(location.href)
  const js_url = new URL(this.src)
  const api = `https://${js_url.host}/${page_url.host}${page_url.pathname}`
  this.insertAdjacentHTML('afterend', `
<div id="req4cmt_thread" style="padding:0 2em 0 2em">
  <form action="${api}" method="post">
  <input type="hidden" name="name" placeholder="guest">
  <input type="hidden" name="email" placeholder="dont@spam.me">
  <textarea name="content" style="width: 100%; height: 5em"></textarea>
  <input type="submit" value="Go">
  <br/>
  <dl style="white-space: pre-wrap;">
  </dl>
  </form>
</div>`)
  const form = req4cmt_thread.querySelector('form');
  form.addEventListener('submit', post_cmt)
  await load_cmts(form)
  // add hidden inputs, avoid spam
  const submit = form.querySelector('input[type="submit"]')
  'name email link'.split(' ').forEach(k=>{
    submit.insertAdjacentElement('beforebegin', ne('input', {name: `x-${k}`, placeholder: k}));
    submit.insertAdjacentText('beforebegin', ' ');
  })
}
document.addEventListener("DOMContentLoaded", init.bind(document.currentScript))

})()
