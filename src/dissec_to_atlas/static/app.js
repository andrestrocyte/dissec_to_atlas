'use strict';
const $ = id => document.getElementById(id);
const CW=720, CH=520;
const state={project:null,atlas:null,slideId:null,slides:{},mode:'select',selectedAnnotation:null,
  draftPolygon:[],dirty:false,scope:'current',undo:[],redo:[],editVersion:0,loading:false};
let sourceImage=new Image(),atlasImage=new Image(),atlasUrl=null,renderTimer=null,saveTimer=null;
let slideRequest=0,planeRequest=0,saveInFlight=null,dragVertex=null,cropStart=null;
let currentSnapshot=null,summaryPending=0,suppressClick=false;
const clone=x=>JSON.parse(JSON.stringify(x));
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function blankSlide(){return {crop:null,apIndex:null,yaw:0,pitch:0,hemisphere:'both',flipped:false,opacity:.45,manual:{tx:0,ty:0,rotation:0,scale:1},autoWarp:null,landmarks:{source:[],atlas:[]},annotations:[],reviewed:false,registrationStatus:'unreviewed'};}
function S(){return state.slides[state.slideId]??(state.slides[state.slideId]=blankSlide());}
function snapshot(){return JSON.stringify({slides:state.slides,active_slide:state.slideId});}
function historyPoint(){const now=snapshot();if(currentSnapshot&&now!==currentSnapshot){state.undo.push(currentSnapshot);if(state.undo.length>60)state.undo.shift();state.redo=[];}currentSnapshot=now;updateTools();}
function changed({review=true,history=true}={}){
  if(review){S().reviewed=false;S().registrationStatus='unreviewed';$('reviewToggle').checked=false;}
  if(history)historyPoint();
  state.editVersion++;state.dirty=true;setStatus('Changes pending…');cacheDraft();queueSave();renderLists();
}
function setStatus(text,error=false){$('saveStatus').textContent=text;$('saveStatus').classList.toggle('error',error);}
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
function fail(e){console.error(e);toast(e.message||String(e));}
function safely(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(fail);}
async function api(url,options={}){const r=await fetch(url,options);if(!r.ok){const data=await r.json().catch(()=>({detail:r.statusText}));throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));}return r;}
function body(data){return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};}
function cacheKey(){return `dissec-draft-v2:${state.project.project_id}`;}
function payload(){return {app_version:'0.2.0',project_id:state.project.project_id,atlas:state.atlas,
  source_provenance:Object.fromEntries(state.project.slides.map(s=>[s.id,{display_sha256:s.sha256,source_files:s.source_file_records||[]}])),
  slides:clone(state.slides),active_slide:state.slideId};}
