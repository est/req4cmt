(function(){

function ne(tag, attr={}){ // new-element
  const e=document.createElement(tag)
  if(attr.$){
    e.textContent = attr.$
    delete attr.$
  }
  Object.entries(attr).forEach(([k,v])=>e.setAttribute(k,v))
  return e
}
function fmtAt(iso){
  return new Date(iso || Date.now()).toLocaleString('en-CA',{hour12: false}).replace(',', '')
}
function renderItem(dl, data, prepend){
  const name = data.name || '?'
  const dt = ne('dt')
  dt.appendChild(ne('small', {$: fmtAt(data.at)}))
  dt.appendChild(document.createTextNode(' '))
  dt.appendChild(data.link ? ne('a', {href: data.link, $: name}) : ne('b', {$: name}))
  const dd = ne('dd', {$: data.content})
  if (prepend){
    dl.insertBefore(dt, dl.firstChild)
    dl.insertBefore(dd, dl.children[1])
  } else {
    dl.appendChild(dt)
    dl.appendChild(dd)
  }
}

async function post_cmt(evt) {
  evt.preventDefault()
  evt.stopPropagation()
  const form = evt.target
  const fd = new FormData(form)
  let req, rsp = {}
  try {
    req = await fetch(form.action, {
      method: "POST", referrerPolicy: "unsafe-url",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(fd)
    })
    rsp = await req.json()
  } catch (e) {
    console.info('[req4cmt] failed ' + e)
    if (!req){
      evt.submitter.value = '❌'
      return
    }
  }
  const is_ok = req.status == 200 && !rsp.error
  evt.submitter.value = is_ok ? '✅' : '⚠️'
  if (!is_ok) return
  renderItem(form.querySelector('dl'), {
    name: fd.get('x-name'), link: fd.get('x-link'),
    content: fd.get('content'), at: Date.now()
  }, true)
  const ta = form.querySelector('textarea')
  ta.value = ''
  ta.placeholder = 'new comments will appear eventually.\n新评论将稍后刷新'
  setTimeout(load_cmts, 3000, form)
}

async function load_cmts(form){
  let body
  try{
    const rsp = await fetch(form.action + '.jsonl', {headers: {Accept: "application/x-ndjson"}})
    try{
      const ray = rsp.headers.get('cf-ray')
      if (ray){
        form.dataset.req4cmtRay = ray
        const h = form.querySelector('input[name="x-ray"]')
        if (h) h.value = ray
      }
    } catch(e){}
    body = await rsp.text()
  } catch(e) {
    console.info('[req4cmt] failed ' + e)
    return
  }
  const dl = form.querySelector('dl')
  dl.replaceChildren()
  body.split(/\r?\n/).reverse().forEach(line=>{
    try{
      renderItem(dl, JSON.parse(line))
    } catch(e){}
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
  <input type="hidden" name="x-ray">
  <textarea name="content" style="width: 100%; height: 5em"></textarea>
  <input type="submit" value="Go">
  <br/>
  <dl style="white-space: pre-wrap;">
  </dl>
  </form>
</div>`)
  const form = this.nextElementSibling.querySelector('form')
  form.addEventListener('submit', post_cmt)
  await load_cmts(form)
  const submit = form.querySelector('input[type="submit"]')
  'name email link'.split(' ').forEach(k=>{
    submit.insertAdjacentElement('beforebegin', ne('input', {name: `x-${k}`, placeholder: k}))
    submit.insertAdjacentText('beforebegin', ' ')
  })
}
const boot = init.bind(document.currentScript)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}

})()
