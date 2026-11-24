import { EvaluationResult } from '../types';
import { prepareHtmlReport } from './report-presentation';

function escapeHtml(text: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return text.replace(/[&<>"']/g, character => escapes[character]);
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Builds the self-contained, file://-compatible interactive report. */
export function createHtmlReport(result: EvaluationResult): string {
  const { view, download } = prepareHtmlReport(result);
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FOLIO Module Evaluation Report - ${escapeHtml(view.meta.module)}</title>
  <style>
    :root{color-scheme:light;--page:#F5F4EF;--surface:#FFF;--border:#E6E3DA;--line:#EFEDE6;--control:#DCD9CF;--chip:#F0EEE8;--segment:#ECEAE3;--ink:#1B1A17;--ink2:#4A4843;--muted:#77746B;--faint:#9A968C;--accent:#2C5BA8;--sans:"IBM Plex Sans",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace}
    *{box-sizing:border-box}html{overflow-y:scroll;scrollbar-gutter:stable}body{margin:0;overflow-x:clip;background:var(--page);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased}button,input{font:inherit}button{color:inherit}a{color:var(--accent);text-decoration:none}a:hover{color:#1B3F7A;text-decoration:underline}::selection{background:#F4DFA8}
    .layout{max-width:1320px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:flex-start}.sidebar{flex:0 0 272px;position:sticky;top:0;max-height:100vh;overflow:auto;padding:28px 20px 28px 28px;display:flex;flex-direction:column;gap:18px}.main{flex:1 1 480px;min-width:0;padding:28px 28px 64px;display:flex;flex-direction:column;gap:28px}
    .eyebrow,.nav-label,.label{font-family:var(--mono);font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.eyebrow{font-size:11px}.module-name{margin-top:4px;font-size:17px;font-weight:600}.search-wrap{position:relative}.search{width:100%;padding:9px 30px 9px 10px;border:1px solid var(--control);border-radius:7px;background:#fff;color:var(--ink);outline:none;font-size:13px}.search::placeholder{font-size:12px}.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(44,91,168,.12)}.key-hint{position:absolute;right:8px;top:7px;padding:3px 5px;border:1px solid var(--control);border-radius:4px;color:var(--muted);font:500 11px/1 var(--mono)}
    .filters{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;background:var(--segment);border-radius:8px}.filter{border:0;cursor:pointer;text-align:center;padding:6px 4px;border-radius:6px;background:transparent;color:var(--ink2);font-size:12px;font-weight:500}.filter.active{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}.filter-count{font-family:var(--mono);opacity:.7}.jump-list{display:flex;flex-direction:column;gap:14px}.nav-group{display:flex;flex-direction:column;gap:1px}.nav-label{padding:0 8px 6px;font-size:10.5px}.jump{border:0;cursor:pointer;display:grid;grid-template-columns:8px 38px minmax(0,1fr);gap:8px;align-items:center;padding:5px 8px;border-radius:6px;background:transparent;text-align:left}.jump:hover{background:var(--segment)}.jump.selected{background:#E6E4DC}.dot{width:7px;height:7px;border-radius:50%}.jump-id{font:500 11.5px/1 var(--mono);color:var(--ink2)}.jump-title{font-size:12.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.shortcuts{padding-top:12px;border-top:1px solid var(--border);color:var(--muted);font:400 11px/1.7 var(--mono)}
    .report-header{display:flex;flex-direction:column;gap:22px;padding:4px 0 8px}.title-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}h1{margin:0;font-size:34px;line-height:1.1;font-weight:600;letter-spacing:-.02em}.meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;color:var(--ink2);font-size:13px;line-height:1.4}.repo{font:400 12.5px/1.4 var(--mono)}.actions{display:flex;gap:6px}.action{cursor:pointer;padding:7px 11px;border:1px solid var(--control);border-radius:7px;background:#fff;font-size:12.5px;font-weight:500}.action:hover{border-color:#B9B5A9}
    .summary{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border:1px solid var(--border);border-radius:12px;background:#fff}.bar{display:flex;height:10px;overflow:hidden;gap:2px;border-radius:5px;background:var(--chip)}.summary-bottom{display:flex;flex-wrap:wrap;gap:8px 28px;align-items:baseline}.legend{display:flex;align-items:baseline;gap:8px}.legend-dot{width:8px;height:8px;border-radius:2px;align-self:center}.legend-number{font-size:20px;line-height:1;font-weight:600}.legend-number.zero{color:var(--faint)}.legend-label{color:var(--ink2);font-size:13px}.summary-note{margin-left:auto;color:var(--muted);font-size:12.5px;line-height:1.4}
    .group{display:flex;flex-direction:column;gap:10px}.group-heading{display:flex;align-items:baseline;gap:10px;width:100%;padding:0 2px;border:0;background:transparent;cursor:pointer;text-align:left;user-select:none}.chevron{width:11px;height:11px;flex:none;align-self:center;transition:transform .15s}.open>.chevron,.chevron.open{transform:rotate(90deg)}.group-heading h2{margin:0;font-size:17px;line-height:1.2;font-weight:600}.group-count{font:500 12px/1 var(--mono);color:var(--muted)}.group-note{flex:1;min-width:0;color:var(--muted);font-size:13px;line-height:1.4}
    .card{overflow:hidden;border:1px solid var(--border);border-radius:11px;background:#fff;scroll-margin-top:20px}.card.selected{border-color:var(--accent);box-shadow:0 0 0 3px rgba(44,91,168,.12)}.card-toggle{display:grid;grid-template-columns:12px 44px minmax(0,1fr) auto;gap:12px;align-items:start;width:100%;padding:15px 18px;border:0;background:#fff;cursor:pointer;text-align:left;user-select:none}.card-toggle:hover{background:#FBFAF7}.card-toggle .chevron{margin-top:5px}.criterion-id{font:500 12.5px/21px var(--mono);color:var(--ink2)}.card-copy{display:flex;flex-direction:column;gap:3px;min-width:0}.card-title{font-size:14.5px;line-height:21px;font-weight:600}.card-summary{display:-webkit-box;overflow:hidden;color:var(--ink2);font-size:13px;line-height:1.5;overflow-wrap:anywhere;text-wrap:pretty;-webkit-line-clamp:2;-webkit-box-orient:vertical}.badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:260px}.pill,.agent{white-space:nowrap;border-radius:5px;font-family:var(--mono);font-size:11px;line-height:1}.pill{padding:6px 8px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}.agent{padding:5px 7px;border:1px solid;font-weight:500}.card-body{padding:2px 22px 20px 42px;border-top:1px solid var(--line)}.evidence{display:flex;flex-direction:column;gap:5px;padding:14px 0 4px}.label{font-size:11px;line-height:1}.evidence-text{white-space:pre-line;font-size:13.5px;line-height:1.6;overflow-wrap:anywhere;text-wrap:pretty}
    .section-row{display:flex;align-items:center;gap:8px;width:100%;padding:16px 0 6px;border:0;background:transparent;cursor:pointer;text-align:left;user-select:none}.section-row .chevron{width:10px;height:10px}.section-label{font:600 11px/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink2)}.count-chip{padding:3px 6px;border-radius:4px;background:var(--chip);color:var(--muted);font:500 11px/1 var(--mono)}.section-line{flex:1;height:1px;background:var(--line)}.kv{display:grid;grid-template-columns:minmax(110px,190px) minmax(0,1fr);gap:12px;padding:4px 6px;font-size:13.5px;line-height:1.55}.kv-key{color:var(--muted)}.kv-value{overflow-wrap:anywhere;text-wrap:pretty}.item-row{display:grid;grid-template-columns:12px minmax(0,1fr);gap:8px;width:calc(100% - var(--indent));margin-left:var(--indent);padding:4px 6px;border:0;border-radius:6px;background:transparent;text-align:left}.item-row.toggle{cursor:pointer}.item-row:hover{background:#FAF9F5}.item-row .chevron{width:10px;height:10px;margin-top:6px}.leaf{width:4px;height:4px;margin:9px 0 0 3px;border-radius:50%;background:#B9B5A9}.item-copy{display:flex;flex-wrap:wrap;column-gap:8px;row-gap:2px;align-items:baseline;min-width:0;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}.lead{color:var(--accent);font:500 12.5px/1.55 var(--mono)}.tag{padding:1px 6px;border-radius:4px;background:var(--chip);color:#5E5B54;font:500 11px/1.4 var(--mono)}.nested-count{color:var(--muted);font:500 11px/1 var(--mono)}.more-text{color:var(--muted)}.para{padding:10px 0 2px;font-size:13.5px;line-height:1.6;text-wrap:pretty}.link-button,.list-more{border:0;background:transparent;color:var(--accent);cursor:pointer;font-weight:500}.link-button{padding:0;font-size:12.5px}.list-more{padding:4px 6px 4px 26px;font-size:12.5px}.link-button:hover,.list-more:hover{text-decoration:underline}
    .compact{overflow:hidden;border:1px solid var(--border);border-radius:11px;background:#fff}.compact-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:10px 18px 10px 42px;border-top:1px solid var(--line);scroll-margin-top:20px}.compact-row:first-child{border-top:0}.compact-row.selected{box-shadow:inset 3px 0 var(--accent)}.compact-title{font-size:13.5px;line-height:1.4;font-weight:500}.compact-sub{margin-top:2px;color:var(--muted);font-size:12.5px;line-height:1.4}.category{color:var(--muted);font:400 12px/1.4 var(--mono)}.empty{padding:40px;border:1px dashed var(--control);border-radius:12px;color:var(--muted);text-align:center;font-size:14px;line-height:1.5}.footer{padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font:400 12px/1.5 var(--mono)}
    .notes{display:flex;flex-direction:column;gap:10px;padding:6px 0 2px}.note-entry{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#FBFAF7}.note-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:13px;line-height:1.45}.note-id{font:500 12px/1.45 var(--mono);color:var(--ink2)}.note-title{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}.note-select{padding:4px 6px;border:1px solid var(--control);border-radius:6px;background:#fff;font:inherit;font-size:12.5px}.note-text{width:100%;min-height:64px;padding:8px 10px;border:1px solid var(--control);border-radius:6px;background:#fff;color:var(--ink);font:inherit;font-size:13px;line-height:1.5;resize:vertical}.note-text:focus,.note-select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(44,91,168,.12)}.notes-status{color:var(--muted);font-size:12px;line-height:1.4}.notes-status.warn{color:#855700}.review-badge{padding:5px 7px;border:1px solid var(--control);border-radius:5px;color:var(--ink2);font:500 11px/1 var(--mono);white-space:nowrap}.compact-notes{grid-column:2/-1;padding-top:6px}.compact-side{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:baseline}.notes-heading{cursor:default}
    @media(max-width:760px){.layout{display:block}.sidebar{position:relative;max-height:none;width:100%;padding:22px}.main{padding:8px 22px 48px}.jump-list,.shortcuts{display:none}.card-toggle{grid-template-columns:12px 40px minmax(0,1fr)}.badges{grid-column:3;margin-top:5px;justify-content:flex-start}.card-body{padding-left:22px}#c-S009 .kv{grid-template-columns:minmax(100px,40%) minmax(0,1fr)}.summary-note{width:100%;margin-left:0}.compact-row{padding-left:18px}.category{display:none}}
    @media(max-width:480px){#c-S007 .kv,#c-S010 .kv{grid-template-columns:minmax(0,1fr);gap:2px}}
  </style>
</head>
<body>
  <div id="report"></div>
  <script id="report-data" type="application/json">${jsonForHtml(view)}</script>
  <script id="download-data" type="application/json">${jsonForHtml(download)}</script>
  <script>
  (function () {
    'use strict';
    var data = JSON.parse(document.getElementById('report-data').textContent);
    var downloadData = document.getElementById('download-data').textContent;
    var root = document.getElementById('report');
    var tone = {
      pass:{bg:'#E3F1E8',fg:'#1F6B43',dot:'#2E8B57',label:'Pass'},
      manual:{bg:'#FBEFD5',fg:'#855700',dot:'#D39B1E',label:'Manual'},
      fail:{bg:'#FBE3E0',fg:'#A1261D',dot:'#C8392D',label:'Fail'},
      not_applicable:{bg:'#ECEAE4',fg:'#5E5B54',dot:'#9A968C',label:'N/A'}
    };
    var recommendations = {
      likely_sufficient:{fg:'#1F6B43',line:'#B9DCC6',label:'likely sufficient'},
      likely_insufficient:{fg:'#A1261D',line:'#EFC0BA',label:'likely insufficient'},
      needs_reviewer_judgment:{fg:'#855700',line:'#EDD39A',label:'needs judgment'}
    };
    var groupDefs = [
      {key:'review',title:'Needs review',note:'Automated checks ran and produced findings for a reviewer to judge.'},
      {key:'passed',title:'Passed',note:''},
      {key:'not-applicable',title:'Not applicable',note:'These criteria do not apply to this repository.'},
      {key:'human',title:'No automated check',note:'Each of these requires evaluation by a human reviewer.'}
    ];
    var state = {filter:'all',query:'',cards:{},nodes:{},clamps:{},groups:{},notes:{},focus:null,keyboard:false};
    var searchTimer;

    function h(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }
    function focusKey(node, key) { node.dataset.focusKey=key; return node; }
    function chevron(open) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 10 10'); svg.setAttribute('aria-hidden','true');
      svg.setAttribute('class','chevron' + (open ? ' open' : ''));
      var path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M3 1.5 L7 5 L3 8.5'); path.setAttribute('fill','none');
      path.setAttribute('stroke','#77746B'); path.setAttribute('stroke-width','1.6');
      svg.appendChild(path); return svg;
    }

    var items = data.items;
    items.forEach(function (item) { if (item.open) state.cards[item.id] = true; });

    // Reviewer notes are kept in this browser's localStorage, per repository and commit, and leave it only by export.
    var NOTES_FORMAT='tc-module-eval-review-notes';
    var DECISIONS=[['open','Open'],['met','Met'],['not_met','Not met']];
    var NOTE_MAX_LENGTH=20000;
    var notesKey=NOTES_FORMAT+':'+data.meta.repo+'@'+(data.meta.commit||data.meta.evaluatedAt);
    var notes={},notesStored=true,saved=null;
    try{saved=window.localStorage.getItem(notesKey);}catch(error){notesStored=false;}
    try{if(saved)notes=cleanNotes(JSON.parse(saved).notes);}catch(error){notes={};}
    function reviewable(item){return item.status==='manual'||item.status==='fail';}
    function reviewEntries(item){return item.reviewItems.length?item.reviewItems:[{id:item.id,title:'This criterion as a whole'}];}
    function cleanNotes(raw){
      var clean={};if(!raw||typeof raw!=='object')return clean;
      items.forEach(function(item){
        var entries=Object.prototype.hasOwnProperty.call(raw,item.id)&&raw[item.id];if(!reviewable(item)||!entries||typeof entries!=='object')return;
        reviewEntries(item).forEach(function(reviewEntry){
          var entry=Object.prototype.hasOwnProperty.call(entries,reviewEntry.id)&&entries[reviewEntry.id];if(!entry||typeof entry!=='object')return;
          var decision=DECISIONS.some(function(option){return option[0]===entry.decision;})?entry.decision:'open',text=typeof entry.text==='string'?entry.text.slice(0,NOTE_MAX_LENGTH):'';
          if(decision==='open'&&!text.trim())return;
          (clean[item.id]=clean[item.id]||{})[reviewEntry.id]={decision:decision,text:text,updatedAt:typeof entry.updatedAt==='string'?entry.updatedAt:''};
        });
      });
      return clean;
    }
    function notesStatusText(){return notesStored?'Reviewer notes are saved in this browser for this commit. Export them to share them or keep a copy.':'This browser cannot save reviewer notes. Export them before closing the page.';}
    function shownEntry(criterionId,entryId){var item=items.find(function(candidate){return candidate.id===criterionId;});return !!item&&reviewable(item)&&reviewEntries(item).some(function(entry){return entry.id===entryId;});}
    // A report of the same commit with other criteria shares the record, so its entries that this report does not show are kept.
    function allNotes(){
      var merged=Object.create(null),stored={};
      try{var record=JSON.parse(window.localStorage.getItem(notesKey)||'null');if(record&&record.notes&&typeof record.notes==='object')stored=record.notes;}catch(error){stored={};}
      var add=function(criterionId,entryId,entry){(merged[criterionId]=merged[criterionId]||Object.create(null))[entryId]=entry;};
      Object.keys(stored).forEach(function(criterionId){var entries=stored[criterionId];if(!entries||typeof entries!=='object')return;
        Object.keys(entries).forEach(function(entryId){if(entries[entryId]&&typeof entries[entryId]==='object'&&!shownEntry(criterionId,entryId))add(criterionId,entryId,entries[entryId]);});});
      Object.keys(notes).forEach(function(criterionId){Object.keys(notes[criterionId]).forEach(function(entryId){add(criterionId,entryId,notes[criterionId][entryId]);});});
      return merged;
    }
    function saveNotes(){
      try{window.localStorage.setItem(notesKey,JSON.stringify({format:NOTES_FORMAT,version:1,module:data.meta.module,repo:data.meta.repo,commit:data.meta.commit||null,notes:allNotes()}));notesStored=true;}catch(error){notesStored=false;}
      var status=document.querySelector('.notes-status');if(status){status.textContent=notesStatusText();status.className='notes-status'+(notesStored?'':' warn');}
    }
    function setNote(item,entryId,change){
      var entry=Object.assign({decision:'open',text:''},notes[item.id]&&notes[item.id][entryId],change,{updatedAt:new Date().toISOString()});
      if(entry.decision==='open'&&!entry.text.trim()){if(notes[item.id]){delete notes[item.id][entryId];if(!Object.keys(notes[item.id]).length)delete notes[item.id];}}
      else (notes[item.id]=notes[item.id]||{})[entryId]=entry;
      saveNotes();refreshReviewBadges(item);
    }
    function reviewSummary(item){
      var entries=reviewEntries(item),recorded=notes[item.id]||{};if(!Object.keys(recorded).length)return '';
      return 'notes · '+entries.filter(function(entry){return recorded[entry.id]&&recorded[entry.id].decision!=='open';}).length+'/'+entries.length+' decided';
    }
    function reviewBadge(item){var badge=h('span','review-badge',reviewSummary(item));badge.dataset.reviewBadge=item.id;badge.hidden=!badge.textContent;return badge;}
    function refreshReviewBadges(item){document.querySelectorAll('[data-review-badge]').forEach(function(badge){if(badge.dataset.reviewBadge===item.id){badge.textContent=reviewSummary(item);badge.hidden=!badge.textContent;}});}
    function renderNotes(parent,item){
      var wrap=h('div','notes');
      reviewEntries(item).forEach(function(entry){
        var current=(notes[item.id]&&notes[item.id][entry.id])||{decision:'open',text:''},box=h('div','note-entry'),head=h('div','note-head');
        if(entry.id!==item.id)head.appendChild(h('span','note-id',entry.id));
        head.appendChild(h('span','note-title',entry.title));
        var select=h('select','note-select');select.setAttribute('aria-label','Decision for '+entry.id);focusKey(select,'note-decision-'+item.id+'-'+entry.id);
        DECISIONS.forEach(function(option){var node=h('option','',option[1]);node.value=option[0];select.appendChild(node);});select.value=current.decision;
        select.addEventListener('change',function(){setNote(item,entry.id,{decision:select.value});});
        var text=h('textarea','note-text');text.maxLength=NOTE_MAX_LENGTH;text.value=current.text;text.placeholder='Evidence checked, what it showed, and what remains open';text.setAttribute('aria-label','Notes for '+entry.id);focusKey(text,'note-text-'+item.id+'-'+entry.id);
        text.addEventListener('input',function(){setNote(item,entry.id,{text:text.value});});
        head.appendChild(select);box.append(head,text);wrap.appendChild(box);
      });
      parent.appendChild(wrap);
    }
    function downloadFile(text,fileName){var blob=new Blob([text],{type:'application/json'});var url=URL.createObjectURL(blob);var link=document.createElement('a');link.href=url;link.download=fileName;link.click();setTimeout(function(){URL.revokeObjectURL(url);},0);}
    function importNotesFile(file){
      file.text().then(function(text){
        var parsed;try{parsed=JSON.parse(text);}catch(error){window.alert(file.name+' is not valid JSON.');return;}
        if(!parsed||parsed.format!==NOTES_FORMAT){window.alert(file.name+' is not a reviewer notes export from this report.');return;}
        if((parsed.repo!==data.meta.repo||(parsed.commit||null)!==(data.meta.commit||null))
          &&!window.confirm('These notes were exported for '+String(parsed.repo)+' at commit '+String(parsed.commit||'unknown').slice(0,12)+', not this report. Import them anyway?'))return;
        var incoming=cleanNotes(parsed.notes);
        Object.keys(incoming).forEach(function(criterionId){Object.keys(incoming[criterionId]).forEach(function(entryId){(notes[criterionId]=notes[criterionId]||{})[entryId]=incoming[criterionId][entryId];});});
        saveNotes();render();
      });
    }

    function visible() {
      var query = state.query.trim().toLowerCase();
      return items.filter(function (item) {
        return (state.filter === 'all' || item.triage === state.filter) && (!query || item.search.indexOf(query) >= 0);
      });
    }
    function grouped(list) {
      return groupDefs.map(function (group) {
        return {def:group,items:list.filter(function (item) { return item.triage === group.key; })};
      }).filter(function (group) { return group.items.length; });
    }
    function countsByStatus() {
      var counts = {pass:0,fail:0,manual:0,not_applicable:0};
      items.forEach(function (item) { counts[item.status] = (counts[item.status] || 0) + 1; });
      return counts;
    }
    function countTriage(key) { return items.filter(function (item) { return item.triage === key; }).length; }
    function setFocus(id, keyboard) { state.focus=id; state.keyboard=keyboard; }
    function scrollToCard(id) {
      requestAnimationFrame(function () {
        var target=document.getElementById('c-'+id);
        if (target) window.scrollTo({top:target.getBoundingClientRect().top+window.scrollY-20,behavior:'smooth'});
      });
    }
    function jump(id) {
      var item=items.find(function (candidate) { return candidate.id===id; });
      setFocus(id,true); state.groups[item.triage]=false;
      if (item.triage !== 'human') state.cards[id]=true;
      render(); scrollToCard(id);
    }

    function renderSidebar(layout, groups) {
      var aside=h('aside','sidebar');
      var identity=h('div'); identity.append(h('div','eyebrow','FOLIO Module Evaluation'),h('div','module-name',data.meta.module)); aside.appendChild(identity);
      var searchWrap=h('div','search-wrap'); var search=h('input','search'); search.type='search'; search.placeholder='Search report'; search.value=state.query; search.setAttribute('aria-label','Search criteria and evidence');
      focusKey(search,'search');
      search.addEventListener('input',function (event) {
        state.query=event.target.value; clearTimeout(searchTimer);
        searchTimer=setTimeout(function () { searchTimer=null; render(); },75);
      });
      searchWrap.append(search,h('span','key-hint','/')); aside.appendChild(searchWrap);
      var filterWrap=h('div','filters');
      [['all','All',items.length],['review','Review',countTriage('review')],['passed','Passed',countTriage('passed')],['human','No check',countTriage('human')]].forEach(function (entry) {
        var button=h('button','filter'+(state.filter===entry[0]?' active':'')); button.type='button'; button.append(document.createTextNode(entry[1]+' '),h('span','filter-count',String(entry[2])));
        focusKey(button,'filter-'+entry[0]);
        button.setAttribute('aria-pressed',String(state.filter===entry[0])); button.addEventListener('click',function () { state.filter=entry[0]; state.focus=null; render(); }); filterWrap.appendChild(button);
      });
      aside.appendChild(filterWrap);
      var nav=h('nav','jump-list'); nav.setAttribute('aria-label','Visible criteria');
      groups.forEach(function (group) {
        var block=h('div','nav-group'); block.appendChild(h('div','nav-label',group.def.title));
        group.items.forEach(function (item) {
          var button=h('button','jump'+(state.focus===item.id&&state.keyboard?' selected':'')); button.type='button';
          focusKey(button,'jump-'+item.id);
          var dot=h('span','dot'); dot.style.background=(tone[item.status]||tone.not_applicable).dot;
          button.append(dot,h('span','jump-id',item.id),h('span','jump-title',item.title)); button.title=item.title; button.addEventListener('click',function () { jump(item.id); }); block.appendChild(button);
        }); nav.appendChild(block);
      });
      aside.append(nav,h('div','shortcuts','/ search · j k move · o open')); layout.appendChild(aside);
    }

    function renderHeader(main) {
      var header=h('header','report-header'); var titleRow=h('div','title-row'); var titleBlock=h('div'); titleBlock.appendChild(h('h1','',data.meta.module));
      var meta=h('div','meta'); meta.appendChild(h('span','',data.meta.language)); var repo=h('a','repo',data.meta.repo.replace(/^https?:\/\//,'')); repo.href=data.meta.repo; repo.target='_blank'; repo.rel='noopener noreferrer'; focusKey(repo,'repo'); meta.append(repo,h('span','','Evaluated '+data.meta.evaluatedAt));if(data.meta.commit)meta.appendChild(h('span','repo','Commit '+data.meta.commit.slice(0,12)));if(data.meta.evaluator)meta.appendChild(h('span','','Evaluator '+data.meta.evaluator.name+' '+data.meta.evaluator.version));if(data.meta.agentReviewModel)meta.appendChild(h('span','repo','Agent '+data.meta.agentReviewModel));if(data.meta.agentReviewCost)meta.appendChild(h('span','','Agent cost '+data.meta.agentReviewCost));titleBlock.appendChild(meta);
      var actions=h('div','actions');var download=h('button','action','Download JSON');download.type='button';focusKey(download,'download-json');download.addEventListener('click',function(){downloadFile(downloadData,data.meta.module+'-evaluation.json');});
      var exportNotes=h('button','action','Export notes');exportNotes.type='button';focusKey(exportNotes,'export-notes');exportNotes.addEventListener('click',function(){downloadFile(JSON.stringify({format:NOTES_FORMAT,version:1,module:data.meta.module,repo:data.meta.repo,commit:data.meta.commit||null,exportedAt:new Date().toISOString(),notes:allNotes()},null,2),data.meta.module+'-review-notes.json');});
      var notesFile=h('input');notesFile.type='file';notesFile.accept='application/json,.json';notesFile.hidden=true;notesFile.addEventListener('change',function(){var file=notesFile.files&&notesFile.files[0];notesFile.value='';if(file)importNotesFile(file);});
      var importNotes=h('button','action','Import notes');importNotes.type='button';focusKey(importNotes,'import-notes');importNotes.addEventListener('click',function(){notesFile.click();});var expand=h('button','action','Expand criteria'); expand.type='button'; focusKey(expand,'expand-all'); expand.addEventListener('click',function () { items.forEach(function (item) { if(item.triage!=='human') state.cards[item.id]=true; }); state.groups={}; render(); });
      var collapse=h('button','action','Collapse criteria'); collapse.type='button'; focusKey(collapse,'collapse-all'); collapse.addEventListener('click',function () { state.cards={}; state.nodes={}; render(); }); actions.append(download,exportNotes,importNotes,notesFile,expand,collapse); titleRow.append(titleBlock,actions); header.appendChild(titleRow);
      if(items.some(reviewable))header.appendChild(h('div','notes-status'+(notesStored?'':' warn'),notesStatusText()));
      var summary=h('div','summary'); var bar=h('div','bar'); var counts=countsByStatus(); var total=items.length || 1;
      ['pass','fail','manual','not_applicable'].forEach(function (key) { if (!counts[key]) return; var segment=h('div'); segment.style.width=(counts[key]/total*100)+'%'; segment.style.background=tone[key].dot; bar.appendChild(segment); }); summary.appendChild(bar);
      var bottom=h('div','summary-bottom'); [['pass','Passed'],['fail','Failed'],['manual','Manual review'],['not_applicable','Not applicable']].forEach(function (entry) {
        var legend=h('div','legend'); var square=h('span','legend-dot'); square.style.background=tone[entry[0]].dot; var number=h('span','legend-number'+(counts[entry[0]]?'':' zero'),String(counts[entry[0]]||0)); legend.append(square,number,h('span','legend-label',entry[1])); bottom.appendChild(legend);
      }); bottom.appendChild(h('span','summary-note',items.length+(items.length===1?' criterion · ':' criteria · ')+countTriage('review')+' with automated findings · '+countTriage('human')+' without an automated check')); summary.appendChild(bottom); header.appendChild(summary); main.appendChild(header);
    }

    function clampedText(container,text,key,showFullText) {
      if(showFullText){container.appendChild(document.createTextNode(text));return;}
      var expanded=!!state.clamps[key],limit=220; container.appendChild(document.createTextNode(text.length>limit&&!expanded?text.slice(0,limit).trimEnd()+'…':text));
      if(text.length>limit){container.appendChild(document.createTextNode(' '));var more=h('button','link-button',expanded?'less':'more');more.type='button';focusKey(more,'clamp-'+key);more.addEventListener('click',function(event){event.stopPropagation();state.clamps[key]=!expanded;render();});container.appendChild(more);}
    }
    function renderNodes(parent,nodes,depth,prefix,hidden,uncapped) {
      var cap=6,moreKey=prefix+'#more',showAll=!!state.nodes[moreKey]; var list=!showAll&&!uncapped&&depth>0&&nodes.length>cap+2?nodes.slice(0,cap):nodes;
      list.forEach(function (node,index) {
        var key=prefix+'/'+index,expandable=node.children.length>0||!!node.hidden; var isOpen=Object.prototype.hasOwnProperty.call(state.nodes,key)?state.nodes[key]:!!node.open;var indent=Math.max(0,depth-1)*22;
        if(node.kind==='section'){var section=h('button','section-row');section.type='button';focusKey(section,'node-'+key);section.setAttribute('aria-expanded',String(isOpen));section.append(chevron(isOpen),h('span','section-label',node.text));if(node.count)section.appendChild(h('span','count-chip',node.count));section.appendChild(h('span','section-line'));section.addEventListener('click',function(){state.nodes[key]=!isOpen;render();});parent.appendChild(section);}
        else if(node.kind==='paragraph')parent.appendChild(h('div','para',node.text));
        else if(node.kind==='field'){var kv=h('div','kv');if(depth>0)kv.style.marginLeft=indent+'px';kv.append(h('span','kv-key',node.key));var value=h('span','kv-value');clampedText(value,node.text,key,node.fullText);kv.appendChild(value);parent.appendChild(kv);}
        else {var item=h(expandable?'button':'div','item-row'+(expandable?' toggle':''));if(expandable){item.type='button';focusKey(item,'node-'+key);}item.style.setProperty('--indent',indent+'px');item.appendChild(expandable?chevron(isOpen):h('span','leaf'));var copy=h('span','item-copy');if(node.lead){var lead=h(node.href?'a':'span','lead',node.lead);if(node.href){lead.href=node.href;lead.target='_blank';lead.rel='noopener noreferrer';lead.addEventListener('click',function(event){event.stopPropagation();});}copy.appendChild(lead);}if(node.tag)copy.appendChild(h('span','tag',node.tag));var body=h('span','');clampedText(body,node.text,key);copy.appendChild(body);if(node.count)copy.appendChild(h('span','nested-count',node.count));item.appendChild(copy);if(expandable){item.setAttribute('aria-expanded',String(isOpen));item.addEventListener('click',function(){state.nodes[key]=!isOpen;render();});}parent.appendChild(item);}
        if(expandable&&isOpen)renderNodes(parent,node.children,depth+1,key,node.hidden,node.showAll);
      });
      if(hidden){var omitted=h('div','item-row');omitted.style.setProperty('--indent',Math.max(0,depth-1)*22+'px');omitted.append(h('span','leaf'),h('span','more-text',hidden+' more not included in the report'));parent.appendChild(omitted);}
      if(list.length<nodes.length){var show=h('button','list-more','Show '+(nodes.length-list.length)+' more');show.type='button';focusKey(show,'more-'+moreKey);show.addEventListener('click',function(){state.nodes[moreKey]=true;render();});parent.appendChild(show);}else if(showAll){var fewer=h('button','list-more','Show fewer');fewer.type='button';focusKey(fewer,'more-'+moreKey);fewer.addEventListener('click',function(){state.nodes[moreKey]=false;render();});parent.appendChild(fewer);}
    }

    function renderCard(group,item) {
      var open=!!state.cards[item.id],selected=state.focus===item.id&&state.keyboard,t=item.status in tone?tone[item.status]:tone.not_applicable;
      var card=h('article','card'+(selected?' selected':''));card.id='c-'+item.id;var toggle=h('button','card-toggle');toggle.type='button';focusKey(toggle,'card-'+item.id);toggle.setAttribute('aria-expanded',String(open));toggle.append(chevron(open),h('span','criterion-id',item.id));
      var copy=h('span','card-copy');copy.append(h('span','card-title',item.title),h('span','card-summary',item.description||item.evidence));toggle.appendChild(copy);var badges=h('span','badges');var rec=recommendations[item.recommendation];if(rec){var agent=h('span','agent','agent · '+rec.label);agent.style.color=rec.fg;agent.style.borderColor=rec.line;badges.appendChild(agent);}if(reviewable(item))badges.appendChild(reviewBadge(item));var pill=h('span','pill',t.label);pill.style.background=t.bg;pill.style.color=t.fg;badges.appendChild(pill);toggle.appendChild(badges);
      toggle.addEventListener('click',function(){setFocus(item.id,false);state.cards[item.id]=!open;render();});card.appendChild(toggle);
      if(open){var body=h('div','card-body');var evidence=h('div','evidence');evidence.append(h('div','label','Evidence'),h('div','evidence-text',item.evidence));body.appendChild(evidence);renderNodes(body,item.tree,0,item.id);if(reviewable(item)){var notesHeading=h('div','section-row notes-heading');notesHeading.append(h('span','section-label','Reviewer notes'),h('span','section-line'));body.appendChild(notesHeading);renderNotes(body,item);}card.appendChild(body);}return card;
    }
    function renderGroup(main,group) {
      var section=h('section','group');var closed=!!state.groups[group.def.key];var heading=h('button','group-heading');heading.type='button';focusKey(heading,'group-'+group.def.key);heading.setAttribute('aria-expanded',String(!closed));heading.append(chevron(!closed),h('h2','',group.def.title),h('span','group-count',String(group.items.length)),h('span','group-note',group.def.note));heading.addEventListener('click',function(){state.groups[group.def.key]=!closed;render();});section.appendChild(heading);
      if(!closed&&group.def.key==='human'){var compact=h('div','compact');group.items.forEach(function(item){var row=h('div','compact-row'+(state.focus===item.id&&state.keyboard?' selected':''));row.id='c-'+item.id;row.appendChild(h('span','criterion-id',item.id));var copy=h('div');copy.appendChild(h('div','compact-title',item.title));if(item.subtitle)copy.appendChild(h('div','compact-sub',item.subtitle));var side=h('span','compact-side');side.append(h('span','category',item.category),reviewBadge(item));var notesOpen=!!state.notes[item.id];var notesToggle=h('button','link-button notes-toggle',notesOpen?'Hide notes':'Notes');notesToggle.type='button';focusKey(notesToggle,'notes-'+item.id);notesToggle.setAttribute('aria-expanded',String(notesOpen));notesToggle.addEventListener('click',function(){state.notes[item.id]=!notesOpen;render();});side.appendChild(notesToggle);row.append(copy,side);if(notesOpen){var notesCell=h('div','compact-notes');renderNotes(notesCell,item);row.appendChild(notesCell);}compact.appendChild(row);});section.appendChild(compact);}
      else if(!closed)group.items.forEach(function(item){section.appendChild(renderCard(group,item));});main.appendChild(section);
    }

    function render() {
      var active=document.activeElement,activeKey=active&&active.dataset?active.dataset.focusKey:null;
      var selection=activeKey==='search'?{start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:null;
      var list=visible(),groups=grouped(list);root.replaceChildren();var layout=h('div','layout');renderSidebar(layout,groups);var main=h('main','main');renderHeader(main);if(!groups.length)main.appendChild(h('div','empty','No criteria match “'+state.query+'”.'));else groups.forEach(function(group){renderGroup(main,group);});main.appendChild(h('footer','footer','Generated by FOLIO Module Evaluator · Report created on '+data.meta.createdAt));layout.appendChild(main);root.appendChild(layout);
      if(activeKey){var replacement=Array.from(document.querySelectorAll('[data-focus-key]')).find(function(node){return node.dataset.focusKey===activeKey;});if(replacement){replacement.focus();if(selection)replacement.setSelectionRange(selection.start,selection.end,selection.direction);}}
    }
    function move(direction) {
      var order={};groupDefs.forEach(function(group,index){order[group.key]=index;});var list=visible().filter(function(item){return !state.groups[item.triage];}).sort(function(a,b){return order[a.triage]-order[b.triage];});if(!list.length)return;var index=list.findIndex(function(item){return item.id===state.focus;});var next=list[Math.max(0,Math.min(list.length-1,index<0?0:index+direction))];setFocus(next.id,true);render();scrollToCard(next.id);
    }
    window.addEventListener('keydown',function(event){var typing=/INPUT|TEXTAREA/.test(event.target.tagName);if(event.key==='Escape'&&typing){clearTimeout(searchTimer);searchTimer=null;event.target.blur();render();return;}var interactive=event.target.closest&&event.target.closest('a,button,input,textarea,select,[contenteditable="true"]');if(interactive||event.metaKey||event.ctrlKey||event.altKey)return;if(event.key==='/'){event.preventDefault();document.querySelector('.search').focus();}else if(event.key==='j'||event.key==='k'){event.preventDefault();move(event.key==='j'?1:-1);}else if((event.key==='o'||event.key==='Enter')&&state.focus){event.preventDefault();var item=items.find(function(candidate){return candidate.id===state.focus;});if(item&&item.triage!=='human'){state.cards[item.id]=!state.cards[item.id];render();}}});
    render();
  }());
  </script>
</body>
</html>`;
}
