let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let currentUser = null;
let remoteProgress = {};
let syncReady = false;
let firebaseInitError = '';

function initFirebase(){
  firebaseInitError = '';
  const cfg = window.FIREBASE_CONFIG || {};
  const valid = cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId;
  if(!valid){
    firebaseInitError = 'Firebase configuration was not loaded.';
    return false;
  }
  if(!window.firebase || !window.firebase.initializeApp){
    firebaseInitError = 'The Firebase library did not load. Please refresh the page.';
    return false;
  }
  try{
    firebaseApp = firebase.apps?.length ? firebase.app() : firebase.initializeApp(cfg);
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    return true;
  }catch(err){
    console.error('Firebase initialization error',err);
    firebaseInitError = 'Firebase could not initialise in this browser.';
    return false;
  }
}

async function loadRemoteProgress(){
  if(!firebaseDb || !currentUser) return;
  try{
    const snap = await firebaseDb.collection('users').doc(currentUser.uid).collection('progress').get();
    remoteProgress = {};
    snap.forEach(doc=>{
      const r=doc.data()||{};
      remoteProgress[doc.id]={
        status:r.status || 'Not Started',
        favourite:!!r.favourite,
        dateCovered:r.dateCovered || null,
        lastRevised:r.lastRevised || null,
        timesRevised:r.timesRevised || 0,
        correctCount:r.correctCount || 0,
        incorrectCount:r.incorrectCount || 0
      };
    });
    syncReady=true;
    localStorage.setItem(STORE_KEY,JSON.stringify({...loadProgress(),...remoteProgress}));
    renderAll();
    if(currentCard) updateFlashMeta();
  }catch(err){
    console.error('Firestore progress load error',err);
    setAuthMessage('Signed in, but cloud progress could not load. Check Firestore setup/rules.');
  }
}

async function pushProgress(id,value){
  if(!firebaseDb || !currentUser) return;
  try{
    await firebaseDb.collection('users').doc(currentUser.uid).collection('progress').doc(id).set({
      status:value.status||'Not Started',
      favourite:!!value.favourite,
      dateCovered:value.dateCovered||null,
      lastRevised:value.lastRevised||null,
      timesRevised:value.timesRevised||0,
      correctCount:value.correctCount||0,
      incorrectCount:value.incorrectCount||0,
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }catch(err){
    console.error('Firestore progress sync error',err);
  }
}

async function signInWithGoogle(){
  if(!firebaseAuth){
    if(!initFirebase()){
      setAuthMessage(firebaseInitError || 'Firebase is not available right now.');
      return;
    }
  }

  setAuthMessage('Opening Google sign-in…');

  try{
    await firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    const provider=new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});

    // GitHub Pages is hosted outside Firebase Hosting. Firebase recommends
    // popup auth for this setup because redirect auth can be blocked by
    // modern browser cross-site storage protections.
    const result=await firebaseAuth.signInWithPopup(provider);

    currentUser=result?.user||firebaseAuth.currentUser||null;
    if(!currentUser) throw new Error('Google sign-in finished without returning a user.');

    setAuthMessage('Signed in. Loading your progress…');
    await loadRemoteProgress();
    updateAuthUI();
    setAuthMessage('');
  }catch(err){
    console.error('Google sign-in error',err);

    let msg=err?.message || 'Google sign-in failed.';
    if(err?.code==='auth/unauthorized-domain'){
      msg='This GitHub Pages domain needs to be added to Firebase Authentication → Settings → Authorized domains.';
    }else if(err?.code==='auth/popup-closed-by-user'){
      msg='The Google sign-in window was closed before sign-in finished. Please try again.';
    }else if(err?.code==='auth/popup-blocked'){
      msg='Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
    }else if(err?.code==='auth/cancelled-popup-request'){
      msg='Another Google sign-in window is already open. Close it and try again.';
    }

    setAuthMessage(msg);
  }
}

async function signOut(){
  if(firebaseAuth) await firebaseAuth.signOut();
  currentUser=null;remoteProgress={};syncReady=false;updateAuthUI();
}

function setAuthMessage(msg){
  const el=document.getElementById('authMessage'); if(el) el.textContent=msg||'';
}

function updateAuthUI(){
  const out=document.getElementById('signedOutBox');
  const inn=document.getElementById('signedInBox');
  if(!out||!inn)return;
  out.classList.toggle('hidden',!!currentUser);
  inn.classList.toggle('hidden',!currentUser);
  if(currentUser){
    document.getElementById('signedInEmail').textContent=`Signed in as ${currentUser.email||currentUser.displayName||'Google user'}. Changes now sync between devices.`;
  }
}

let DATA = { vocabulary: [], verbs: [], speaking: [], nahw: [] };
let currentCard = null;
const STORE_KEY = 'arabicEncyclopediaProgressV2';
const STATUSES = ['Not Started','Covered','Learning','Confident','Mastered'];

