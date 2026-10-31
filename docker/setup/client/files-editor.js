// A real textarea owns the draft and caret. Its bounded mirror owns the paint;
// no edit, refresh, conflict or close can silently replace an unsaved draft.
const T3FilesEditor=(()=>{
  'use strict';
  const {html,raw,icon}=Kit,F=T3FilesModel,M=T3Model;
  const create=({api,request,refresh,download,context})=>{
    let active=null;
    const dirty=()=>!!active&&active.text!==active.saved;
    const busy=()=>active?.phase==='saving';
    const state=view=>view.phase==='saving'?'Saving…':view.phase==='loading'?'Reading…':dirty()?'Edited, not saved':'Saved';
    const alive=view=>active===view&&!view.layer.closed;
    const rebuild=view=>Object.assign(view,T3CodeText.documentOf(view.text,T3CodeText.language(view.path)));
    const caret=view=>{
      const field=view.layer.panel.querySelector('[data-files-editor-text]');if(!field)return;
      const offset=field.selectionStart;view.selectionStart=offset;view.selectionEnd=field.selectionEnd;let lo=0,hi=view.starts.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(view.starts[mid]<=offset)lo=mid+1;else hi=mid;}
      view.line=Math.max(0,lo-1);view.column=offset-view.starts[view.line]+1;view.scroll=field.scrollTop;view.left=field.scrollLeft;
    };
    const paint=view=>{
      if(!alive(view))return;
      view.layer.render();
      const field=view.layer.panel.querySelector('[data-files-editor-text]');
      if(field){field.readOnly=busy();if(field.value!==view.text){const start=view.selectionStart||0,end=view.selectionEnd||start;field.value=view.text;field.setSelectionRange(Math.min(start,view.text.length),Math.min(end,view.text.length));}}
      const mirror=view.layer.panel.querySelector('[data-editor-mirror]');if(mirror){mirror.scrollTop=view.scroll;mirror.scrollLeft=view.left;}
    };
    const later=view=>{if(view.frame)return;view.frame=requestAnimationFrame(()=>{view.frame=null;paint(view);});};
    const mirror=view=>T3CodeEditor.mirror({...view,height:view.layer?.panel.querySelector('[data-files-editor-text]')?.clientHeight||innerHeight,lineHeight:innerWidth<640?24:22,charWidth:innerWidth<640?9.6:7.8,transform:(text,line)=>view.secret&&!view.reveal&&!(line===view.line&&view.focused)?F.mask(text):text});
    const compare=view=>{
      const theirs=view.conflict?.text||'',mine=view.text,mask=line=>view.secret&&!view.reveal?F.mask(line):line;
      if(view.diff===null)view.diff=BufferlessBytes(theirs)+BufferlessBytes(mine)>128*1024?[{kind:'limit'}]:T3SkillDiff.lines(theirs,mine);
      const limited=view.diff.some(row=>row.kind==='limit');
      return html`<div class="tc-files-compare" data-key="editor:comparison"><div class="tc-ed-bar"><strong>Theirs on disk → Your edit</strong><span class="tc-spacer"></span>${view.secret?html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-editor-reveal>${icon(view.reveal?'eye':'eye-off')}${view.reveal?'Values shown':'Values hidden'}</button>`:''}<button class="tc-btn tc-btn--sm" type="button" data-editor-compare-close>Back to editing</button></div>${limited?html`<div class="tc-files-compare-limit"><p>This file is too large for an inline diff. Both complete versions remain available.</p><div class="tc-seg" role="group" aria-label="Version"><button type="button" data-editor-side="theirs" aria-pressed="${view.side==='theirs'}">Theirs on disk</button><button type="button" data-editor-side="mine" aria-pressed="${view.side==='mine'}">Your edit</button></div><textarea class="tc-input tc-mono" readonly aria-label="${view.side==='theirs'?'Their version':'Your version'}">${(view.side==='theirs'?theirs:mine).split('\n').map(mask).join('\n')}</textarea></div>`:html`<div class="tc-dv-pane" role="region" aria-label="File comparison">${view.diff.length?view.diff.map(hunk=>hunk.kind==='fold'?html`<button class="tc-dv-fold" type="button" data-editor-fold="${hunk.id}">${view.folds.has(hunk.id)?'Hide':'Show'} ${hunk.lines.length} unchanged lines</button>${view.folds.has(hunk.id)?hunk.lines.map(line=>diffLine(line,mask)):''}`:hunk.lines.map(line=>diffLine(line,mask))):html`<p class="tc-hint">Both versions contain the same text.</p>`}</div>`}</div>`;
    };
    const diffLine=(line,mask)=>html`<div class="tc-dv-line" data-k="${line.kind==='added'?'add':line.kind==='removed'?'del':'ctx'}"><span class="n">${line.oldLine||''}</span><span class="n">${line.newLine||''}</span><span class="s">${line.kind==='added'?'+':line.kind==='removed'?'−':' '}</span><code>${mask(line.text)}</code></div>`;
    const body=view=>html`<header class="tc-ed-head"><span class="tc-ftile">${icon(view.secret?'file-key':'file-code')}</span><div><strong id="files-editor-name">${F.basename(view.path)}</strong><small><code>${F.display(view.path,context().roots.home)}</code><span class="tc-sep">·</span><span class="tc-dot ${dirty()?'tc-dot--warn':'tc-dot--ok'}"></span>${state(view)}</small></div><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-editor-close aria-label="Close editor"${busy()?raw(' disabled'):''}>${icon('x')}</button></header>
      ${view.phase==='loading'?html`<div class="tc-files-editor-state" role="status"><span class="tc-spinner"></span>Reading file…</div>`:view.error&&!view.read?html`<div class="tc-files-editor-state" role="alert"><h2>This file can’t be edited here</h2><p>${view.error}</p><button class="tc-btn" type="button" data-editor-retry>Try again</button><button class="tc-btn" type="button" data-editor-download>${icon('download')}Download</button></div>`:view.comparing?compare(view):html`
      <div class="tc-ed-bar"><span>${view.type||'Text'} · UTF-8 · ${view.eol.toUpperCase()} · ${M.plural(view.lines.length,'line')}</span><span class="tc-spacer"></span>${view.secret?html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-editor-reveal>${icon(view.reveal?'eye':'eye-off')}${view.reveal?'Values shown':'Values hidden'}</button>`:''}<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-editor-find>${icon('search')}Find <kbd class="tc-kbd">${T3C.copyKeys.includes('⌘')?'⌘':'Ctrl'}F</kbd></button></div>
      ${view.findOpen?html`<div class="tc-files-editor-find"><label class="tc-sr" for="files-editor-find">Find in file</label><input id="files-editor-find" class="tc-input" value="${view.find}" placeholder="Find in file" autocomplete="off"><span>${view.matches.length?view.match+1+' of '+view.matches.length+(view.capped?'+':''):view.find?'No matches':''}</span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-editor-find-prev aria-label="Previous match">${icon('chevron-up')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-editor-find-next aria-label="Next match">${icon('chevron-down')}</button><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-editor-find-close aria-label="Close find">${icon('x')}</button></div>`:''}
      ${view.conflict?html`<div class="tc-fbanner" data-tone="warn" role="status">${icon('triangle-alert')}<div><strong>${F.basename(view.path)} changed on disk while you were editing</strong><span>Changed outside this editor. Your edit hasn’t been saved yet.</span></div></div>`:''}${view.error?html`<p class="tc-files-editor-message" role="alert">${view.error}</p>`:''}
      <div class="tc-files-editor-workspace" style="--code-gutter:max(3rem, calc(${String(view.lines.length).length}ch + 1.125rem))">${mirror(view)}<textarea wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" class="tc-files-editor-input" data-files-editor-text data-key="files-editor-text" data-keep aria-label="Edit ${F.basename(view.path)}"${busy()?raw(' readonly'):''}></textarea></div>
      <div class="tc-ed-bar tc-files-editor-status" role="status">${view.secret&&!view.reveal?html`${icon('eye-off')}<span>Values stay hidden except on the line you’re editing.</span>`:view.notice?html`<span>${view.notice}</span>`:''}<span class="tc-spacer"></span><span>Line ${view.line+1}, column ${view.column}</span></div>
      <footer class="tc-ed-foot">${view.secret&&view.running?html`<span class="tc-hint">${icon('info')}Apps read this file when they start. Restart the dev server to use new values.</span>`:''}<span class="tc-spacer"></span>${view.conflict?html`<button class="tc-btn tc-btn--ghost" type="button" data-editor-discard${busy()?raw(' disabled'):''}>Discard mine</button><button class="tc-btn" type="button" data-editor-copy${busy()?raw(' disabled'):''}>Save as a copy</button><button class="tc-btn tc-btn--danger" type="button" data-editor-overwrite${busy()?raw(' disabled'):''}>${busy()?html`<span class="tc-spinner"></span>`:''}Overwrite theirs</button><button class="tc-btn tc-btn--primary" type="button" data-editor-compare${busy()?raw(' disabled'):''}>Compare</button>`:html`<button class="tc-btn tc-btn--ghost" type="button" data-editor-discard${busy()||!dirty()?raw(' disabled'):''}>Discard</button><button class="tc-btn tc-btn--primary" type="button" data-editor-save${busy()||!dirty()&&view.exists?raw(' disabled'):''} aria-busy="${busy()}">${busy()?html`<span class="tc-spinner"></span>Saving…`:'Save'} <kbd class="tc-kbd">${T3C.copyKeys.includes('⌘')?'⌘':'Ctrl'}S</kbd></button>`}</footer>`}`;
    const BufferlessBytes=value=>new TextEncoder().encode(value).length;
    const requestClose=async()=>{
      const view=active;if(!view)return true;if(busy()){Kit.announce('Wait for the save to finish.');return false;}
      if(dirty()&&!await Kit.confirm({title:'Discard changes to '+F.basename(view.path)+'?',body:'Your edits haven’t been saved.',confirm:'Discard changes',tone:'danger'}))return false;
      if(alive(view))view.layer.close('close');return true;
    };
    const schedule=view=>{clearTimeout(view.timer);if(alive(view))view.timer=setTimeout(()=>void poll(view),5000);};
    const apply=(view,data)=>{view.read=true;view.text=data.text.replace(/\r\n/g,'\n');view.saved=view.text;view.etag=data.etag;view.eol=data.eol||'lf';view.secret=data.secret||view.secret;view.phase='ready';view.exists=true;view.error='';view.conflict=null;rebuild(view);};
    const load=async view=>{
      const controller=new AbortController();view.controller?.abort();view.controller=controller;
      const response=await api('/files/read?'+new URLSearchParams({path:view.path,edit:'1'}),{signal:controller.signal});if(!alive(view))return;
      if(!response.ok||response.data?.kind!=='text'||typeof response.data.text!=='string'||response.data.truncated){view.phase='error';view.error=response.error||'This is a binary, unsupported or oversized file. Download it instead.';}else apply(view,response.data);
      paint(view);schedule(view);
    };
    const poll=async view=>{
      if(!alive(view))return;if(document.hidden||dirty()||busy()||!view.read){schedule(view);return;}
      const response=await api('/files/read?'+new URLSearchParams({path:view.path,edit:'1'}),{headers:{'If-None-Match':view.etag},signal:view.controller?.signal});
      if(alive(view)&&response.ok&&response.status!==304&&response.data?.kind==='text'&&typeof response.data.text==='string'){apply(view,response.data);view.notice='Reloaded: the file changed on disk';paint(view);}schedule(view);
    };
    const save=async(view,mode='save')=>{
      if(!alive(view)||busy()||!view.read)return;
      if(mode==='overwrite'&&!await Kit.confirm({title:'Overwrite the version on disk?',body:'Your edit will replace the current text. You can save a copy to keep both versions.',confirm:'Overwrite theirs',tone:'danger'}))return;
      view.phase='saving';view.error='';paint(view);
      const text=view.eol==='crlf'?view.text.replace(/\n/g,'\r\n'):view.text,response=await request('write',{path:view.path,text,etag:view.etag,mode:view.exists?mode:'create'},{quiet:true,refresh:false});if(!alive(view))return;
      view.phase='ready';
      if(response.ok&&typeof response.data?.etag==='string'){
        view.path=response.data.path||view.path;view.saved=view.text;view.etag=response.data.etag;view.exists=true;view.conflict=null;view.notice=mode==='copy'?'Saved as '+F.basename(view.path):'Saved';await refresh();Kit.announce(view.notice);
      }else if(response.data?.code==='changed'&&typeof response.data.current?.text==='string'){view.conflict=response.data.current;view.diff=null;}
      else view.error=response.error||'The save could not be confirmed. Check the folder before trying again. Your edit is still here.';
      paint(view);schedule(view);
    };
    const find=view=>{const source=view.text.toLocaleLowerCase(),needle=view.find.toLocaleLowerCase();view.matches=[];view.match=0;view.capped=false;if(needle){let at=0;while((at=source.indexOf(needle,at))>=0){if(view.matches.length>=10000){view.capped=true;break;}view.matches.push(at);at+=Math.max(1,needle.length);}}};
    const selectMatch=(view,delta=0)=>{if(!view.matches.length){paint(view);return;}view.match=(view.match+delta+view.matches.length)%view.matches.length;const field=view.layer.panel.querySelector('[data-files-editor-text]');field.focus();field.setSelectionRange(view.matches[view.match],view.matches[view.match]+view.find.length);caret(view);field.scrollTop=Math.max(0,view.line*(innerWidth<640?24:22)-field.clientHeight/3);caret(view);paint(view);};
    const open=async(value,{create=false}={})=>{
      if(active&&!await requestClose())return;
      const view={path:value,exists:!create,read:create,phase:create?'ready':'loading',text:'',saved:'',etag:null,eol:'lf',secret:false,type:'Text',running:false,error:'',notice:'',line:0,column:1,scroll:0,left:0,lines:[''],starts:[0],reveal:false,findOpen:false,find:'',matches:[],match:0,capped:false,comparing:false,diff:null,side:'mine',folds:new Set(),frame:null,layer:null,controller:null,timer:null};active=view;
      view.layer=Kit.open({kind:'sheet',backdrop:'ignore',panel:{tag:'section',class:'tc-sheet tc-sheet--editor tc-files-editor',role:'dialog','aria-modal':'true','aria-labelledby':'files-editor-name'},render:()=>body(view),onEscape:()=>{if(view.findOpen){view.findOpen=false;paint(view);}else if(view.comparing){view.comparing=false;paint(view);}else void requestClose();},onClose:()=>{clearTimeout(view.timer);cancelAnimationFrame(view.frame);view.controller?.abort();view.text='';view.saved='';view.lines=[];view.conflict=null;if(active===view)active=null;}});
      view.layer.panel.addEventListener('input',event=>{if(event.target.matches('[data-files-editor-text]')){view.text=event.target.value;view.notice='';view.error='';rebuild(view);caret(view);later(view);}if(event.target.id==='files-editor-find'){view.find=event.target.value;find(view);paint(view);}});
      view.layer.panel.addEventListener('scroll',event=>{if(event.target.matches('[data-files-editor-text]')){caret(view);later(view);}},true);
      view.layer.panel.addEventListener('focusin',event=>{view.focused=event.target.matches('[data-files-editor-text]');later(view);});view.layer.panel.addEventListener('focusout',()=>{view.focused=false;later(view);});
      for(const name of ['keyup','pointerup','select'])view.layer.panel.addEventListener(name,event=>{if(event.target.matches('[data-files-editor-text]')){caret(view);later(view);}});
      view.layer.panel.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();void save(view);}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopPropagation();view.findOpen=true;paint(view);view.layer.panel.querySelector('#files-editor-find')?.focus();}if(event.target.id==='files-editor-find'&&event.key==='Enter'){event.preventDefault();selectMatch(view,event.shiftKey?-1:1);}});
      view.layer.panel.addEventListener('click',event=>{
        const target=event.target.closest('button');if(!target)return;
        if(target.hasAttribute('data-editor-close'))void requestClose();
        if(target.hasAttribute('data-editor-save'))void save(view);
        if(target.hasAttribute('data-editor-copy'))void save(view,'copy');
        if(target.hasAttribute('data-editor-overwrite'))void save(view,'overwrite');
        if(target.hasAttribute('data-editor-discard'))void(async()=>{if(!await Kit.confirm({title:'Discard your changes?',body:'The current version on disk will be loaded.',confirm:'Discard changes',tone:'danger'}))return;await load(view);})();
        if(target.hasAttribute('data-editor-retry')){view.phase='loading';view.error='';paint(view);void load(view);}
        if(target.hasAttribute('data-editor-download'))void download(view.path);
        if(target.hasAttribute('data-editor-reveal')){view.reveal=!view.reveal;paint(view);}
        if(target.hasAttribute('data-editor-find')){view.findOpen=!view.findOpen;paint(view);if(view.findOpen)view.layer.panel.querySelector('#files-editor-find')?.focus();}
        if(target.hasAttribute('data-editor-find-close')){view.findOpen=false;paint(view);}
        if(target.hasAttribute('data-editor-find-next'))selectMatch(view,1);
        if(target.hasAttribute('data-editor-find-prev'))selectMatch(view,-1);
        if(target.hasAttribute('data-editor-compare')){view.comparing=true;paint(view);}
        if(target.hasAttribute('data-editor-compare-close')){view.comparing=false;paint(view);}
        if(target.dataset.editorFold){if(view.folds.has(target.dataset.editorFold))view.folds.delete(target.dataset.editorFold);else view.folds.add(target.dataset.editorFold);paint(view);}
        if(target.dataset.editorSide){view.side=target.dataset.editorSide;paint(view);}
      });
      if(!create){const response=await api('/files/details?'+new URLSearchParams({path:value}));if(!alive(view))return;if(response.ok){view.type=response.data.type;view.secret=!!response.data.secret;view.running=response.data.running?.length>0;}else view.secret=true;await load(view);}
      else paint(view);
      if(alive(view))view.layer.panel.querySelector('[data-files-editor-text]')?.focus();
    };
    window.addEventListener('beforeunload',event=>{if(dirty()||busy()){event.preventDefault();event.returnValue='';}});
    return {open,requestClose,dirty,busy,isOpen:()=>!!active};
  };
  return {create};
})();
