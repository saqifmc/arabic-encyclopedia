let deployedVersion = '';
let updateCheckTimer = null;

async function fetchDeployVersion(){
  try{
    const res = await fetch('version.json?t='+Date.now(), {cache:'no-store'});
    if(!res.ok) return '';
    const data = await res.json();
    return String(data.version || data.sha || '').trim();
  }catch(err){
    return '';
  }
}

function showUpdateBanner(version){
  const banner=document.getElementById('updateBanner');
  if(!banner || !version) return;
  if(sessionStorage.getItem('arabicUpdateDismissed')===version) return;
  banner.dataset.version=version;
  banner.classList.remove('hidden');
}

async function checkForAppUpdate(initial=false){
  const latest=await fetchDeployVersion();
  if(!latest) return;
  const stored=localStorage.getItem('arabicAppVersion') || '';
  if(initial){
    deployedVersion=latest;
    if(!stored){
      localStorage.setItem('arabicAppVersion', latest);
      return;
    }
    if(stored!==latest) showUpdateBanner(latest);
    return;
  }
  if(deployedVersion && latest!==deployedVersion) showUpdateBanner(latest);
  else if(stored && stored!==latest) showUpdateBanner(latest);
}

function initUpdateChecker(){
  const refreshBtn=document.getElementById('refreshAppBtn');
  const dismissBtn=document.getElementById('dismissUpdateBtn');
  refreshBtn?.addEventListener('click',()=>{
    const banner=document.getElementById('updateBanner');
    const version=banner?.dataset.version || deployedVersion || '';
    if(version) localStorage.setItem('arabicAppVersion', version);
    const url=new URL(window.location.href);
    url.searchParams.set('appv', version.slice(0,12) || Date.now().toString());
    window.location.replace(url.toString());
  });
  dismissBtn?.addEventListener('click',()=>{
    const banner=document.getElementById('updateBanner');
    const version=banner?.dataset.version || '';
    if(version) sessionStorage.setItem('arabicUpdateDismissed',version);
    banner?.classList.add('hidden');
  });
  checkForAppUpdate(true);
  window.addEventListener('focus',()=>checkForAppUpdate(false));
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') checkForAppUpdate(false);
  });
  updateCheckTimer=setInterval(()=>checkForAppUpdate(false),5*60*1000);
}

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
    firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(err=>{
      console.error('Firebase persistence error',err);
    });
    return true;
  }catch(err){
    console.error('Firebase initialization error',err);
    firebaseInitError = 'Firebase could not initialise in this browser.';
    return false;
  }
}