function loadProgress(){
  try{return JSON.parse(localStorage.getItem(STORE_KEY)) || {};}catch(e){return {}}
}
function saveProgress(p){ localStorage.setItem(STORE_KEY, JSON.stringify(p)); }
function progressFor(id){
  const p=loadProgress();
  return p[id] || {status:'Not Started',favourite:false,dateCovered:null,lastRevised:null,timesRevised:0,correctCount:0,incorrectCount:0};
}
function patchProgress(id, patch){
  const all=loadProgress();
  const old=progressFor(id);
  const next={...old,...patch};
  if(patch.status && patch.status!=='Not Started' && !old.dateCovered) next.dateCovered=new Date().toISOString();
  all[id]=next; saveProgress(all);
  if(currentUser) pushProgress(id,next);
  renderAll();
}
async function loadData(){
  const [vocabRes, verbsRes, speakingRes, nahwRes, sarfRes] = await Promise.all([
    fetch('vocab.json'), fetch('verbs.json'), fetch('speaking.json'), fetch('nahw.json'), fetch('sarf.json')
  ]);
  const vocabData=await vocabRes.json();
  const verbsData=await verbsRes.json();
  const speakingData=await speakingRes.json();
  const nahwData=await nahwRes.json();
  const sarfData=await sarfRes.json();
  DATA={vocabulary:vocabData.vocabulary||[],verbs:verbsData.verbs||[],speaking:speakingData.speaking||[],nahw:nahwData.nahw||[],sarf:sarfData.sarf||[]};
  setup();
}
function setup(){
  bindNavigation();
  populateFilters();
  bindEvents();
  document.getElementById('googleSignInBtn')?.addEventListener('click',signInWithGoogle);
  document.getElementById('signOutBtn')?.addEventListener('click',signOut);
  renderAll();
  newRevisionCard();

  if(initFirebase()){
    firebaseAuth.onAuthStateChanged(async user=>{
      currentUser=user||null;
      if(currentUser){
        setAuthMessage('');
        await loadRemoteProgress();
      }else{
        remoteProgress={};
        syncReady=false;
      }
      updateAuthUI();
    });
  }else{
    updateAuthUI();
    setAuthMessage(firebaseInitError || 'Firebase is not connected yet. Your progress is currently stored only on this device.');
  }
}
function bindNavigation(){
  document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));
}
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(id==='progress') renderProgress();
  window.scrollTo({top:0,behavior:'smooth'});
}
function unique(arr){return [...new Set(arr.filter(Boolean))].sort();}
function sortVerbForms(forms){
  const order=["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","Quadriliteral I","Quadriliteral derived"];
  return [...new Set(forms.filter(Boolean))].sort((a,b)=>{
    const ai=order.indexOf(a), bi=order.indexOf(b);
    if(ai!==-1&&bi!==-1) return ai-bi;
    if(ai!==-1) return -1;
    if(bi!==-1) return 1;
    return String(a).localeCompare(String(b));
  });
}
function sourceValues(x){
  if(Array.isArray(x?.source)) return x.source;
  return String(x?.source||'').split(';').map(s=>s.trim()).filter(Boolean);
}
function fillSelect(id,values){
  const el=document.getElementById(id);
  values.forEach(v=>el.insertAdjacentHTML('beforeend',`<option value="${v}">${v}</option>`));
}
function populateFilters(){
  fillSelect('categoryFilter',unique(DATA.vocabulary.map(x=>x.category)));
  fillSelect('typeFilter',unique(DATA.vocabulary.map(x=>x.type)));
  fillSelect('sourceFilter',unique(DATA.vocabulary.flatMap(sourceValues)));
  fillSelect('formFilter',sortVerbForms(DATA.verbs.map(x=>x.form)));
  fillSelect('verbTypeFilter',unique(DATA.verbs.map(x=>x.verb_type)));
  fillSelect('sarfSectionFilter',unique(DATA.sarf.map(x=>x.section)));
  fillSelect('speakingTopicFilter',unique(DATA.speaking.map(x=>x.topic)));
  fillSelect('nahwTopicFilter',unique(DATA.nahw.map(x=>x.topic)));
}
function renderAll(){
  renderStats(); renderSectionDashboards(); renderVocabulary(); renderRoots(); renderVerbs(); renderSarf(); renderSpeaking(); renderNahw(); renderProgress();
}
function itemStatus(id){return progressFor(id).status || 'Not Started';}
function statusClass(status){
  return 'status-'+String(status||'Not Started').toLowerCase().replace(/\s+/g,'-');
}
function sortRecentlyCoveredLast(items){
  return [...items].sort((a,b)=>{
    const pa=progressFor(a.id), pb=progressFor(b.id);
    const aCovered=!!pa.dateCovered, bCovered=!!pb.dateCovered;
    if(aCovered!==bCovered) return aCovered?1:-1;
    if(!aCovered && !bCovered) return 0;
    return new Date(pa.dateCovered)-new Date(pb.dateCovered);
  });
}
function renderStats(){
  const allItems=[...DATA.vocabulary,...DATA.verbs,...DATA.speaking,...DATA.nahw];
  const covered=allItems.filter(x=>itemStatus(x.id)!=='Not Started').length;
  const mastered=allItems.filter(x=>itemStatus(x.id)==='Mastered').length;
  const learning=allItems.filter(x=>itemStatus(x.id)==='Learning').length;
  const fav=allItems.filter(x=>progressFor(x.id).favourite).length;
  document.getElementById('stats').innerHTML=[
    ['Total Items',allItems.length],['Covered',covered],['Learning',learning],['Mastered',mastered],['Favourites',fav]
  ].map(([a,b])=>`<div class="stat"><span>${a}</span><strong>${b}</strong></div>`).join('');
}