function cacheDraft(){try{localStorage.setItem(cacheKey(),JSON.stringify({updated_at:new Date().toISOString(),state:payload(),draft:state.draftPolygon,draft_slide:state.slideId,dirty:state.dirty}));}catch{setStatus('Browser backup unavailable; saving to disk',true);}}
function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>save(true).catch(e=>{setStatus('Save failed — retry Save checkpoint',true);fail(e);}),1800);}
async function save(automatic=false){
  clearTimeout(saveTimer);
  if(saveInFlight){await saveInFlight;if(automatic&&!state.dirty)return;}
  if(automatic&&(!state.dirty||state.loading))return;
  const version=state.editVersion,savePayload=payload();
  const label=automatic?'autosave':($('revisionLabel').value.trim()||'manual_review');
  setStatus('Saving…');
  saveInFlight=(async()=>{
    const out=await(await api('/api/revisions',body({state:savePayload,label}))).json();
    if(state.editVersion===version){state.dirty=false;setStatus(`${automatic?'Autosaved':'Saved'} ${new Date(out.saved_at).toLocaleTimeString()}`);}
    else{setStatus('New changes pending…');queueSave();}
    cacheDraft();if(!automatic)toast('Checkpoint saved. Earlier revisions remain in History.');
  })();
  try{await saveInFlight;}finally{saveInFlight=null;}
}
function normalizeSlides(saved){
  const normalized={};
  for(const [id,value] of Object.entries(saved||{})){
    // Keep unknown older section IDs intact so historical work is never discarded.
    const s={...blankSlide(),...value};s.manual={...blankSlide().manual,...s.manual};s.landmarks={source:[],atlas:[],...s.landmarks};
    s.annotations=(s.annotations||[]).map(a=>({...a,id:a.id||crypto.randomUUID(),regions:a.regions||[]}));normalized[id]=s;
  }return normalized;
}
async function init(){
  state.project=await(await api('/api/project')).json();state.atlas=await(await api('/api/atlas/info')).json();
  if(!state.project.slides.length)throw Error('This project has no sections.');
  $('apSlider').max=$('apNumber').max=state.atlas.shape[0]-1;$('apNumber').min=0;
  const revisions=await(await api('/api/revisions')).json();let record=null;
  if(revisions.length)record=await(await api(`/api/revisions/${encodeURIComponent(revisions[0].filename)}`)).json();
  let cached=null;try{cached=JSON.parse(localStorage.getItem(cacheKey()));}catch{/* no usable local backup */}
  const recover=cached?.dirty&&(!record||Date.parse(cached.updated_at)>Date.parse(record.saved_at));
  if(recover){state.slides=normalizeSlides(cached.state.slides);state.dirty=true;setStatus('Recovered browser draft — saving…');}
  else if(record){state.slides=normalizeSlides(record.state.slides);setStatus(`Opened ${record.label} · ${new Date(record.saved_at).toLocaleString()}`);}
  else setStatus('New project · changes save automatically');
  const previous=(recover?cached.state:record?.state)?.active_slide;
  const id=state.project.slides.some(s=>s.id===previous)?previous:state.project.slides[0].id;
  await selectSlide(id);currentSnapshot=snapshot();
  if(cached?.draft?.length&&cached.draft_slide===id){state.draftPolygon=cached.draft;setMode('polygon');toast('Recovered unfinished polygon. Finish it or Cancel drawing.');drawAnnotations();}
  if(recover)queueSave();
  if(record)checkProvenance(record.state);
}
function checkProvenance(saved){const mismatches=state.project.slides.filter(s=>saved.source_provenance?.[s.id]?.display_sha256&&saved.source_provenance[s.id].display_sha256!==s.sha256);if(mismatches.length){setStatus('Source image changed — review alignment',true);toast(`Source hash mismatch: ${mismatches.map(s=>s.id).join(', ')}`);}}
async function selectSlide(id){
  if(!state.project.slides.some(s=>s.id===id)){toast('This saved section is absent from the current manifest. Its data remains in History and exports.');return;}
  if(state.draftPolygon.length&&id!==state.slideId){toast('Finish or cancel the polygon before changing section.');$('slideSelect').value=state.slideId;return;}
  clearTimeout(renderTimer);const request=++slideRequest;++planeRequest;state.loading=true;state.slideId=id;state.selectedAnnotation=null;dragVertex=null;cropStart=null;state.pendingCrop=null;
  setMode('select');const meta=state.project.slides.find(s=>s.id===id),s=S();
  if(s.apIndex==null)s.apIndex=meta.atlas_ap_index_hint??Math.floor(state.atlas.shape[0]/2);
  $('slideMeta').textContent=`${meta.tissue_pieces.length} expected pieces${meta.source_atlas_plate_hints?.length?' · ARA '+meta.source_atlas_plate_hints.join('/'):''}${meta.notes?' · '+meta.notes:''}`;
  $('pieceSelect').innerHTML=meta.tissue_pieces.map(p=>`<option value="${esc(p.code)}">${esc(p.code)}</option>`).join('');
  $('autoResult').textContent='';syncControls();renderLists();
  const img=new Image();img.src=`/api/slides/${encodeURIComponent(id)}/image`;
  try{await img.decode();if(request!==slideRequest)return;sourceImage=img;drawSource();await loadAtlas();}
  finally{if(request===slideRequest){state.loading=false;updateTools();}}
  if(request!==slideRequest)return;
  currentSnapshot=snapshot();renderLists();drawAnnotations();
}
function syncControls(){const s=S();for(const id of ['yaw','pitch','hemisphere','opacity'])$(id).value=s[id];$('apSlider').value=$('apNumber').value=s.apIndex;$('sourceFlip').checked=s.flipped;$('reviewToggle').checked=s.reviewed;for(const id of ['tx','ty','rotation','scale'])$(id).value=s.manual[id];updateApLabel();}
function updateApLabel(){$('apUm').textContent=`${Math.round(S().apIndex*state.atlas.resolution_um[0])} µm from anterior`;}
function canvasPoint(canvas,e){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(CW,(e.clientX-r.left)*CW/r.width)),y:Math.max(0,Math.min(CH,(e.clientY-r.top)*CH/r.height))};}
function fitRect(iw,ih,cw=CW,ch=CH){const k=Math.min(cw/iw,ch/ih);return{x:(cw-iw*k)/2,y:(ch-ih*k)/2,w:iw*k,h:ih*k,k};}
function sourceGeometry(){const crop=S().crop||[0,0,sourceImage.naturalWidth||CW,sourceImage.naturalHeight||CH];return {crop,fit:fitRect(crop[2],crop[3])};}
function sourceCanvasToImage(p){const {crop,fit}=sourceGeometry();let x=(p.x-fit.x)/fit.k;if(S().flipped)x=crop[2]-x;return{x:crop[0]+x,y:crop[1]+(p.y-fit.y)/fit.k};}
function imageToSourceCanvas(p){const {crop,fit}=sourceGeometry();let x=p.x-crop[0];if(S().flipped)x=crop[2]-x;return{x:fit.x+x*fit.k,y:fit.y+(p.y-crop[1])*fit.k};}
function drawSource(){if(!sourceImage.naturalWidth)return;const ctx=$('sourceCanvas').getContext('2d'),s=S(),{crop,fit}=sourceGeometry();ctx.fillStyle='#161a19';ctx.fillRect(0,0,CW,CH);ctx.save();if(s.flipped){ctx.translate(CW,0);ctx.scale(-1,1);}ctx.drawImage(sourceImage,...crop,fit.x,fit.y,fit.w,fit.h);ctx.restore();const o=$('sourceOverlay').getContext('2d');o.clearRect(0,0,CW,CH);if(state.pendingCrop){const r=state.pendingCrop;o.fillStyle='#2dd4bf33';o.strokeStyle='#2dd4bf';o.lineWidth=2;o.fillRect(r.x,r.y,r.w,r.h);o.strokeRect(r.x,r.y,r.w,r.h);}s.landmarks.source.forEach((p,i)=>pointMark(o,imageToSourceCanvas(p),i+1,'#fbbf24'));}
function pointMark(ctx,p,n,color){ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#111';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#111';ctx.font='bold 10px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(n,p.x,p.y);ctx.textAlign='left';ctx.textBaseline='alphabetic';}
function planeBody(s=S()){return{ap_index:+s.apIndex,yaw_deg:+s.yaw,pitch_deg:+s.pitch,width:CW,height:CH,hemisphere:s.hemisphere,boundaries:true};}
async function loadAtlas(){
  const request=++planeRequest,id=state.slideId;updateApLabel();
  const response=await api('/api/atlas/plane',body(planeBody()));const blob=await response.blob();
  const url=URL.createObjectURL(blob),img=new Image();img.src=url;
  try{await img.decode();if(request!==planeRequest||id!==state.slideId){URL.revokeObjectURL(url);return;}if(atlasUrl)URL.revokeObjectURL(atlasUrl);atlasUrl=url;atlasImage=img;drawAtlas();}catch(e){URL.revokeObjectURL(url);throw e;}
}
function composedMatrix(){
  const s=S(),m=s.manual,rad=m.rotation*Math.PI/180,cs=Math.cos(rad)*m.scale,sn=Math.sin(rad)*m.scale,cx=CW/2,cy=CH/2;
  let base=s.autoWarp?[[s.autoWarp[0][0],s.autoWarp[0][1],s.autoWarp[0][2]],[s.autoWarp[1][0],s.autoWarp[1][1],s.autoWarp[1][2]]]:[[1,0,0],[0,1,0]];
  const manual=[[cs,-sn,m.tx+cx-cs*cx+sn*cy],[sn,cs,m.ty+cy-sn*cx-cs*cy]];return mulAffine(manual,base);
}
function mulAffine(a,b){return [[a[0][0]*b[0][0]+a[0][1]*b[1][0],a[0][0]*b[0][1]+a[0][1]*b[1][1],a[0][0]*b[0][2]+a[0][1]*b[1][2]+a[0][2]],[a[1][0]*b[0][0]+a[1][1]*b[1][0],a[1][0]*b[0][1]+a[1][1]*b[1][1],a[1][0]*b[0][2]+a[1][1]*b[1][2]+a[1][2]]]}
function sourcePointToRegistration(p){const {crop}=sourceGeometry();let x=(p.x-crop[0])/crop[2]*CW,y=(p.y-crop[1])/crop[3]*CH;if(S().flipped)x=CW-x;return{x,y}}
function solveLinear(A,b){for(let i=0;i<b.length;i++){let k=i;for(let j=i+1;j<b.length;j++)if(Math.abs(A[j][i])>Math.abs(A[k][i]))k=j;[A[i],A[k]]=[A[k],A[i]];[b[i],b[k]]=[b[k],b[i]];const d=A[i][i];if(Math.abs(d)<1e-9)throw Error('Landmarks are collinear');for(let j=i;j<b.length;j++)A[i][j]/=d;b[i]/=d;for(let k2=0;k2<b.length;k2++)if(k2!==i){const f=A[k2][i];for(let j=i;j<b.length;j++)A[k2][j]-=f*A[i][j];b[k2]-=f*b[i]}}return b}
function fitLandmarks(){const s=S(),src=s.landmarks.source.slice(0,s.landmarks.atlas.length).map(sourcePointToRegistration),dst=s.landmarks.atlas;if(dst.length<2){toast('Add at least two landmark pairs');return}let M;if(dst.length===2){const [p,q]=src,[u,v]=dst,dx=q.x-p.x,dy=q.y-p.y,du=v.x-u.x,dv=v.y-u.y;const den=dx*dx+dy*dy,a=(du*dx+dv*dy)/den,b=(dv*dx-du*dy)/den;M=[[a,-b,u.x-a*p.x+b*p.y],[b,a,u.y-b*p.x-a*p.y]]}else{const A=[],b=[];src.forEach((p,i)=>{const q=dst[i];A.push([p.x,p.y,1,0,0,0]);b.push(q.x);A.push([0,0,0,p.x,p.y,1]);b.push(q.y)});const AtA=Array.from({length:6},()=>Array(6).fill(0)),Atb=Array(6).fill(0);for(let r=0;r<A.length;r++)for(let i=0;i<6;i++){Atb[i]+=A[r][i]*b[r];for(let j=0;j<6;j++)AtA[i][j]+=A[r][i]*A[r][j]}const x=solveLinear(AtA,Atb);M=[[x[0],x[1],x[2]],[x[3],x[4],x[5]]]}s.autoWarp=M;s.manual={tx:0,ty:0,rotation:0,scale:1};syncControls();changed();drawAtlas();toast(`Fitted ${dst.length>=3?'affine':'similarity'} transform`)}

function drawAtlas(){const ctx=$('atlasCanvas').getContext('2d');ctx.clearRect(0,0,CW,CH);if(atlasImage.naturalWidth)ctx.drawImage(atlasImage,0,0,CW,CH);if($('showTissue').checked&&sourceImage.naturalWidth){const s=S(),M=composedMatrix();ctx.save();ctx.globalAlpha=s.opacity;ctx.setTransform(M[0][0],M[1][0],M[0][1],M[1][1],M[0][2],M[1][2]);if(s.flipped){ctx.translate(CW,0);ctx.scale(-1,1);}ctx.drawImage(sourceImage,...sourceGeometry().crop,0,0,CW,CH);ctx.restore();}drawAnnotations();}
function pathPolygon(ctx,points,close=true){ctx.beginPath();if(!points.length)return;ctx.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));if(close)ctx.closePath();}
function color(index){return ['#ffce56','#63dcff','#ff8bbc','#abed75','#c4a0ff','#ffab70'][index%6];}
function drawAnnotations(){
  const ctx=$('atlasOverlay').getContext('2d');ctx.clearRect(0,0,CW,CH);
  S().landmarks.atlas.forEach((p,i)=>pointMark(ctx,p,i+1,'#fbbf24'));
  if($('showPolygons').checked)S().annotations.forEach((a,i)=>{
    if(!a.points?.length)return;const selected=a.id===state.selectedAnnotation,c=color(i);pathPolygon(ctx,a.points);ctx.fillStyle=c+(selected?'55':'22');ctx.fill();
    ctx.strokeStyle='#101515';ctx.lineWidth=selected?6:4;ctx.stroke();ctx.strokeStyle=c;ctx.lineWidth=selected?3:2;ctx.stroke();
    const center=a.points.reduce((v,p)=>({x:v.x+p.x/a.points.length,y:v.y+p.y/a.points.length}),{x:0,y:0});
    ctx.font='bold 14px sans-serif';const text=a.code||'Unassigned',w=ctx.measureText(text).width+12;
    const x=Math.max(2,Math.min(CW-w-2,center.x-w/2)),y=Math.max(20,Math.min(CH-4,center.y));
    ctx.fillStyle='#0c1519e8';ctx.fillRect(x,y-18,w,24);ctx.fillStyle=c;ctx.fillText(text,x+6,y);
    if(selected&&state.mode==='select')a.points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,6,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#15231f';ctx.stroke();});
  });
  if(state.draftPolygon.length){pathPolygon(ctx,state.draftPolygon,false);ctx.strokeStyle='#101515';ctx.lineWidth=5;ctx.stroke();ctx.strokeStyle='#ffce56';ctx.lineWidth=2;ctx.stroke();state.draftPolygon.forEach((p,i)=>pointMark(ctx,p,i+1,'#ffce56'));}
  updateTools();
}
function inside(p,points){let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;}
function distanceToEdge(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
function hitPolygon(p){return [...S().annotations].reverse().find(a=>inside(p,a.points)||a.points.some((q,i)=>distanceToEdge(p,q,a.points[(i+1)%a.points.length])<8));}
function selected(){return S().annotations.find(a=>a.id===state.selectedAnnotation);}
function updateTools(){
  const draft=state.mode==='polygon',a=state.slideId?selected():null;
  $('draftTools').hidden=!draft;$('selectionTools').hidden=!a||draft;$('selectedLabel').textContent=a?`Selected: ${a.code}`:'';
  $('finishPolygonButton').disabled=state.draftPolygon.length<3;$('removeLastVertex').disabled=!state.draftPolygon.length;
  $('undoButton').disabled=!state.undo.length&&!state.draftPolygon.length;$('redoButton').disabled=!state.redo.length;
  $('selectButton').classList.toggle('active',state.mode==='select');$('polygonButton').classList.toggle('active',draft);
  $('cropButton').classList.toggle('active',state.mode==='crop');$('landmarkButton').classList.toggle('active',state.mode==='landmark');
  $('modeHint').textContent=state.loading?'Loading section…':draft?`Drawing ${$('pieceSelect').value||'piece'} · ${state.draftPolygon.length} points · Finish to keep, Esc to cancel`:state.mode==='crop'?'Drag a box in Source evidence below.':state.mode==='landmark'?'Click a source landmark, then the matching atlas landmark.':a?`${a.code} selected · drag white handles to edit · Delete/Backspace removes it`:'Click a polygon or its annotation entry to select it.';
}
function setMode(mode){if(state.draftPolygon.length&&mode!=='polygon'){toast('Finish or cancel the current polygon first.');return;}state.mode=mode;$('sourceWrap').classList.toggle('drawing',['crop','landmark'].includes(mode));$('atlasWrap').classList.toggle('drawing',['landmark','polygon'].includes(mode));updateTools();if(state.slideId)drawAnnotations();}
function selectAnnotation(id){state.selectedAnnotation=id;$('showPolygons').checked=true;setMode('select');const a=selected();if(a&&[...$('pieceSelect').options].some(o=>o.value===a.code))$('pieceSelect').value=a.code;drawAnnotations();renderLists();}
function removeAnnotation(id=state.selectedAnnotation){if(!id)return;const a=S().annotations.find(a=>a.id===id);if(!a)return;S().annotations=S().annotations.filter(a=>a.id!==id);state.selectedAnnotation=null;changed();drawAnnotations();toast(`Deleted ${a.code}. Undo restores it.`);}
function cancelDraft(){state.draftPolygon=[];setMode('select');cacheDraft();drawAnnotations();toast('Drawing cancelled. Existing polygons kept.');}
function removeDraftPoint(){state.draftPolygon.pop();cacheDraft();drawAnnotations();}
function polygonArea(points){return Math.abs(points.reduce((v,p,i)=>{const q=points[(i+1)%points.length];return v+p.x*q.y-q.x*p.y;},0)/2);}
async function finishPolygon(){
  const points=state.draftPolygon.filter((p,i,list)=>!i||Math.hypot(p.x-list[i-1].x,p.y-list[i-1].y)>1);
  if(points.length<3||polygonArea(points)<4){toast('Draw at least three distinct points enclosing an area.');return;}
  const code=$('pieceSelect').value;if(!code){toast('Choose a tissue piece code first.');return;}
  if(S().annotations.some(a=>a.code===code)){toast(`${code} already has a polygon. Select it to edit, or choose another piece code.`);return;}
  const a={id:crypto.randomUUID(),code,points:clone(points),regions:[],createdAt:new Date().toISOString()};
  S().annotations.push(a);state.draftPolygon=[];state.selectedAnnotation=a.id;setMode('select');changed();drawAnnotations();await summarizeAnnotation(a,state.slideId);
}
async function summarizeAnnotation(a,id){
  const s=state.slides[id],signature=JSON.stringify([planeBody(s),a.points]);a.summaryStatus='pending';summaryPending++;renderLists();
  try{const data=await(await api('/api/atlas/summarize',body({...planeBody(s),points:clone(a.points)}))).json();
    if(state.slides[id]!==s||!s.annotations.includes(a)||signature!==JSON.stringify([planeBody(s),a.points]))return;
    a.regions=data.regions;a.plane={atlas_id:state.atlas.id,...planeBody(s),resolution_um:state.atlas.resolution_um};a.summaryStatus='ready';
    state.editVersion++;state.dirty=true;currentSnapshot=snapshot();cacheDraft();queueSave();
  }catch(e){if(s.annotations.includes(a)){a.summaryStatus='error';a.regions=[];cacheDraft();}fail(e);}
  finally{summaryPending--;renderLists();}
}
function invalidateSummaries(s){for(const a of s.annotations){a.regions=[];a.summaryStatus='stale';delete a.plane;}}
function scheduleAtlas(){clearTimeout(renderTimer);const id=state.slideId;renderTimer=setTimeout(safely(async()=>{if(id!==state.slideId)return;await loadAtlas();const s=state.slides[id];await Promise.all(s.annotations.map(a=>summarizeAnnotation(a,id)));}),160);}
function controlChanged(e){
  if(state.loading)return;const s=S(),id=e.target.id;const planeChange=['apSlider','apNumber','yaw','pitch','hemisphere'].includes(id);
  if(id==='apSlider'||id==='apNumber')s.apIndex=Math.max(0,Math.min(state.atlas.shape[0]-1,+e.target.value||0));
  else if(id==='sourceFlip')s.flipped=e.target.checked;else if(id==='hemisphere')s.hemisphere=e.target.value;
  else if(['yaw','pitch'].includes(id))s[id]=Math.max(-20,Math.min(20,+e.target.value||0));
  else if(id==='opacity')s.opacity=+e.target.value;
  else s.manual[id]=id==='scale'?Math.max(.01,+e.target.value||1):+e.target.value||0;
  if(planeChange)invalidateSummaries(s);syncControls();changed({review:id!=='opacity'});
  if(planeChange)scheduleAtlas();else{drawSource();drawAtlas();}
}
function renderLists(){
  if(!state.project||!state.slideId)return;const s=S(),meta=state.project.slides.find(m=>m.id===state.slideId);
  const known=state.project.slides,all=Object.entries(state.slides).flatMap(([id,v])=>(v.annotations||[]).map(a=>({id,a})));
  const query=$('annotationSearch').value.trim().toLowerCase();
  const visible=all.filter(({id,a})=>(state.scope==='all'||id===state.slideId)&&`${id} ${a.code}`.toLowerCase().includes(query));
  $('annotationCount').textContent=`(${state.scope==='all'?all.length:s.annotations.length})`;
  $('projectProgress').textContent=`${all.length} polygons across ${new Set(all.map(x=>x.id)).size} sections · ${known.reduce((n,m)=>n+m.tissue_pieces.length,0)} expected pieces`;
  $('slideSelect').innerHTML=known.map(m=>`<option value="${esc(m.id)}">${esc(m.display_name||m.id)} · ${state.slides[m.id]?.annotations.length||0}/${m.tissue_pieces.length}</option>`).join('');$('slideSelect').value=state.slideId;
  $('annotationList').innerHTML=visible.length?visible.map(({id,a})=>`<div class="annotation ${id===state.slideId&&a.id===state.selectedAnnotation?'selected':''}" data-slide="${esc(id)}" data-id="${esc(a.id)}"><div class="top"><button class="annotation-name" data-action="select" aria-label="Select polygon ${esc(a.code)}">${esc(a.code)}</button><button data-action="delete" aria-label="Delete polygon ${esc(a.code)}">Delete</button></div><small>${state.scope==='all'?`Section ${esc(id)} · `:''}${a.points.length} vertices · ${esc(a.summaryStatus==='pending'?'sampling…':a.summaryStatus==='stale'?'plane changed — resampling':a.summaryStatus==='error'?'sampling failed':a.regions?.[0]?.acronym||'not sampled')}${a.code.startsWith('candidate_')?' · unassigned suggestion':''}</small></div>`).join(''):`<div class="empty">${query?'No matching annotations.':state.scope==='all'?'No polygons in this project yet. Draw a polygon, or open History.':`No polygons on this section.<br>${all.length?'Choose All sections to find your other annotations.':'Choose a piece code and + Draw polygon.'}`}</div>`;
  const a=selected();$('compositionTitle').textContent=a?`Atlas composition · ${a.code}`:'Atlas composition';
  $('regionTable').innerHTML=a?.regions?.length?a.regions.map(r=>`<div class="region"><b>${esc(r.acronym)}</b><span>${esc(r.name)}</span><span>${(r.fraction*100).toFixed(1)}%</span></div>`).join(''):`<div class="empty">${a?(a.summaryStatus==='error'?'Sampling failed. Change the plane or retry after checking the server.':'Sampling the selected polygon…'):'Select a polygon to see its Allen regions.'}</div>`;
  $('provenance').innerHTML=`<dt>Project</dt><dd>${esc(state.project.project_id)}</dd><dt>Section</dt><dd>${esc(state.slideId)}</dd><dt>Source hash</dt><dd>${esc(meta?.sha256?.slice(0,16))}…</dd><dt>Atlas</dt><dd>${esc(state.atlas.id)}</dd><dt>Plane</dt><dd>AP ${s.apIndex}, yaw ${s.yaw}°, pitch ${s.pitch}°</dd><dt>Review</dt><dd>${s.reviewed?'complete':'pending'}</dd>`;
  $('currentScope').classList.toggle('active',state.scope==='current');$('allScope').classList.toggle('active',state.scope==='all');updateTools();
}
async function historyMove(direction){
  // Prefer the completed-edit history. This makes Undo restore a deleted
  // annotation even when an unfinished polygon is also on the canvas.
  // Use the explicit “Remove last point” control for draft editing.
  if(!state[direction].length){if(state.draftPolygon.length)removeDraftPoint();return;}
  if(state.loading)return;const from=state[direction],to=state[direction==='undo'?'redo':'undo'];if(!from.length)return;
  to.push(snapshot());const data=JSON.parse(from.pop());state.slides=normalizeSlides(data.slides);state.selectedAnnotation=null;await selectSlide(data.active_slide);currentSnapshot=snapshot();changed({review:false,history:false});drawAnnotations();toast(direction==='undo'?'Undone':'Redone');
  const id=state.slideId;await Promise.all(S().annotations.filter(a=>a.summaryStatus!=='ready').map(a=>summarizeAnnotation(a,id)));
}
function ask(title,text,label='Continue'){return new Promise(resolve=>{$('confirmTitle').textContent=title;$('confirmText').textContent=text;$('confirmProceed').textContent=label;$('confirmDialog').showModal();$('confirmCancel').onclick=()=>{$('confirmDialog').close();resolve(false);};$('confirmDialog').oncancel=()=>resolve(false);$('confirmProceed').onclick=()=>{$('confirmDialog').close();resolve(true);};});}
async function reset(kind){
  const label=kind==='all'?'Start whole project from scratch':kind==='polygons'?'Clear polygons on this section':'Reset current section';
  if(!await ask(label,`This clears ${kind==='all'?'all sections':kind==='polygons'?'only polygons; alignment stays':'this section’s alignment and polygons'}. A recovery checkpoint is saved first. You can also Undo.`,label))return;
  await save(false);state.draftPolygon=[];state.selectedAnnotation=null;
  if(kind==='all')state.slides={};else if(kind==='polygons')S().annotations=[];else state.slides[state.slideId]=blankSlide();
  changed();await selectSlide(state.slideId);currentSnapshot=snapshot();queueSave();
}
async function autoAlign(){
  const s=S(),id=state.slideId;if(!s.crop){toast('Crop one tissue photograph in Source evidence first.');return;}
  const original=JSON.stringify(s);$('autoButton').disabled=true;$('autoResult').textContent='Searching nearby planes…';
  try{const out=await(await api('/api/auto-align',body({...planeBody(s),slide_id:id,crop:s.crop,search_radius:12,search_step:3,allow_flip:true}))).json();
    if(state.slideId!==id||state.slides[id]!==s||JSON.stringify(s)!==original){toast('Alignment suggestion discarded because the section changed.');return;}
    if(out.best.score<=0)throw Error('No reliable alignment fit. Use matching landmarks.');
    s.apIndex=out.best.ap_index;s.flipped=out.best.flipped;s.autoWarp=out.best.warp;s.manual={tx:0,ty:0,rotation:0,scale:1};invalidateSummaries(s);changed();syncControls();await loadAtlas();drawSource();
    $('autoResult').textContent=`Advisory score ${out.best.score.toFixed(3)} · AP ${s.apIndex}${s.flipped?' · flipped':''}. Check with landmarks. Existing polygons stay at their atlas positions.`;
    await Promise.all(s.annotations.map(a=>summarizeAnnotation(a,id)));
  }finally{$('autoButton').disabled=false;}
}
function transformPoint(M,p){return{x:M[0][0]*p.x+M[0][1]*p.y+M[0][2],y:M[1][0]*p.x+M[1][1]*p.y+M[1][2]};}
async function suggestPieces(){
  const s=S(),id=state.slideId;if(!s.crop){toast('Crop one red-marked tissue photograph first.');return;}
  const original=JSON.stringify(s);$('suggestPiecesButton').disabled=true;
  try{const out=await(await api('/api/suggest-pieces',body({slide_id:id,crop:s.crop,width:CW,height:CH,min_area_fraction:.002}))).json();
    if(state.slideId!==id||state.slides[id]!==s||JSON.stringify(s)!==original){toast('Suggestion discarded because the section changed.');return;}
    if(!out.polygons.length){toast('No candidate outlines found. Draw the pieces manually.');return;}
    if(out.method==='colour_label_seeded_voronoi'&&!await ask('Approximate outlines from coloured labels','Closed boundaries were not found. These candidates divide tissue by distance to coloured marks; they do not identify anatomical cuts. Add them for manual correction?','Add editable candidates'))return;
    if(state.slideId!==id||state.slides[id]!==s)return;
    const M=composedMatrix(),added=[];let n=1;
    for(const poly of out.polygons){while(s.annotations.some(a=>a.code===`candidate_${n}`))n++;const points=poly.points.map(p=>s.flipped?{x:CW-p.x,y:p.y}:p).map(p=>transformPoint(M,p));
      const a={id:crypto.randomUUID(),code:`candidate_${n++}`,points,regions:[],basis:out.method,createdAt:new Date().toISOString()};s.annotations.push(a);added.push(a);}
    state.selectedAnnotation=added[0].id;$('showPolygons').checked=true;setMode('select');changed();drawAnnotations();toast(`${added.length} suggestions added. Select each, assign a code, and edit.`);
    await Promise.all(added.map(a=>summarizeAnnotation(a,id)));
  }finally{$('suggestPiecesButton').disabled=false;}
}
function assignSelectedPiece(){const a=selected(),code=$('pieceSelect').value;if(!a||!code)return;if(S().annotations.some(other=>other!==a&&other.code===code)){toast(`${code} is already assigned. Delete or edit its existing polygon first.`);return;}a.code=code;a.assignedManuallyAt=new Date().toISOString();changed();drawAnnotations();}
async function showRevisions(){const rows=await(await api('/api/revisions')).json();$('revisionList').innerHTML=rows.length?rows.map(r=>`<div class="revision"><div><b>${esc(r.label)}</b><small>${esc(new Date(r.saved_at).toLocaleString())}${r.annotation_count!=null?` · ${r.annotation_count} polygons`:''}</small></div><button data-load="${esc(r.filename)}">Open</button></div>`).join(''):'<div class="empty">No saved revisions yet.</div>';$('loadDialog').showModal();}
async function loadRevision(file){
  const rec=await(await api(`/api/revisions/${encodeURIComponent(file)}`)).json();
  if(state.dirty||state.draftPolygon.length){$('loadDialog').close();if(!await ask('Open another revision?','The current completed work will be saved as a recovery checkpoint. An unfinished drawing will be cancelled.','Save and open'))return;await save(false);}
  clearTimeout(saveTimer);if(saveInFlight)await saveInFlight;
  const before=snapshot();state.slides=normalizeSlides(rec.state.slides);state.undo.push(before);state.redo=[];state.draftPolygon=[];state.selectedAnnotation=null;
  $('loadDialog').close();const id=state.project.slides.some(s=>s.id===rec.state.active_slide)?rec.state.active_slide:state.project.slides[0].id;
  await selectSlide(id);currentSnapshot=snapshot();changed({review:false,history:false});checkProvenance(rec.state);
  const unknown=Object.keys(state.slides).filter(id=>!state.project.slides.some(s=>s.id===id));
  toast(unknown.length?'Revision loaded. Older section IDs are retained; see All sections and export JSON.':'Revision loaded. All sections shows annotations throughout the project.');
}
function download(data,type,name){const u=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
async function exportCsv(){
  if(summaryPending){toast('Wait for atlas sampling to finish before exporting.');return;}
  const stale=Object.entries(state.slides).flatMap(([id,s])=>(s.annotations||[]).filter(a=>!a.regions?.length||['stale','error','pending'].includes(a.summaryStatus)).map(a=>({id,a})));
  if(stale.length){toast('Updating atlas composition before export…');await Promise.all(stale.map(({id,a})=>summarizeAnnotation(a,id)));if(stale.some(({a})=>a.summaryStatus!=='ready'))throw Error('Export stopped because some polygons could not be sampled.');}
  const rows=[['registration_unit','physical_slide','piece_code','registration_reviewed','atlas_id','ap_index','yaw_deg','pitch_deg','region_id','acronym','region_name','fraction','vertices']];
  for(const [id,s] of Object.entries(state.slides)){const meta=state.project.slides.find(m=>m.id===id);for(const a of s.annotations||[])for(const r of a.regions||[])rows.push([id,meta?.physical_slide||'',a.code,!!s.reviewed,a.plane?.atlas_id||state.atlas.id,a.plane?.ap_index??s.apIndex,a.plane?.yaw_deg??s.yaw,a.plane?.pitch_deg??s.pitch,r.id,r.acronym,r.name,r.fraction,JSON.stringify(a.points)]);}
  download(rows.map(row=>row.map(x=>`"${String(x??'').replaceAll('"','""')}"`).join(',')).join('\n'),'text/csv',`${state.project.project_id}_atlas_regions.csv`);toast(`Exported ${rows.length-1} region rows from all sections.`);
}
// Pointer capture keeps dragging reliable even when a handle leaves the canvas.
$('sourceOverlay').addEventListener('pointerdown',e=>{if(state.loading||state.mode!=='crop')return;cropStart=canvasPoint(e.currentTarget,e);state.pendingCrop={...cropStart,w:0,h:0};e.currentTarget.setPointerCapture(e.pointerId);});
$('sourceOverlay').addEventListener('pointermove',e=>{if(!cropStart)return;const p=canvasPoint(e.currentTarget,e);state.pendingCrop={x:Math.min(cropStart.x,p.x),y:Math.min(cropStart.y,p.y),w:Math.abs(p.x-cropStart.x),h:Math.abs(p.y-cropStart.y)};drawSource();});
$('sourceOverlay').addEventListener('pointerup',()=>{if(!cropStart)return;const r=state.pendingCrop,a=sourceCanvasToImage({x:r.x,y:r.y}),b=sourceCanvasToImage({x:r.x+r.w,y:r.y+r.h});cropStart=null;state.pendingCrop=null;
  if(r.w>10&&r.h>10){const x=Math.max(0,Math.min(a.x,b.x)),y=Math.max(0,Math.min(a.y,b.y)),right=Math.min(sourceImage.naturalWidth,Math.max(a.x,b.x)),bottom=Math.min(sourceImage.naturalHeight,Math.max(a.y,b.y));if(right-x>8&&bottom-y>8){S().crop=[Math.round(x),Math.round(y),Math.round(right-x),Math.round(bottom-y)];S().autoWarp=null;S().landmarks={source:[],atlas:[]};changed();toast('Crop set. Adjust the atlas plane and alignment.');setMode('select');}}
  drawSource();drawAtlas();});
$('sourceOverlay').addEventListener('pointercancel',()=>{cropStart=null;state.pendingCrop=null;drawSource();});
$('sourceOverlay').addEventListener('click',e=>{if(state.loading||state.mode!=='landmark')return;if(S().landmarks.source.length>S().landmarks.atlas.length){toast('Place the matching atlas landmark first.');return;}S().landmarks.source.push(sourceCanvasToImage(canvasPoint(e.currentTarget,e)));changed();drawSource();toast('Now click the matching atlas point.');});
$('atlasOverlay').addEventListener('pointerdown',e=>{if(state.loading||state.mode!=='select'||!$('showPolygons').checked)return;const p=canvasPoint(e.currentTarget,e),a=selected();if(a){let index=a.points.findIndex(q=>Math.hypot(q.x-p.x,q.y-p.y)<12);if(index>=0){dragVertex={a,index,id:state.slideId,moved:false};e.currentTarget.setPointerCapture(e.pointerId);return;}}const hit=hitPolygon(p);state.selectedAnnotation=hit?.id||null;selectAnnotation(state.selectedAnnotation);});
$('atlasOverlay').addEventListener('pointermove',e=>{const p=canvasPoint(e.currentTarget,e);if(state.atlas)$('atlasCoords').textContent=`x ${p.x.toFixed(0)} · y ${p.y.toFixed(0)}`;if(dragVertex){dragVertex.a.points[dragVertex.index]=p;dragVertex.moved=true;drawAnnotations();}});
function endDrag(){if(!dragVertex)return;const {a,id,moved}=dragVertex;dragVertex=null;if(moved){suppressClick=true;a.regions=[];a.summaryStatus='stale';changed();safely(()=>summarizeAnnotation(a,id))();}}
$('atlasOverlay').addEventListener('pointerup',endDrag);$('atlasOverlay').addEventListener('pointercancel',endDrag);
$('atlasOverlay').addEventListener('click',e=>{
  if(suppressClick){suppressClick=false;return;}if(state.loading)return;const p=canvasPoint(e.currentTarget,e);
  if(state.mode==='polygon'){if(e.detail>1)return;state.draftPolygon.push(p);cacheDraft();drawAnnotations();}
  else if(state.mode==='landmark'){if(S().landmarks.atlas.length>=S().landmarks.source.length){toast('Click a source landmark first.');return;}S().landmarks.atlas.push(p);changed();drawAnnotations();toast(`${S().landmarks.atlas.length} landmark pairs`);}
});
$('atlasOverlay').addEventListener('dblclick',safely(async e=>{if(state.mode==='polygon'){e.preventDefault();await finishPolygon();}}));
$('annotationList').addEventListener('click',safely(async e=>{
  const row=e.target.closest('.annotation');if(!row)return;
  const deleting=!!e.target.closest('[data-action="delete"]');
  // A recovered unfinished draft must never trap the user away from saved
  // annotations. Deletion is always allowed; selecting another annotation
  // cancels only the unfinished draft and keeps completed polygons intact.
  if(state.draftPolygon.length&&!deleting)cancelDraft();
  if(row.dataset.slide!==state.slideId){await selectSlide(row.dataset.slide);if(row.dataset.slide!==state.slideId)return;}
  if(deleting)removeAnnotation(row.dataset.id);else selectAnnotation(row.dataset.id);
}));
$('revisionList').addEventListener('click',safely(async e=>{const b=e.target.closest('[data-load]');if(b)await loadRevision(b.dataset.load);}));
for(const id of ['apSlider','apNumber','yaw','pitch','hemisphere','sourceFlip','opacity','tx','ty','rotation','scale'])$(id).addEventListener('input',controlChanged);
$('reviewToggle').onchange=e=>{if(e.target.checked&&(!S().annotations.length||S().annotations.some(a=>a.code.startsWith('candidate_')||!a.regions.length||['stale','error','pending'].includes(a.summaryStatus)))){e.target.checked=false;toast('Assign candidate codes and finish atlas sampling before marking reviewed.');return;}S().reviewed=e.target.checked;S().registrationStatus=e.target.checked?'manually_reviewed':'unreviewed';changed({review:false});};
$('slideSelect').onchange=safely(e=>selectSlide(e.target.value));
function stepSlide(delta){const i=state.project.slides.findIndex(s=>s.id===state.slideId),next=state.project.slides[i+delta];if(next)return selectSlide(next.id);}
$('previousSlide').onclick=safely(()=>stepSlide(-1));$('nextSlide').onclick=safely(()=>stepSlide(1));
$('selectButton').onclick=()=>setMode('select');$('polygonButton').onclick=()=>{if(state.loading)return;$('showPolygons').checked=true;setMode('polygon');};
$('cropButton').onclick=()=>{setMode('crop');$('showSource').checked=true;$('sourceCard').hidden=false;$('sourceCard').scrollIntoView({behavior:'smooth',block:'nearest'});};
$('landmarkButton').onclick=()=>{setMode('landmark');$('showSource').checked=true;$('sourceCard').hidden=false;};
$('fitButton').onclick=safely(fitLandmarks);
$('clearLandmarks').onclick=()=>{S().landmarks={source:[],atlas:[]};changed();drawSource();drawAnnotations();};
$('clearCropButton').onclick=()=>{S().crop=null;S().autoWarp=null;S().landmarks={source:[],atlas:[]};changed();drawSource();drawAtlas();};
$('autoButton').onclick=safely(autoAlign);$('suggestPiecesButton').onclick=safely(suggestPieces);
$('finishPolygonButton').onclick=safely(finishPolygon);$('cancelPolygonButton').onclick=cancelDraft;$('removeLastVertex').onclick=removeDraftPoint;
$('deletePolygonButton').onclick=()=>removeAnnotation();$('assignPieceButton').onclick=assignSelectedPiece;
$('pieceSelect').onchange=updateTools;$('undoButton').onclick=safely(()=>historyMove('undo'));$('redoButton').onclick=safely(()=>historyMove('redo'));
$('saveButton').onclick=safely(()=>save());$('loadButton').onclick=safely(showRevisions);$('closeDialog').onclick=()=>$('loadDialog').close();
$('resetSlide').onclick=safely(()=>reset('slide'));$('resetAll').onclick=safely(()=>reset('all'));$('clearPolygons').onclick=safely(()=>reset('polygons'));$('exportButton').onclick=safely(exportCsv);
$('currentScope').onclick=()=>{state.scope='current';renderLists();};$('allScope').onclick=()=>{state.scope='all';renderLists();};$('annotationSearch').oninput=renderLists;
$('showPolygons').onchange=drawAnnotations;$('showTissue').onchange=drawAtlas;$('showSource').onchange=e=>{$('sourceCard').hidden=!e.target.checked;};
$('zoomSelect').onchange=e=>{$('atlasWrap').style.width=`${+e.target.value*100}%`;};
window.addEventListener('keydown',safely(async e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();await save();return;}
  if(e.target.closest('input,select,textarea,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();await historyMove(e.shiftKey?'redo':'undo');return;}
  if(e.key==='Escape'){if(state.draftPolygon.length||state.mode==='polygon')cancelDraft();else{state.selectedAnnotation=null;setMode('select');renderLists();}return;}
  if(e.key==='Enter'&&state.mode==='polygon'){e.preventDefault();await finishPolygon();}
  if(['Delete','Backspace'].includes(e.key)){e.preventDefault();if(state.mode==='polygon')removeDraftPoint();else removeAnnotation();}
}));
window.addEventListener('beforeunload',e=>{if(state.dirty||state.draftPolygon.length){cacheDraft();e.preventDefault();e.returnValue='';}});
init().catch(e=>{fail(e);setStatus('Could not open project — '+e.message,true);});