function normaliseCloudDate(value){
  if(!value) return null;
  if(typeof value==='string') return value;
  if(value?.toDate) return value.toDate().toISOString();
  if(typeof value?.seconds==='number') return new Date(value.seconds*1000).toISOString();
  return null;
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
        dateCovered:normaliseCloudDate(r.dateCovered),
        lastRevised:normaliseCloudDate(r.lastRevised),
        timesRevised:r.timesRevised || 0,
        correctCount:r.correctCount || 0,
        incorrectCount:r.incorrectCount || 0
      };
    });
    const local=loadProgress();
    const merged={...local,...remoteProgress};
    PROGRESS_CACHE=merged;
    localStorage.setItem(STORE_KEY,JSON.stringify(merged));
    syncReady=true;

    // Upload any progress that exists on this device but not yet in Firestore.
    const missing=Object.entries(local).filter(([id])=>!remoteProgress[id]);
    if(missing.length){
      const batch=firebaseDb.batch();
      missing.forEach(([id,value])=>{
        const ref=firebaseDb.collection('users').doc(currentUser.uid).collection('progress').doc(id);
        batch.set(ref,{
          status:value.status||'Not Started',
          favourite:!!value.favourite,
          dateCovered:value.dateCovered||null,
          lastRevised:value.lastRevised||null,
          timesRevised:value.timesRevised||0,
          correctCount:value.correctCount||0,
          incorrectCount:value.incorrectCount||0,
          updatedAt:firebase.firestore.FieldValue.serverTimestamp()
        },{merge:true});
      });
      await batch.commit();
    }

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

    const isiOS=/iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone=window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;

    // iOS Home Screen apps frequently block auth pop-ups, so use a full-page
    // redirect there. Desktop browsers continue to use the popup flow.
    if(isiOS || isStandalone){
      await firebaseAuth.signInWithRedirect(provider);
      return;
    }

    const popupPromise=firebaseAuth.signInWithPopup(provider);
    const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>{
      const e=new Error('Google sign-in timed out after the account window completed.');
      e.code='auth/popup-timeout';
      reject(e);
    },15000));
    const result=await Promise.race([popupPromise,timeoutPromise]);

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
      msg='Your browser blocked the Google sign-in window. On iPhone, refresh the site and try again; it will now use full-page sign-in.';
    }else if(err?.code==='auth/cancelled-popup-request'){
      msg='Another Google sign-in window is already open. Close it and try again.';
    }else if(err?.code==='auth/popup-timeout'){
      msg='Google accepted the sign-in, but the browser did not return the session. Refresh once and try again.';
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

const SECTION_METRIC_FILTERS = { vocabulary:'all', verbs:'all' };
let ROOT_METRIC_FILTER = 'all';
let VOCAB_COLLECTION_FILTER = 'all';
let VERB_COLLECTION_FILTER = 'all';
const VOCAB_PAGE_SIZE = 24;
const VERB_PAGE_SIZE = 24;
let VOCAB_PAGE = 1;
let VERB_PAGE = 1;
let PROGRESS_METRIC_FILTER = 'all';

let DATA = { vocabulary: [], verbs: [], speaking: [], nahw: [], sarf: [], quranicTarkeeb: [] };
let currentCard = null;
const STORE_KEY = 'arabicEncyclopediaProgressV2';
const QURAN_TRANSLATION_STORE_KEY = 'arabicEncyclopediaQuranTranslationV1';
const STATUSES = ['Not Started','Covered','Learning','Confident','Mastered'];
const ARABIC_ALPHABET = ['ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي'];

let PROGRESS_CACHE=null;
function loadProgress(){
  if(PROGRESS_CACHE) return PROGRESS_CACHE;
  try{PROGRESS_CACHE=JSON.parse(localStorage.getItem(STORE_KEY)) || {};}catch(e){PROGRESS_CACHE={};}
  return PROGRESS_CACHE;
}
function saveProgress(p){
  PROGRESS_CACHE=p;
  localStorage.setItem(STORE_KEY, JSON.stringify(p));
}
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
  const [vocabRes, verbsRes, speakingRes, nahwRes, sarfRes, quranRes] = await Promise.all([
    fetch('vocab.json?v=20261005-quran-high-frequency-vocab'), fetch('verbs.json?v=20261005-quran-high-frequency-verbs'), fetch('speaking.json'), fetch('nahw.json'), fetch('sarf.json'), fetch('quranic-tarkeeb.json?v=20261006-translation-toggle')
  ]);
  const vocabData=await vocabRes.json();
  const verbsData=await verbsRes.json();
  const speakingData=await speakingRes.json();
  const nahwData=await nahwRes.json();
  const sarfData=await sarfRes.json();
  const quranData=await quranRes.json();
  DATA={vocabulary:vocabData.vocabulary||[],verbs:verbsData.verbs||[],speaking:speakingData.speaking||[],nahw:nahwData.nahw||[],sarf:sarfData.sarf||[],quranicTarkeeb:quranData.surahs||[]};
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
    firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(()=>{
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

      firebaseAuth.getRedirectResult().then(async result=>{
        if(result?.user){
          currentUser=result.user;
          setAuthMessage('Signed in. Loading your progress…');
          await loadRemoteProgress();
          updateAuthUI();
          setAuthMessage('');
        }
      }).catch(err=>{
        console.error('Firebase redirect sign-in error',err);
        setAuthMessage(err?.message||'Google sign-in could not be completed.');
      });
    }).catch(err=>{
      console.error('Firebase persistence setup error',err);
      setAuthMessage('This browser could not keep your sign-in session. Progress will still stay on this device.');
    });
  }else{
    updateAuthUI();
    setAuthMessage(firebaseInitError || 'Firebase is not connected yet. Your progress is currently stored only on this device.');
  }
}
function bindNavigation(){
  initUpdateChecker();
  document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));
}
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.mobile-bottom-nav [data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===id));
  renderActiveView();
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
  fillSelect('babFilter',[...new Map(DATA.verbs.filter(x=>x.bab).sort((a,b)=>(a.bab_number||99)-(b.bab_number||99)).map(x=>[x.bab,x.bab])).values()]);
  fillSelect('sarfSectionFilter',unique(DATA.sarf.map(x=>x.section)));
  fillSelect('speakingTopicFilter',unique(DATA.speaking.map(x=>x.topic)));
  fillSelect('nahwTopicFilter',unique(DATA.nahw.map(x=>x.topic)));
  fillSelect('rootLetterFilter',ARABIC_ALPHABET);
}
function renderActiveView(){
  const id=document.querySelector('.view.active')?.id||'home';
  if(id==='vocabulary') renderVocabulary();
  else if(id==='roots') renderRoots();
  else if(id==='verbs') renderVerbs();
  else if(id==='sarf') renderSarf();
  else if(id==='speaking') renderSpeaking();
  else if(id==='nahw') renderNahw();
  else if(id==='quranic-tarkeeb') renderQuranicTarkeeb();
  else if(id==='progress') renderProgress();
}