function filterByMetric(items,filter){
  if(!filter||filter==='all') return items;
  if(filter==='favourites') return items.filter(x=>progressFor(x.id).favourite);
  if(filter==='started') return items.filter(x=>itemStatus(x.id)!=='Not Started');
  return items.filter(x=>itemStatus(x.id)===filter);
}
function dashboardMarkup(items,section){
  const counts={
    total:items.length,
    notStarted:items.filter(x=>itemStatus(x.id)==='Not Started').length,
    covered:items.filter(x=>itemStatus(x.id)==='Covered').length,
    learning:items.filter(x=>itemStatus(x.id)==='Learning').length,
    confident:items.filter(x=>itemStatus(x.id)==='Confident').length,
    mastered:items.filter(x=>itemStatus(x.id)==='Mastered').length,
    favourites:items.filter(x=>progressFor(x.id).favourite).length
  };
  const started=counts.total-counts.notStarted;
  const pct=counts.total?Math.round(started/counts.total*100):0;
  const cards=[
    ['Total',counts.total,'','all'],
    ['Not Started',counts.notStarted,'status-not-started','Not Started'],
    ['Covered',counts.covered,'status-covered','Covered'],
    ['Learning',counts.learning,'status-learning','Learning'],
    ['Confident',counts.confident,'status-confident','Confident'],
    ['Mastered',counts.mastered,'status-mastered','Mastered'],
    ['Favourites',counts.favourites,'','favourites']
  ];
  return cards.map(([label,value,cls,filter])=>`
    <button type="button" class="section-metric metric-clickable ${cls} ${SECTION_METRIC_FILTERS[section]===filter?'selected':''}" data-section-name="${section}" data-section-filter="${filter}">
      <span>${label}</span><strong>${value}</strong>
      ${label==='Total'?`<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><div class="meta">${pct}% started</div>`:''}
    </button>`).join('');
}
function renderSectionDashboards(){
  const map=[
    ['vocabDashboard',DATA.vocabulary,'vocabulary'],
    ['verbsDashboard',DATA.verbs,'verbs'],
    ['speakingDashboard',DATA.speaking,'speaking'],
    ['nahwDashboard',DATA.nahw,'nahw']
  ];
  map.forEach(([id,items,section])=>{
    const el=document.getElementById(id);
    if(el) el.innerHTML=dashboardMarkup(items,section);
  });
  bindSectionDashboardFilters();
  renderRootsDashboard();
}
function bindSectionDashboardFilters(){
  document.querySelectorAll('[data-section-filter]').forEach(btn=>{
    btn.onclick=()=>{
      const section=btn.dataset.sectionName, filter=btn.dataset.sectionFilter;
      SECTION_METRIC_FILTERS[section]=filter;
      if(section==='vocabulary'){
        const status=document.getElementById('statusFilter'),fav=document.getElementById('favouriteFilter');
        if(status)status.value='';if(fav)fav.checked=false;
      }
      renderSectionDashboards();
      if(section==='vocabulary')renderVocabulary();
      if(section==='verbs')renderVerbs();
      if(section==='speaking')renderSpeaking();
      if(section==='nahw')renderNahw();
      const target={vocabulary:'vocabList',verbs:'verbsList',speaking:'speakingList',nahw:'nahwList'}[section];
      document.getElementById(target)?.scrollIntoView({behavior:'smooth',block:'start'});
    };
  });
}
function getRootGroups(){
  const groups={};
  [...DATA.vocabulary,...DATA.verbs].filter(x=>x.root).forEach(x=>{
    groups[x.root]=groups[x.root]||[];
    groups[x.root].push(x);
  });
  return groups;
}

function rootProgress(items){
  const counts={
    notStarted:items.filter(x=>itemStatus(x.id)==='Not Started').length,
    covered:items.filter(x=>itemStatus(x.id)==='Covered').length,
    learning:items.filter(x=>itemStatus(x.id)==='Learning').length,
    confident:items.filter(x=>itemStatus(x.id)==='Confident').length,
    mastered:items.filter(x=>itemStatus(x.id)==='Mastered').length
  };
  const weighted=counts.covered*.25+counts.learning*.4+counts.confident*.75+counts.mastered;
  const pct=items.length?Math.round(weighted/items.length*100):0;
  return {...counts,pct};
}

function renderRootsDashboard(){
  const el=document.getElementById('rootsDashboard');if(!el)return;
  const groups=Object.values(getRootGroups());
  const total=groups.length;
  const notStarted=groups.filter(items=>rootProgress(items).pct===0).length;
  const started=groups.filter(items=>rootProgress(items).pct>0).length;
  const strong=groups.filter(items=>rootProgress(items).pct>=75).length;
  const mastered=groups.filter(items=>rootProgress(items).pct===100).length;
  const cards=[
    ['Total Roots',total,'','all'],['Not Started',notStarted,'status-not-started','not-started'],
    ['Started',started,'status-covered','started'],['Strong (75%+)',strong,'status-confident','strong'],
    ['Mastered',mastered,'status-mastered','mastered']
  ];
  el.innerHTML=cards.map(([a,b,cls,f])=>`<button type="button" class="section-metric metric-clickable ${cls} ${ROOT_METRIC_FILTER===f?'selected':''}" data-root-dashboard-filter="${f}"><span>${a}</span><strong>${b}</strong></button>`).join('');
  document.querySelectorAll('[data-root-dashboard-filter]').forEach(btn=>btn.onclick=()=>{ROOT_METRIC_FILTER=btn.dataset.rootDashboardFilter;renderRootsDashboard();renderRoots();});
}

