/**
 * 注入到 kbview:// 沙箱页面的**页面数据客户端**（docs/html-page-store.md）。
 *
 * 为什么单独一个文件、且零 import：
 * 1. `kbVisualProtocol.ts` 只负责把它塞进 `<head>`；
 * 2. 契约脚本（`.AGENT/scripts/page-store/verify-page-store.mjs`）能直接 import 这段源码，
 *    在假的 window/document 里真跑「读 / 存 / 冲突 / 外部变更」四条路径 —— 这段脚本一旦有语法
 *    或时序错误，表现出来的只是「页面显示请在软件内打开」，没有任何报错可看。
 *
 * 客户端契约（页面作者只需要这四个 API）：
 *   await KbStore.read()        → { exists, data, rev }
 *   KbStore.save(data)           → 1s 防抖自动保存（改一下就存）
 *   await KbStore.write(data)    → 立即写
 *   KbStore.onStatus(cb)         → 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'
 *   KbStore.onChange(cb)         → 别处（AI / 另一个页面）改了这份数据
 *
 * 三条时序细节（错了都不报错）：
 * - 宿主监听器可能比页面脚本晚挂 → 同一条消息按住秒级重发，宿主按 `nonce:id` 去重；
 * - `nonce` 每次文档加载新生成 → 重挂 iframe 后 id 从 1 重来也不会撞上旧回复；
 * - 自己写盘后主进程会广播回来 → 按 rev 比对，忽略自己写的回声，否则界面会被自己的保存刷一遍。
 */

const LINES: string[] = [
  '(function(){',
  'var doc=document,meta=doc.querySelector(\'meta[name="kb-store"]\');',
  'var rel=meta?(meta.getAttribute("content")||"").trim():"";',
  'if(!rel||window.KbStore)return;',
  'var nonce=Math.random().toString(36).slice(2)+Date.now().toString(36);',
  'var seq=0,lastRev=null,pending=null,timer=0,chain=Promise.resolve();',
  'var statusCbs=[],changeCbs=[],host=window.parent;',
  'function emit(s,x){for(var i=0;i<statusCbs.length;i++){try{statusCbs[i](s,x||null)}catch(e){}}}',
  'function send(op,payload){',
  'var id=++seq;',
  'return new Promise(function(resolve,reject){',
  'var tries=0,t=0,done=false;',
  'function finish(fn,v){if(done)return;done=true;window.removeEventListener("message",onMsg);if(t)clearTimeout(t);fn(v)}',
  'function onMsg(e){var d=e.data;if(!d||!d.__kbPageStoreReply||d.__kbPageStoreReply.id!==id)return;finish(resolve,d.__kbPageStoreReply)}',
  'function fire(){',
  'if(done)return;',
  'if(tries++>16){finish(reject,new Error("页面数据通道无响应：请确认页面是在 Phrontis 内打开"));return}',
  'var msg={__kbPageStore:{nonce:nonce,id:id,op:op,rel:rel,data:payload?payload.data:undefined,expectedRev:payload?payload.expectedRev:undefined}};',
  'try{host.postMessage(msg,"*")}catch(err){finish(reject,err);return}',
  't=setTimeout(fire,320)',
  '}',
  'window.addEventListener("message",onMsg);fire()',
  '})',
  '}',
  'function read(){return send("read",null).then(function(r){if(!r.ok)throw new Error(r.error||"读取页面数据失败");lastRev=r.rev||"";return{exists:!!r.exists,data:r.data,rev:lastRev}})}',
  'function writeNow(data){return send("write",{data:data,expectedRev:lastRev===null?undefined:lastRev}).then(function(r){if(r.ok){lastRev=r.rev||lastRev;emit("saved");return r}emit(r.conflict?"conflict":"error",r.error||"");return r})}',
  'function write(data){return writeNow(data).catch(function(err){var m=String(err&&err.message||err);emit("error",m);return{ok:false,error:m}})}',
  'function flush(){if(pending===null)return;var data=pending;pending=null;emit("saving");chain=chain.then(function(){return writeNow(data)}).catch(function(){emit("error","保存失败")})}',
  'function save(data){pending=data;emit("dirty");if(timer)clearTimeout(timer);timer=setTimeout(function(){timer=0;flush()},1000)}',
  'window.addEventListener("message",function(e){var d=e.data;if(!d||!d.__kbPageStoreChanged)return;send("read",null).then(function(r){if(!r.ok)return;if((r.rev||"")===(lastRev||""))return;lastRev=r.rev||"";for(var i=0;i<changeCbs.length;i++){try{changeCbs[i](r.data,lastRev,!!r.exists)}catch(x){}}}).catch(function(){})});',
  'window.KbStore={rel:rel,read:read,write:write,save:save,flush:function(){if(timer){clearTimeout(timer);timer=0}flush()},onStatus:function(cb){if(typeof cb==="function")statusCbs.push(cb)},onChange:function(cb){if(typeof cb==="function")changeCbs.push(cb)},get rev(){return lastRev}};',
  'try{doc.documentElement.setAttribute("data-kb-store","ready")}catch(e){}',
  '})();',
]

/** 可直接内联进 `<head>` 的完整脚本（含 script 标签） */
export const PAGE_STORE_CLIENT_SCRIPT = ['<script>', ...LINES, '<\/script>'].join('\n')

/** 不含标签的函数体 —— 契约脚本用它在假环境里执行 */
export const PAGE_STORE_CLIENT_BODY = LINES.join('\n')