function renderAll(){
  renderStats();
  renderSectionDashboards();
  renderActiveView();
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
  const allItems=[...DATA.vocabulary,...DATA.verbs];
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
    ['verbsDashboard',DATA.verbs,'verbs']
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
        VOCAB_PAGE=1;
        const status=document.getElementById('statusFilter'),fav=document.getElementById('favouriteFilter');
        if(status)status.value='';if(fav)fav.checked=false;
      }
      renderSectionDashboards();
      if(section==='vocabulary')renderVocabulary();
      if(section==='verbs'){VERB_PAGE=1;renderVerbs();}
      const target={vocabulary:'vocabList',verbs:'verbsList'}[section];
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
    VOCAB_PAGE=1;
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
    VERB_PAGE=1;
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
    <div class="vocab-source-row">${sourceValues(x).map(s=>`<span class="vocab-source-tag">${s}</span>`).join('')}${x.quran_frequency?`<span class="quran-frequency-tag">Qur'an occurrences: ${x.quran_frequency}</span>`:''}</div>
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
    <div class="meta">Root: <span lang="ar" dir="rtl">${x.root||'—'}</span> · Form: ${x.form||'—'}${x.bab?` · Bāb: <span lang="ar" dir="rtl">${x.bab}</span>`:''}</div>
    <div class="verb-tag-row">${x.category?`<span class="verb-tag" lang="ar" dir="rtl">${x.category}</span>`:''}${x.verb_type?`<span class="verb-tag" lang="ar" dir="rtl">${x.verb_type}</span>`:''}${x.bab?`<span class="verb-tag" lang="ar" dir="rtl">${x.bab}</span>`:''}${x.subtype?`<span class="verb-tag" lang="ar" dir="rtl">${x.subtype}</span>`:''}</div>
    <div class="vocab-source-row">${sourceValues(x).map(s=>`<span class="vocab-source-tag">${s}</span>`).join('')}${x.quran_frequency?`<span class="quran-frequency-tag">Qur'an occurrences: ${x.quran_frequency}</span>`:''}</div>
    <details class="verb-reference-details"><summary>Full reference</summary><div class="verb-data-grid">
      ${verbDataCell('Past',x.past,true)}${verbDataCell('Present',x.present,true)}${verbDataCell('Command',x.command,true)}${verbDataCell('Prohibition',x.prohibition,true)}${verbDataCell('Maṣdar',x.masdar,true)}
      ${verbDataCell('Active participle',x.active_participle,true)}${verbDataCell('Passive participle',x.passive_participle,true)}${verbDataCell('Pattern',x.pattern,true)}${verbDataCell('Bāb',x.bab,true)}${verbDataCell('Category',x.category,true)}${verbDataCell('Verb type',x.verb_type,true)}${verbDataCell('Source',sourceValues(x))}
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
  const f=document.getElementById('formFilter')?.value||'',t=document.getElementById('verbTypeFilter')?.value||'',b=document.getElementById('babFilter')?.value||'';
  return DATA.verbs.filter(x=>{
    const collections=Array.isArray(x.collections)?x.collections:[];
    const inCollection=VERB_COLLECTION_FILTER==='all'||collections.includes(VERB_COLLECTION_FILTER);
    return inCollection&&(!f||x.form===f)&&(!t||x.verb_type===t)&&(!b||x.bab===b);
  });
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
  const main=m==='ar-en'?currentVerbTest.english:m==='en-ar'?currentVerbTest.arabic:m==='past-present'?currentVerbTest.present:m==='present-past'?currentVerbTest.past:m==='root'?currentVerbTest.root:m==='form'?currentVerbTest.form:m==='bab'?(currentVerbTest.bab||'—'):(currentVerbTest.masdar||'—');
  const b=document.getElementById('verbTestAnswer');
  b.innerHTML=`<div class="verb-answer-main">${main}</div><div class="verb-bio-grid">
    <div class="verb-bio"><span>Root</span><strong class="verb-ar">${currentVerbTest.root||'—'}</strong></div>
    <div class="verb-bio"><span>Past</span><strong class="verb-ar">${currentVerbTest.past||'—'}</strong></div>
    <div class="verb-bio"><span>Present</span><strong class="verb-ar">${currentVerbTest.present||'—'}</strong></div>
    <div class="verb-bio"><span>Command</span><strong class="verb-ar">${currentVerbTest.command||'—'}</strong></div>
    <div class="verb-bio"><span>Prohibition</span><strong class="verb-ar">${currentVerbTest.prohibition||'—'}</strong></div>
    <div class="verb-bio"><span>Maṣdar</span><strong class="verb-ar">${currentVerbTest.masdar||'—'}</strong></div>
    <div class="verb-bio"><span>Form</span><strong>${currentVerbTest.form||'—'}</strong></div>
    <div class="verb-bio"><span>Bāb</span><strong class="verb-ar">${currentVerbTest.bab||'—'}</strong></div>
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
  return `<article class="item speaking-reference-card">
    <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
    <h3>${x.english}</h3>
    <div class="meta">${x.topic}</div>
  </article>`;
}
function bindDynamicButtons(){
  // Status/favourite controls use one delegated click handler in bindEvents().
  // This keeps newly rendered testing/reference cards clickable without rebinding.
}

function paginationMarkup(kind,currentPage,total,pageSize){
  const totalPages=Math.max(1,Math.ceil(total/pageSize));
  if(total===0) return '';
  const page=Math.min(Math.max(1,currentPage),totalPages);
  const start=(page-1)*pageSize+1;
  const end=Math.min(page*pageSize,total);
  const pages=[];
  const candidates=new Set([1,totalPages,page-2,page-1,page,page+1,page+2].filter(n=>n>=1&&n<=totalPages));
  let last=0;
  [...candidates].sort((a,b)=>a-b).forEach(n=>{
    if(last && n-last>1) pages.push('<span class="pagination-ellipsis">…</span>');
    pages.push(`<button type="button" class="pagination-page ${n===page?'active':''}" data-page-kind="${kind}" data-page="${n}" aria-label="Page ${n}">${n}</button>`);
    last=n;
  });
  return `<nav class="catalog-pagination" aria-label="${kind} pages">
    <div class="pagination-summary">Showing ${start}–${end} of ${total}</div>
    <div class="pagination-controls">
      <button type="button" class="pagination-arrow" data-page-kind="${kind}" data-page="${page-1}" ${page===1?'disabled':''}>‹ Previous</button>
      ${pages.join('')}
      <button type="button" class="pagination-arrow" data-page-kind="${kind}" data-page="${page+1}" ${page===totalPages?'disabled':''}>Next ›</button>
    </div>
  </nav>`;
}

function bindPagination(){
  document.querySelectorAll('[data-page-kind]').forEach(btn=>btn.onclick=()=>{
    if(btn.disabled) return;
    const page=Number(btn.dataset.page)||1;
    if(btn.dataset.pageKind==='vocabulary'){
      VOCAB_PAGE=page;
      renderVocabulary();
      document.getElementById('vocabList')?.scrollIntoView({behavior:'smooth',block:'start'});
    }else if(btn.dataset.pageKind==='verbs'){
      VERB_PAGE=page;
      renderVerbs();
      document.getElementById('verbsList')?.scrollIntoView({behavior:'smooth',block:'start'});
    }
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
    const hay=[x.arabic,x.english,x.root,x.topic,x.quran_topic,x.category,...sourceValues(x)].join(' ').toLowerCase();
    const p=progressFor(x.id);
    const collections=Array.isArray(x.collections)?x.collections:[];
    const inCollection=VOCAB_COLLECTION_FILTER==='all'||collections.includes(VOCAB_COLLECTION_FILTER);
    return inCollection&&hay.includes(q)&&(!category||x.category===category)&&(!type||x.type===type)&&(!source||sourceValues(x).includes(source))&&(!status||p.status===status)&&(!fav||p.favourite);
  });
  rows=filterByMetric(rows,SECTION_METRIC_FILTERS.vocabulary);
  rows.sort((a,b)=>String(a.category||'').localeCompare(String(b.category||''))||String(a.topic||'').localeCompare(String(b.topic||''))||String(a.english||'').localeCompare(String(b.english||'')));
  rows=sortRecentlyCoveredLast(rows);
  const totalRows=rows.length;
  const totalPages=Math.max(1,Math.ceil(totalRows/VOCAB_PAGE_SIZE));
  VOCAB_PAGE=Math.min(VOCAB_PAGE,totalPages);
  const pageStart=(VOCAB_PAGE-1)*VOCAB_PAGE_SIZE;
  const visibleRows=rows.slice(pageStart,pageStart+VOCAB_PAGE_SIZE);
  const pager=paginationMarkup('vocabulary',VOCAB_PAGE,totalRows,VOCAB_PAGE_SIZE);
  document.getElementById('vocabList').innerHTML=pager+`
    <div class="traffic-legend">
      <span class="traffic-dot not">Not Started</span><span class="traffic-dot learning">Learning</span><span class="traffic-dot covered">Covered</span><span class="traffic-dot confident">Confident</span><span class="traffic-dot mastered">Mastered</span>
    </div>`+(visibleRows.map(vocabCard).join('')||'<p>No matches.</p>')+pager;
  bindDynamicButtons();
  bindPagination();
}

function rootInitial(root){
  const clean=String(root||'')
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\sـ]/g,'')
    .replace(/[أإآٱ]/g,'ا')
    .replace(/ى/g,'ي');
  return clean.charAt(0);
}

function renderRoots(){
  const groups=getRootGroups();
  const sort=document.getElementById('rootSort')?.value||'alphabetical';
  const letter=document.getElementById('rootLetterFilter')?.value||'';
  let entries=Object.entries(groups).map(([root,items])=>({root,items,progress:rootProgress(items)}));
  if(letter) entries=entries.filter(x=>rootInitial(x.root)===letter);
  if(ROOT_METRIC_FILTER==='not-started')entries=entries.filter(x=>x.progress.pct===0);
  if(ROOT_METRIC_FILTER==='started')entries=entries.filter(x=>x.progress.pct>0);
  if(ROOT_METRIC_FILTER==='strong')entries=entries.filter(x=>x.progress.pct>=75);
  if(ROOT_METRIC_FILTER==='mastered')entries=entries.filter(x=>x.progress.pct===100);
  if(sort==='weakest') entries.sort((a,b)=>a.progress.pct-b.progress.pct||b.items.length-a.items.length);
  if(sort==='strongest') entries.sort((a,b)=>b.progress.pct-a.progress.pct||b.items.length-a.items.length);
  if(sort==='largest') entries.sort((a,b)=>b.items.length-a.items.length||a.root.localeCompare(b.root,'ar'));
  if(sort==='alphabetical') entries.sort((a,b)=>String(a.root).localeCompare(String(b.root),'ar',{sensitivity:'base'}));
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
  }).join('')||'<p class="meta">No roots match this Arabic letter.</p>';
  document.querySelectorAll('[data-root-item-id]').forEach(btn=>{
    btn.onclick=()=>openRootItem(btn.dataset.rootItemId);
  });
}
function renderVerbs(){
  const form=document.getElementById('formFilter')?.value||'',type=document.getElementById('verbTypeFilter')?.value||'',bab=document.getElementById('babFilter')?.value||'',q=(document.getElementById('verbSearch')?.value||'').toLowerCase();
  let rows=DATA.verbs.filter(x=>{const h=[x.arabic,x.english,x.quran_english,x.root,x.form,x.bab,x.category,x.verb_type,x.masdar,...sourceValues(x)].join(' ').toLowerCase();const collections=Array.isArray(x.collections)?x.collections:[];const inCollection=VERB_COLLECTION_FILTER==='all'||collections.includes(VERB_COLLECTION_FILTER);return inCollection&&(!form||x.form===form)&&(!type||x.verb_type===type)&&(!bab||x.bab===bab)&&h.includes(q)});rows=filterByMetric(rows,SECTION_METRIC_FILTERS.verbs);
  rows=sortRecentlyCoveredLast(rows);
  const totalRows=rows.length;
  const totalPages=Math.max(1,Math.ceil(totalRows/VERB_PAGE_SIZE));
  VERB_PAGE=Math.min(VERB_PAGE,totalPages);
  const pageStart=(VERB_PAGE-1)*VERB_PAGE_SIZE;
  const visibleRows=rows.slice(pageStart,pageStart+VERB_PAGE_SIZE);
  const pager=paginationMarkup('verbs',VERB_PAGE,totalRows,VERB_PAGE_SIZE);
  document.getElementById('verbsList').innerHTML=pager+(visibleRows.map(verbCard).join('')||'<p>No verbs match these filters.</p>')+pager;
  bindDynamicButtons();
  bindPagination();
}
function renderSpeaking(){
  const topic=document.getElementById('speakingTopicFilter')?.value||'';
  let rows=DATA.speaking.filter(x=>!topic||x.topic===topic);
  document.getElementById('speakingList').innerHTML=rows.map(speakingCard).join('');
  bindDynamicButtons();
}
function progressItemCard(x){
  const p=progressFor(x.id);
  return `<article class="item progress-item"><div class="item-head"><div><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><strong>${x.english}</strong></div><span class="pill ${statusClass(p.status)}">${p.status}</span></div><div class="meta">${x.topic||x.category||x.verb_type||'General'}</div></article>`;
}
function renderProgress(){
  const all=[...DATA.vocabulary,...DATA.verbs];
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
  return `<article class="sarf-card nahw-foundation-card">
    <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
    <h4>${x.english}</h4>
    <p>${x.summary||''}</p>
    ${x.example?`<div class="example" lang="ar" dir="rtl">${x.example}</div><div class="meta">${x.example_en||''}</div>`:''}
  </article>`;
}

function renderNahw(){
  const f=document.getElementById('nahwTopicFilter')?.value||'';
  const rows=DATA.nahw.filter(x=>!f||x.topic===f);
  const sections={};
  rows.forEach(x=>{const s=x.topic||'General';(sections[s]??=[]).push(x);});

  const o=document.getElementById('nahwOverview');
  if(o)o.innerHTML=[
    ['Concepts',DATA.nahw.length],
    ['Sections',unique(DATA.nahw.map(x=>x.topic)).length],
    ['With Examples',DATA.nahw.filter(x=>x.example).length]
  ].map(([a,b])=>`<div class="sarf-overview-card"><span>${a}</span><strong>${b}</strong></div>`).join('');

  const l=document.getElementById('nahwList');
  if(l)l.innerHTML=Object.entries(sections).map(([s,it])=>`
    <section class="sarf-section-block nahw-section-block">
      <h3 class="sarf-section-title">${s}</h3>
      <div class="sarf-grid">${it.map(nahwCard).join('')}</div>
    </section>`).join('')||'<p>No Nahw concepts match this section.</p>';
}


function quranWordRow(words){
  return (words||[]).map(w=>`<div class="quran-word-chip">
    <span class="arabic" lang="ar" dir="rtl">${w.arabic}</span>
    <span class="english">${w.english}</span>
  </div>`).join('');
}

function quranTarkeebPart([word,label,note]){
  return `<div class="tarkeeb-word-card">
    <div class="grammar-chunk arabic" lang="ar" dir="rtl">${word}</div>
    <div class="tarkeeb-grammar">
      <b lang="ar" dir="rtl">${label}</b>
      <small>${note}</small>
    </div>
  </div>`;
}

function renderQuranicTarkeeb(){
  const select=document.getElementById('quranSurahFilter');
  const translationSelect=document.getElementById('quranTranslationFilter');
  const intro=document.getElementById('quranSurahIntro');
  const list=document.getElementById('quranAyahList');
  if(!select||!intro||!list) return;

  const selected=Number(select.value||1);
  const translation=translationSelect?.value||'abdel-haleem';
  const surah=DATA.quranicTarkeeb.find(x=>Number(x.number)===selected) || DATA.quranicTarkeeb[0];
  if(!surah){
    intro.innerHTML='<p>No Qur\'anic Tarkeeb data is available.</p>';
    list.innerHTML='';
    return;
  }

  const translationInfo=translation==='pickthall'
    ? {
        label:'Marmaduke Pickthall',
        note:'Full āyah translation uses Marmaduke Pickthall, <em>The Meaning of the Glorious Qur\'an</em>. Word-by-word glosses remain based on M. A. S. Abdel Haleem so the study layer stays consistent.'
      }
    : {
        label:'M. A. S. Abdel Haleem',
        note:'English terminology and word meanings are based on M. A. S. Abdel Haleem, <em>The Qur\'an</em> (Oxford World\'s Classics). Word glosses are matched to each āyah rather than taken from a generic dictionary.'
      };

  intro.innerHTML=`
    <div>
      <div class="arabic quran-surah-title" lang="ar" dir="rtl">${surah.arabic_name}</div>
      <h3>Sūrah ${surah.english_name} — ${surah.english_title||surah.note||''}</h3>
      <p>Sūrah ${surah.number} · ${surah.ayahs.length} āyah${surah.ayahs.length===1?'':'s'} · Tarkeeb & Iʿrāb</p>
    </div>
    <div class="translation-note">
      <strong>English translation · ${translationInfo.label}</strong>
      <p>${translationInfo.note}</p>
    </div>`;

  list.innerHTML=surah.ayahs.map(a=>{
    const verseMeaning=translation==='pickthall' ? (a.pickthall||a.sense||'') : (a.sense||'');
    return `
    <article class="quran-ayah-card">
      <div class="ayah-number">${a.n}</div>

      <div class="quran-verse-pair">
        <div class="quran-arabic" lang="ar" dir="rtl">${a.arabic}</div>
        <div class="quran-english"><span class="analysis-kicker">ENGLISH MEANING · ${translationInfo.label}</span>${verseMeaning}</div>
      </div>

      <div class="quran-word-section">
        <div class="analysis-kicker">WORD BY WORD</div>
        <div class="quran-word-strip" dir="rtl">${quranWordRow(a.words||[])}</div>
      </div>

      <div class="tarkeeb-summary" lang="ar" dir="rtl"><strong>التَّرْكِيبُ:</strong> ${a.summary||''}</div>

      <div class="grammar-section">
        <div class="analysis-kicker">GRAMMAR ANALYSIS</div>
        <div class="tarkeeb-grid">${(a.parts||[]).map(quranTarkeebPart).join('')}</div>
      </div>
    </article>`;
  }).join('');
}

function revisionPool(){
  const mode=document.getElementById('revisionMode')?.value||'vocab-ar-en';
  const subset=document.getElementById('revisionSubset')?.value||'all';

  let pool=mode.startsWith('verb-') ? DATA.verbs : DATA.vocabulary;

  if(mode==='vocab-root') pool=pool.filter(x=>x.root);
  if(mode==='verb-past-present') pool=pool.filter(x=>x.past&&x.present);
  if(mode==='verb-present-past') pool=pool.filter(x=>x.present&&x.past);
  if(mode==='verb-root') pool=pool.filter(x=>x.root);
  if(mode==='verb-form') pool=pool.filter(x=>x.form);
  if(mode==='verb-bab') pool=pool.filter(x=>x.bab);
  if(mode==='verb-masdar') pool=pool.filter(x=>x.masdar);

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
  const mode=document.getElementById('revisionMode')?.value||'vocab-ar-en';
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

  let promptText='';
  let answerText='';
  let promptArabic=false;
  let answerArabic=false;

  switch(mode){
    case 'vocab-ar-en':
    case 'verb-ar-en':
      promptText=currentCard.arabic||currentCard.past||'';
      answerText=currentCard.english||'';
      promptArabic=true;
      break;

    case 'vocab-en-ar':
    case 'verb-en-ar':
      promptText=currentCard.english||'';
      answerText=currentCard.arabic||currentCard.past||'';
      answerArabic=true;
      break;

    case 'vocab-root':
    case 'verb-root':
      promptText=currentCard.arabic||currentCard.past||'';
      answerText=currentCard.root||'—';
      promptArabic=true;
      answerArabic=true;
      break;

    case 'verb-past-present':
      promptText=currentCard.past||currentCard.arabic||'';
      answerText=currentCard.present||'—';
      promptArabic=true;
      answerArabic=true;
      break;

    case 'verb-present-past':
      promptText=currentCard.present||'';
      answerText=currentCard.past||currentCard.arabic||'—';
      promptArabic=true;
      answerArabic=true;
      break;

    case 'verb-form':
      promptText=currentCard.arabic||currentCard.past||'';
      answerText=currentCard.form||'—';
      promptArabic=true;
      break;

    case 'verb-bab':
      promptText=currentCard.arabic||currentCard.past||'';
      answerText=currentCard.bab||'—';
      promptArabic=true;
      answerArabic=true;
      break;

    case 'verb-masdar':
      promptText=currentCard.arabic||currentCard.past||'';
      answerText=currentCard.masdar||'—';
      promptArabic=true;
      answerArabic=true;
      break;
  }

  prompt.textContent=promptText;
  prompt.className='flash-prompt'+(promptArabic?' arabic':'');
  answer.textContent=answerText;
  answer.className='flash-answer hidden'+(answerArabic?' arabic':'');

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
  document.addEventListener('click',e=>{
    const statusBtn=e.target.closest('[data-status-id]');
    if(statusBtn){
      e.preventDefault();
      patchProgress(statusBtn.dataset.statusId,{status:statusBtn.dataset.status});
      return;
    }
    const favBtn=e.target.closest('[data-fav-id]');
    if(favBtn){
      e.preventDefault();
      const p=progressFor(favBtn.dataset.favId);
      patchProgress(favBtn.dataset.favId,{favourite:!p.favourite});
    }
  });

  document.querySelectorAll('[data-vocab-set]').forEach(btn=>btn.addEventListener('click',()=>{
    VOCAB_COLLECTION_FILTER=btn.dataset.vocabSet;
    VOCAB_PAGE=1;
    document.querySelectorAll('[data-vocab-set]').forEach(b=>b.classList.toggle('active',b===btn));
    SECTION_METRIC_FILTERS.vocabulary='all';
    renderSectionDashboards();
    renderVocabulary();
  }));
  ['vocabSearch','categoryFilter','typeFilter','sourceFilter','statusFilter','favouriteFilter'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>{VOCAB_PAGE=1;SECTION_METRIC_FILTERS.vocabulary='all';renderSectionDashboards();renderVocabulary();}));
  document.getElementById('formFilter').addEventListener('input',()=>{VERB_PAGE=1;SECTION_METRIC_FILTERS.verbs='all';renderSectionDashboards();renderVerbs();if(currentVerbTest)newVerbTestCard();});
  document.getElementById('verbTypeFilter')?.addEventListener('input',()=>{VERB_PAGE=1;SECTION_METRIC_FILTERS.verbs='all';renderSectionDashboards();renderVerbs();if(currentVerbTest)newVerbTestCard();});
  document.getElementById('babFilter')?.addEventListener('input',()=>{VERB_PAGE=1;SECTION_METRIC_FILTERS.verbs='all';renderSectionDashboards();renderVerbs();if(currentVerbTest)newVerbTestCard();});
  document.getElementById('verbSearch')?.addEventListener('input',()=>{VERB_PAGE=1;renderVerbs();});
  document.querySelectorAll('[data-verb-set]').forEach(btn=>btn.addEventListener('click',()=>{
    VERB_COLLECTION_FILTER=btn.dataset.verbSet;
    VERB_PAGE=1;
    document.querySelectorAll('[data-verb-set]').forEach(b=>b.classList.toggle('active',b===btn));
    SECTION_METRIC_FILTERS.verbs='all';
    renderSectionDashboards();
    renderVerbs();
    if(currentVerbTest)newVerbTestCard();
  }));
  document.querySelectorAll('[data-verb-panel]').forEach(btn=>btn.addEventListener('click',()=>switchVerbPanel(btn.dataset.verbPanel)));
  document.getElementById('newVerbTestBtn')?.addEventListener('click',newVerbTestCard);
  document.getElementById('revealVerbTestBtn')?.addEventListener('click',revealVerbTest);
  document.getElementById('verbTestMode')?.addEventListener('change',newVerbTestCard);
  document.getElementById('sarfSectionFilter')?.addEventListener('input',renderSarf);
  document.getElementById('rootSort')?.addEventListener('input',renderRoots);
  document.getElementById('rootLetterFilter')?.addEventListener('input',renderRoots);
  document.getElementById('speakingTopicFilter').addEventListener('input',renderSpeaking);
  document.getElementById('nahwTopicFilter')?.addEventListener('input',renderNahw);
  document.getElementById('quranSurahFilter')?.addEventListener('change',renderQuranicTarkeeb);
  const quranTranslationFilter=document.getElementById('quranTranslationFilter');
  if(quranTranslationFilter){
    const savedTranslation=localStorage.getItem(QURAN_TRANSLATION_STORE_KEY);
    if(savedTranslation && [...quranTranslationFilter.options].some(o=>o.value===savedTranslation)){
      quranTranslationFilter.value=savedTranslation;
    }
    quranTranslationFilter.addEventListener('change',()=>{
      localStorage.setItem(QURAN_TRANSLATION_STORE_KEY,quranTranslationFilter.value);
      renderQuranicTarkeeb();
    });
  }
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
      PROGRESS_CACHE={};
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
    const vocab=DATA.vocabulary.filter(x=>[x.arabic,x.english,x.root,x.topic,x.quran_topic,...sourceValues(x)].join(' ').toLowerCase().includes(q));
    const verbs=DATA.verbs.filter(x=>[x.arabic,x.english,x.root,x.topic,x.form,x.bab].join(' ').toLowerCase().includes(q));
    const speaking=DATA.speaking.filter(x=>[x.arabic,x.english,x.topic].join(' ').toLowerCase().includes(q));
    const nahw=DATA.nahw.filter(x=>[x.arabic,x.english,x.topic,x.summary].join(' ').toLowerCase().includes(q));
    const sarf=DATA.sarf.filter(x=>[x.arabic,x.english,x.section,x.summary].join(' ').toLowerCase().includes(q));
    box.classList.remove('hidden');
    const allResults=[...vocab.map(vocabCard),...verbs.map(verbCard),...speaking.map(speakingCard),...nahw.map(nahwCard),...sarf.map(sarfCard)];
    const shown=allResults.slice(0,40);
    box.innerHTML=(shown.join('')||'<p>No matches.</p>')+(allResults.length>40?`<p class="search-result-note">Showing the first 40 of ${allResults.length} matches. Refine your search to narrow the list.</p>`:'');
    bindDynamicButtons();
  });
}
loadData();