function openRootItem(id){
  const vocabItem=DATA.vocabulary.find(x=>x.id===id);
  const verbItem=DATA.verbs.find(x=>x.id===id);
  if(vocabItem){
    showView('vocabulary');
    const q=document.getElementById('vocabSearch');
    const type=document.getElementById('typeFilter');
    const source=document.getElementById('sourceFilter');
    const status=document.getElementById('statusFilter');
    const fav=document.getElementById('favouriteFilter');
    if(q) q.value=vocabItem.arabic;
    if(type) type.value='';
    if(source) source.value='';
    if(status) status.value='';
    if(fav) fav.checked=false;
    renderVocabulary();
  } else if(verbItem){
    showView('verbs');
    const form=document.getElementById('formFilter');
    if(form) form.value='';
    renderVerbs();
    setTimeout(()=>{
      document.querySelector(`[data-item-id="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});
    },50);
  }
}

function statusControls(x){
  const p=progressFor(x.id);
  return `<div class="status-row">
    ${STATUSES.map(s=>`<button class="status-btn ${p.status===s?'active':''}" data-status-id="${x.id}" data-status="${s}">${s}</button>`).join('')}
    <button class="star-btn ${p.favourite?'on':''}" data-fav-id="${x.id}" title="Favourite">${p.favourite?'★':'☆'}</button>
  </div>`;
}
function vocabCard(x){
  const p=progressFor(x.id);
  return `<article class="item" data-item-id="${x.id}">
    <div class="item-head">
      <div style="flex:1">
        <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
        <h3>${x.english}</h3>
      </div>
      <span class="pill ${statusClass(p.status)}">${p.status}</span>
    </div>
    <div class="meta">${x.category||'General'} · ${x.topic||'General'} · Type: ${x.type}${x.root?` · Root: ${x.root}`:''} ${x.form?`· Form ${x.form}`:''}</div>
    ${x.past?`<div class="meta">Past: <span lang="ar" dir="rtl">${x.past}</span> · Present: <span lang="ar" dir="rtl">${x.present}</span> · Maṣdar: <span lang="ar" dir="rtl">${x.masdar}</span></div>`:''}
    ${x.example?`<div class="example" lang="ar" dir="rtl">${x.example}</div><div class="meta">${x.example_en}</div>`:''}
    <div class="meta">Revised ${p.timesRevised||0} time${p.timesRevised===1?'':'s'}${p.lastRevised?` · Last revised ${formatDate(p.lastRevised)}`:''}</div>
    ${statusControls(x)}
  </article>`;
}

function verbDataCell(label,value,arabic=false){
  if(value===undefined||value===null||value==='') return '';
  const d=(typeof value==='object'&&!Array.isArray(value))?Object.values(value).filter(Boolean).join(' · '):(Array.isArray(value)?value.join(', '):value);
  return `<div class="verb-data"><span>${label}</span><strong class="${arabic?'verb-ar':''}">${d}</strong></div>`;
}
function verbCard(x){
  const p=progressFor(x.id);
  return `<article class="item verb-entry" data-item-id="${x.id}">
    <div class="item-head"><div style="flex:1"><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><h3>${x.english}</h3></div><span class="pill ${statusClass(p.status)}">${p.status}</span></div>
    <div class="meta">Root: <span lang="ar" dir="rtl">${x.root||'—'}</span> · Form: ${x.form||'—'}</div>
    <div class="verb-tag-row">${x.category?`<span class="verb-tag" lang="ar" dir="rtl">${x.category}</span>`:''}${x.verb_type?`<span class="verb-tag" lang="ar" dir="rtl">${x.verb_type}</span>`:''}${x.subtype?`<span class="verb-tag" lang="ar" dir="rtl">${x.subtype}</span>`:''}</div>
    <details class="verb-reference-details"><summary>Full reference</summary><div class="verb-data-grid">
      ${verbDataCell('Past',x.past,true)}${verbDataCell('Present',x.present,true)}${verbDataCell('Command',x.command,true)}${verbDataCell('Prohibition',x.prohibition,true)}${verbDataCell('Maṣdar',x.masdar,true)}
      ${verbDataCell('Active participle',x.active_participle,true)}${verbDataCell('Passive participle',x.passive_participle,true)}${verbDataCell('Pattern',x.pattern,true)}${verbDataCell('Category',x.category,true)}${verbDataCell('Verb type',x.verb_type,true)}${verbDataCell('Source',sourceValues(x))}
    </div></details>
    <div class="meta">Revised ${p.timesRevised||0} time${p.timesRevised===1?'':'s'}</div>${statusControls(x)}
  </article>`;
}
function switchVerbPanel(panel){
  const r=document.getElementById('verbReferencePanel'),t=document.getElementById('verbTestingPanel');if(!r||!t)return;
  const test=panel==='testing';r.classList.toggle('hidden',test);t.classList.toggle('hidden',!test);
  document.querySelectorAll('[data-verb-panel]').forEach(b=>b.classList.toggle('active',b.dataset.verbPanel===panel));
  if(test&&!currentVerbTest)newVerbTestCard();
}
function verbTestPool(){
  const f=document.getElementById('formFilter')?.value||'',t=document.getElementById('verbTypeFilter')?.value||'';
  return DATA.verbs.filter(x=>(!f||x.form===f)&&(!t||x.verb_type===t));
}
function newVerbTestCard(){
  const pool=verbTestPool(),p=document.getElementById('verbTestPrompt'),a=document.getElementById('verbTestAnswer');if(!p||!a)return;
  a.classList.add('hidden');a.innerHTML='';
  if(!pool.length){currentVerbTest=null;p.textContent='No verbs match the current filters.';p.className='verb-test-prompt';return;}
  currentVerbTest=pool[Math.floor(Math.random()*pool.length)];
  const m=document.getElementById('verbTestMode')?.value||'ar-en';let v='',ar=false;
  if(m==='ar-en'){v=currentVerbTest.arabic;ar=true}else if(m==='en-ar')v=currentVerbTest.english;else if(m==='past-present'){v=currentVerbTest.past;ar=true}else if(m==='present-past'){v=currentVerbTest.present;ar=true}else{v=currentVerbTest.arabic;ar=true}
  p.textContent=v;p.className='verb-test-prompt'+(ar?' arabic':'');
  const meta=document.getElementById('verbTestMeta');if(meta)meta.textContent=progressFor(currentVerbTest.id).status+' · '+(currentVerbTest.verb_type||'Verb');
}
function revealVerbTest(){
  if(!currentVerbTest)return;
  const m=document.getElementById('verbTestMode')?.value||'ar-en';
  const main=m==='ar-en'?currentVerbTest.english:m==='en-ar'?currentVerbTest.arabic:m==='past-present'?currentVerbTest.present:m==='present-past'?currentVerbTest.past:m==='root'?currentVerbTest.root:m==='form'?currentVerbTest.form:(currentVerbTest.masdar||'—');
  const b=document.getElementById('verbTestAnswer');
  b.innerHTML=`<div class="verb-answer-main">${main}</div><div class="verb-bio-grid">
    <div class="verb-bio"><span>Root</span><strong class="verb-ar">${currentVerbTest.root||'—'}</strong></div>
    <div class="verb-bio"><span>Past</span><strong class="verb-ar">${currentVerbTest.past||'—'}</strong></div>
    <div class="verb-bio"><span>Present</span><strong class="verb-ar">${currentVerbTest.present||'—'}</strong></div>
    <div class="verb-bio"><span>Command</span><strong class="verb-ar">${currentVerbTest.command||'—'}</strong></div>
    <div class="verb-bio"><span>Prohibition</span><strong class="verb-ar">${currentVerbTest.prohibition||'—'}</strong></div>
    <div class="verb-bio"><span>Maṣdar</span><strong class="verb-ar">${currentVerbTest.masdar||'—'}</strong></div>
    <div class="verb-bio"><span>Form</span><strong>${currentVerbTest.form||'—'}</strong></div>
    <div class="verb-bio"><span>Category</span><strong class="verb-ar">${currentVerbTest.category||'—'}</strong></div>
    <div class="verb-bio"><span>Verb type</span><strong class="verb-ar">${currentVerbTest.verb_type||'—'}</strong></div>
  </div>${statusControls(currentVerbTest)}`;
  b.classList.remove('hidden');bindDynamicButtons();
}
function sarfCard(x){
  const pat=[x.past_pattern,x.present_pattern,x.masdar_pattern].filter(Boolean).join(' · ');
  return `<article class="sarf-card"><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><h4>${x.english}</h4><p>${x.summary||''}</p>${pat?`<div class="sarf-pattern" lang="ar" dir="rtl">${pat}</div>`:''}</article>`;
}
function renderSarf(){
  const f=document.getElementById('sarfSectionFilter')?.value||'',rows=DATA.sarf.filter(x=>!f||x.section===f),sections={};
  rows.forEach(x=>{const s=x.section||'General';(sections[s]??=[]).push(x)});
  const o=document.getElementById('sarfOverview');if(o)o.innerHTML=[['Topics',DATA.sarf.length],['Sections',unique(DATA.sarf.map(x=>x.section)).length],['Derived Forms',DATA.sarf.filter(x=>x.form).length]].map(([a,b])=>`<div class="sarf-overview-card"><span>${a}</span><strong>${b}</strong></div>`).join('');
  const l=document.getElementById('sarfList');if(l)l.innerHTML=Object.entries(sections).map(([s,it])=>`<section class="sarf-section-block"><h3 class="sarf-section-title">${s}</h3><div class="sarf-grid">${it.map(sarfCard).join('')}</div></section>`).join('')||'<p>No Sarf topics match this filter.</p>';
}

function speakingCard(x){
  const p=progressFor(x.id);
  return `<article class="item">
    <div class="item-head">
      <div style="flex:1">
        <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
        <h3>${x.english}</h3>
      </div>
      <span class="pill ${statusClass(p.status)}">${p.status}</span>
    </div>
    <div class="meta">${x.topic} · Revised ${p.timesRevised||0} time${p.timesRevised===1?'':'s'}</div>
    ${statusControls(x)}
  </article>`;
}
function bindDynamicButtons(){
  document.querySelectorAll('[data-status-id]').forEach(btn=>btn.onclick=()=>{
    patchProgress(btn.dataset.statusId,{status:btn.dataset.status});
  });
  document.querySelectorAll('[data-fav-id]').forEach(btn=>btn.onclick=()=>{
    const p=progressFor(btn.dataset.favId);
    patchProgress(btn.dataset.favId,{favourite:!p.favourite});
  });
}
function renderVocabulary(){
  const q=(document.getElementById('vocabSearch')?.value||'').toLowerCase();
  const category=document.getElementById('categoryFilter')?.value||'';
  const type=document.getElementById('typeFilter')?.value||'';
  const source=document.getElementById('sourceFilter')?.value||'';
  const status=document.getElementById('statusFilter')?.value||'';
  const fav=document.getElementById('favouriteFilter')?.checked||false;
  let rows=DATA.vocabulary.filter(x=>{
    const hay=[x.arabic,x.english,x.root,x.topic,x.category,...sourceValues(x)].join(' ').toLowerCase();
    const p=progressFor(x.id);
    return hay.includes(q)&&(!category||x.category===category)&&(!type||x.type===type)&&(!source||sourceValues(x).includes(source))&&(!status||p.status===status)&&(!fav||p.favourite);
  });
  rows=filterByMetric(rows,SECTION_METRIC_FILTERS.vocabulary);
  rows.sort((a,b)=>String(a.category||'').localeCompare(String(b.category||''))||String(a.topic||'').localeCompare(String(b.topic||''))||String(a.english||'').localeCompare(String(b.english||'')));
  rows=sortRecentlyCoveredLast(rows);
  document.getElementById('vocabList').innerHTML=`
    <div class="traffic-legend">
      <span class="traffic-dot not">Not Started</span><span class="traffic-dot learning">Learning</span><span class="traffic-dot covered">Covered</span><span class="traffic-dot confident">Confident</span><span class="traffic-dot mastered">Mastered</span>
    </div>`+(rows.map(vocabCard).join('')||'<p>No matches.</p>');
  bindDynamicButtons();
}

function renderRoots(){
  const groups=getRootGroups();
  const sort=document.getElementById('rootSort')?.value||'weakest';
  let entries=Object.entries(groups).map(([root,items])=>({root,items,progress:rootProgress(items)}));
  if(ROOT_METRIC_FILTER==='not-started')entries=entries.filter(x=>x.progress.pct===0);
  if(ROOT_METRIC_FILTER==='started')entries=entries.filter(x=>x.progress.pct>0);
  if(ROOT_METRIC_FILTER==='strong')entries=entries.filter(x=>x.progress.pct>=75);
  if(ROOT_METRIC_FILTER==='mastered')entries=entries.filter(x=>x.progress.pct===100);
  if(sort==='weakest') entries.sort((a,b)=>a.progress.pct-b.progress.pct||b.items.length-a.items.length);
  if(sort==='strongest') entries.sort((a,b)=>b.progress.pct-a.progress.pct||b.items.length-a.items.length);
  if(sort==='largest') entries.sort((a,b)=>b.items.length-a.items.length||a.root.localeCompare(b.root,'ar'));
  if(sort==='alphabetical') entries.sort((a,b)=>a.root.localeCompare(b.root,'ar'));
  document.getElementById('rootsList').innerHTML=entries.map(({root,items,progress:p})=>{
    const state=p.pct===100?'mastered-root':p.pct===0?'not-started-root':'learning-root';
    return `<div class="root-card ${state}">
      <div class="root-title" lang="ar" dir="rtl">${root}</div>
      <div class="root-family-count">${items.length} related item${items.length===1?'':'s'}</div>
      <div class="root-progress-head"><strong>Family progress</strong><span class="root-percent">${p.pct}%</span></div>
      <div class="root-progress-bar"><div class="root-progress-fill" style="width:${p.pct}%"></div></div>
      <div class="root-status-grid">
        <div class="root-status-chip notstarted"><strong>${p.notStarted}</strong>Not started</div>
        <div class="root-status-chip learning"><strong>${p.learning+p.covered}</strong>Learning</div>
        <div class="root-status-chip confident"><strong>${p.confident}</strong>Confident</div>
        <div class="root-status-chip mastered"><strong>${p.mastered}</strong>Mastered</div>
      </div>
      <div class="root-family-words" lang="ar" dir="rtl">${items.map(x=>`<button type="button" class="root-word-link ${statusClass(itemStatus(x.id))}" data-root-item-id="${x.id}">${x.arabic}</button>`).join(' ')}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-root-item-id]').forEach(btn=>{
    btn.onclick=()=>openRootItem(btn.dataset.rootItemId);
  });
}
function renderVerbs(){
  const form=document.getElementById('formFilter')?.value||'',type=document.getElementById('verbTypeFilter')?.value||'',q=(document.getElementById('verbSearch')?.value||'').toLowerCase();
  let rows=DATA.verbs.filter(x=>{const h=[x.arabic,x.english,x.root,x.form,x.category,x.verb_type,x.masdar].join(' ').toLowerCase();return(!form||x.form===form)&&(!type||x.verb_type===type)&&h.includes(q)});rows=filterByMetric(rows,SECTION_METRIC_FILTERS.verbs);
  rows=sortRecentlyCoveredLast(rows);document.getElementById('verbsList').innerHTML=rows.map(verbCard).join('')||'<p>No verbs match these filters.</p>';bindDynamicButtons();
}
function renderSpeaking(){
  const topic=document.getElementById('speakingTopicFilter')?.value||'';
  let rows=DATA.speaking.filter(x=>!topic||x.topic===topic);rows=filterByMetric(rows,SECTION_METRIC_FILTERS.speaking);
  rows=sortRecentlyCoveredLast(rows);
  document.getElementById('speakingList').innerHTML=rows.map(speakingCard).join('');
  bindDynamicButtons();
}
function progressItemCard(x){
  const p=progressFor(x.id);
  return `<article class="item progress-item"><div class="item-head"><div><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><strong>${x.english}</strong></div><span class="pill ${statusClass(p.status)}">${p.status}</span></div><div class="meta">${x.topic||x.category||x.verb_type||'General'}</div></article>`;
}
function renderProgress(){
  const all=[...DATA.vocabulary,...DATA.verbs,...DATA.speaking,...DATA.nahw];
  const count=s=>all.filter(x=>itemStatus(x.id)===s).length;
  const favourites=all.filter(x=>progressFor(x.id).favourite).length;
  const cards=[
    ['Total',all.length,'','all'],['Not Started',count('Not Started'),'status-not-started','Not Started'],
    ['Covered',count('Covered'),'status-covered','Covered'],['Learning',count('Learning'),'status-learning','Learning'],
    ['Confident',count('Confident'),'status-confident','Confident'],['Mastered',count('Mastered'),'status-mastered','Mastered'],
    ['Favourites',favourites,'','favourites']
  ];
  document.getElementById('progressSummary').innerHTML=cards.map(([a,b,cls,f])=>`<button class="summary-card progress-summary-clickable ${cls} ${PROGRESS_METRIC_FILTER===f?'selected':''}" data-progress-filter="${f}"><span>${a}</span><strong>${b}</strong></button>`).join('');
  document.querySelectorAll('[data-progress-filter]').forEach(btn=>btn.onclick=()=>{PROGRESS_METRIC_FILTER=btn.dataset.progressFilter;renderProgress();});
  const drill=document.getElementById('progressDrilldown');
  if(PROGRESS_METRIC_FILTER==='all'){drill.classList.add('hidden');drill.innerHTML='';}
  else{
    const rows=filterByMetric(all,PROGRESS_METRIC_FILTER);
    drill.classList.remove('hidden');
    drill.innerHTML=`<div class="progress-drilldown-head"><h3>${PROGRESS_METRIC_FILTER}</h3><span>${rows.length} item${rows.length===1?'':'s'}</span></div><div class="list">${rows.map(progressItemCard).join('')||'<p>No items.</p>'}</div>`;
  }
  const topics={};
  all.forEach(x=>{const t=x.topic||x.category||x.verb_type||'Uncategorised';(topics[t]??=[]).push(x);});
  document.getElementById('topicProgress').innerHTML=Object.entries(topics).sort().map(([topic,items])=>{
    const c=items.filter(x=>itemStatus(x.id)!=='Not Started').length,p=Math.round(c/items.length*100);
    return `<div class="topic-row"><div class="topic-top"><strong>${topic}</strong><span>${c}/${items.length} covered</span></div><div class="progress-bar"><div class="progress-fill" style="width:${p}%"></div></div></div>`;
  }).join('');
  const recent=all.map(x=>({x,p:progressFor(x.id)})).filter(o=>o.p.dateCovered).sort((a,b)=>new Date(b.p.dateCovered)-new Date(a.p.dateCovered)).slice(0,6);
  document.getElementById('recentlyCovered').innerHTML=recent.length?recent.map(o=>`<article class="item"><div class="arabic" lang="ar" dir="rtl">${o.x.arabic}</div><strong>${o.x.english}</strong><div class="meta">${o.p.status} · Covered ${formatDate(o.p.dateCovered)}</div></article>`).join(''):'<p class="meta">Nothing marked as covered yet.</p>';
}

function nahwCard(x){
  const p=progressFor(x.id);
  return `<article class="item">
    <div class="item-head">
      <div style="flex:1">
        <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
        <h3>${x.english}</h3>
      </div>
      <span class="pill ${statusClass(p.status)}">${p.status}</span>
    </div>
    <div class="meta">${x.topic}</div>
    <p>${x.summary||''}</p>
    ${x.example?`<div class="example" lang="ar" dir="rtl">${x.example}</div><div class="meta">${x.example_en||''}</div>`:''}
    ${statusControls(x)}
  </article>`;
}
function renderNahw(){
  const topic=document.getElementById('nahwTopicFilter')?.value||'';
  let concepts=DATA.nahw.filter(x=>!topic||x.topic===topic);
  concepts=filterByMetric(concepts,SECTION_METRIC_FILTERS.nahw);
  concepts=sortRecentlyCoveredLast(concepts);
  const keyBox=document.getElementById('nahwKeyTerms');
  if(keyBox)keyBox.innerHTML='';
  document.getElementById('nahwList').innerHTML=concepts.map(nahwCard).join('')||'<p>No concepts match this filter.</p>';
  bindDynamicButtons();
}

function revisionPool(){
  const mode=document.getElementById('revisionMode')?.value||'ar-en';
  const subset=document.getElementById('revisionSubset')?.value||'all';
  let pool;
  if(mode==='speaking') pool=DATA.speaking;
  else if(mode==='verbs') pool=DATA.verbs;
  else if(mode==='nahw') pool=DATA.nahw;
  else pool=DATA.vocabulary;
  pool=pool.filter(x=>{
    const p=progressFor(x.id);
    if(subset==='all') return true;
    if(subset==='favourites') return p.favourite;
    const map={'not-started':'Not Started','learning':'Learning','covered':'Covered','confident':'Confident'};
    return p.status===map[subset];
  });
  return pool;
}
function newRevisionCard(){
  const mode=document.getElementById('revisionMode')?.value||'ar-en';
  const pool=revisionPool();
  const prompt=document.getElementById('flashPrompt');
  const answer=document.getElementById('flashAnswer');
  document.getElementById('ratingButtons').classList.add('hidden');
  answer.classList.add('hidden');
  if(!pool.length){
    currentCard=null;
    prompt.textContent='No items match this revision filter.';
    prompt.className='flash-prompt';
    answer.textContent='';
    updateFlashMeta();
    return;
  }
  currentCard=pool[Math.floor(Math.random()*pool.length)];
  if(mode==='ar-en'){
    prompt.textContent=currentCard.arabic;prompt.className='flash-prompt arabic';
    answer.textContent=currentCard.english;answer.className='flash-answer hidden';
  } else if(mode==='nahw'){
    prompt.textContent=currentCard.english;prompt.className='flash-prompt';
    answer.innerHTML=`<div class="arabic" lang="ar" dir="rtl">${currentCard.arabic}</div><div>${currentCard.summary||''}</div>`;
    answer.className='flash-answer hidden';
  } else {
    prompt.textContent=currentCard.english;prompt.className='flash-prompt';
    answer.textContent=currentCard.arabic;answer.className='flash-answer arabic hidden';
  }
  updateFlashMeta();
}
function updateFlashMeta(){
  const meta=document.getElementById('flashMeta');
  const star=document.getElementById('flashFavourite');
  const info=document.getElementById('revisionInfo');
  if(!currentCard){meta.textContent='Revision';star.textContent='☆';info.textContent='';return;}
  const p=progressFor(currentCard.id);
  meta.textContent=`${p.status} · ${currentCard.topic||'General'}`;
  star.textContent=p.favourite?'★':'☆';
  star.classList.toggle('on',p.favourite);
  info.textContent=`Revised ${p.timesRevised||0} time${p.timesRevised===1?'':'s'}${p.lastRevised?` · Last ${formatDate(p.lastRevised)}`:''}`;
}
function rateCurrent(rating){
  if(!currentCard)return;
  const p=progressFor(currentCard.id);
  const now=new Date().toISOString();
  let patch={timesRevised:(p.timesRevised||0)+1,lastRevised:now};
  if(rating==='Again'){patch.incorrectCount=(p.incorrectCount||0)+1;patch.status='Learning';}
  if(rating==='Learning'){patch.correctCount=(p.correctCount||0)+1;patch.status='Learning';}
  if(rating==='Know It'){patch.correctCount=(p.correctCount||0)+1;patch.status=p.status==='Confident'?'Mastered':'Confident';}
  const all=loadProgress(); all[currentCard.id]={...p,...patch};
  if(!all[currentCard.id].dateCovered) all[currentCard.id].dateCovered=now;
  saveProgress(all);
  if(currentUser) pushProgress(currentCard.id, all[currentCard.id]);
  renderAll(); newRevisionCard();
}
function formatDate(s){return new Date(s).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
function bindEvents(){
  ['vocabSearch','categoryFilter','typeFilter','sourceFilter','statusFilter','favouriteFilter'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>{SECTION_METRIC_FILTERS.vocabulary='all';renderSectionDashboards();renderVocabulary();}));
  document.getElementById('formFilter').addEventListener('input',()=>{SECTION_METRIC_FILTERS.verbs='all';renderSectionDashboards();renderVerbs();if(currentVerbTest)newVerbTestCard();});
  document.getElementById('verbTypeFilter')?.addEventListener('input',()=>{SECTION_METRIC_FILTERS.verbs='all';renderSectionDashboards();renderVerbs();if(currentVerbTest)newVerbTestCard();});
  document.getElementById('verbSearch')?.addEventListener('input',renderVerbs);
  document.querySelectorAll('[data-verb-panel]').forEach(btn=>btn.addEventListener('click',()=>switchVerbPanel(btn.dataset.verbPanel)));
  document.getElementById('newVerbTestBtn')?.addEventListener('click',newVerbTestCard);
  document.getElementById('revealVerbTestBtn')?.addEventListener('click',revealVerbTest);
  document.getElementById('verbTestMode')?.addEventListener('change',newVerbTestCard);
  document.getElementById('sarfSectionFilter')?.addEventListener('input',renderSarf);
  document.getElementById('rootSort')?.addEventListener('input',renderRoots);
  document.getElementById('speakingTopicFilter').addEventListener('input',()=>{SECTION_METRIC_FILTERS.speaking='all';renderSectionDashboards();renderSpeaking();});
  document.getElementById('nahwTopicFilter').addEventListener('input',()=>{SECTION_METRIC_FILTERS.nahw='all';renderSectionDashboards();renderNahw();});
  document.getElementById('showKeyTermsBtn')?.addEventListener('click',()=>{
    const box=document.getElementById('nahwKeyTerms');
    const btn=document.getElementById('showKeyTermsBtn');
    if(!box||!btn)return;
    const isHidden=box.classList.toggle('hidden');
    btn.textContent=isHidden?'Show key terms':'Hide key terms';
  });
  document.getElementById('revisionMode').addEventListener('change',newRevisionCard);
  document.getElementById('revisionSubset').addEventListener('change',newRevisionCard);
  document.getElementById('newCardBtn').addEventListener('click',newRevisionCard);
  document.getElementById('revealBtn').addEventListener('click',()=>{
    if(!currentCard)return;
    document.getElementById('flashAnswer').classList.remove('hidden');
    document.getElementById('ratingButtons').classList.remove('hidden');
  });
  document.querySelectorAll('[data-rating]').forEach(btn=>btn.addEventListener('click',()=>rateCurrent(btn.dataset.rating)));
  document.getElementById('flashFavourite').addEventListener('click',()=>{
    if(!currentCard)return;
    const p=progressFor(currentCard.id);
    patchProgress(currentCard.id,{favourite:!p.favourite});updateFlashMeta();
  });
  document.getElementById('resetProgressBtn').addEventListener('click',()=>{
    if(confirm('Reset all saved learning progress on this device?')){
      localStorage.removeItem(STORE_KEY);
      if(currentUser && firebaseDb){
        firebaseDb.collection('users').doc(currentUser.uid).collection('progress').get().then(async snap=>{
          const batch=firebaseDb.batch();
          snap.forEach(doc=>batch.delete(doc.ref));
          await batch.commit();
        }).catch(err=>console.error('Cloud progress reset error',err));
      }
      renderAll();newRevisionCard();
    }
  });
  document.getElementById('globalSearch').addEventListener('input',e=>{
    const q=e.target.value.trim().toLowerCase();
    const box=document.getElementById('searchResults');
    if(!q){box.classList.add('hidden');box.innerHTML='';return;}
    const vocab=DATA.vocabulary.filter(x=>[x.arabic,x.english,x.root,x.topic].join(' ').toLowerCase().includes(q));
    const verbs=DATA.verbs.filter(x=>[x.arabic,x.english,x.root,x.topic,x.form].join(' ').toLowerCase().includes(q));
    const speaking=DATA.speaking.filter(x=>[x.arabic,x.english,x.topic].join(' ').toLowerCase().includes(q));
    const nahw=DATA.nahw.filter(x=>[x.arabic,x.english,x.topic,x.summary].join(' ').toLowerCase().includes(q));
    const sarf=DATA.sarf.filter(x=>[x.arabic,x.english,x.section,x.summary].join(' ').toLowerCase().includes(q));
    box.classList.remove('hidden');
    box.innerHTML=[...vocab.map(vocabCard),...verbs.map(verbCard),...speaking.map(speakingCard),...nahw.map(nahwCard),...sarf.map(sarfCard)].join('')||'<p>No matches.</p>';
    bindDynamicButtons();
  });
}
loadData();
