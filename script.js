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
let SELECTED_ROOT = null;
let VOCAB_COLLECTION_FILTER = 'all';
let VERB_COLLECTION_FILTER = 'all';
const VOCAB_PAGE_SIZE = 24;
const VERB_PAGE_SIZE = 24;
let VOCAB_PAGE = 1;
let VERB_PAGE = 1;
let PROGRESS_METRIC_FILTER = 'all';

let DATA = { vocabulary: [], verbs: [], speaking: [], nahw: [], sarf: [], quranicTarkeeb: [] };
const REVISION_QUIZ = {
  length:25,
  direction:'both',
  bank:'both',
  vocabSource:'all',
  verbSource:'all',
  active:false,
  questions:[],
  index:0,
  correct:0,
  wrong:0,
  answered:false,
  mistakes:[]
};
const STORE_KEY = 'arabicEncyclopediaProgressV2';
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
    fetch('vocab.json?v=20261005-quran-high-frequency-vocab'), fetch('verbs.json?v=20261005-quran-high-frequency-verbs'), fetch('speaking.json'), fetch('nahw.json'), fetch('sarf.json'), fetch('quranic-tarkeeb.json')
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
  showRevisionQuizSetup();

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
  if(id!=='roots') SELECTED_ROOT=null;
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
    VOCAB_COLLECTION_FILTER='all';
    SECTION_METRIC_FILTERS.vocabulary='all';

    const q=document.getElementById('vocabSearch');
    const category=document.getElementById('categoryFilter');
    const type=document.getElementById('typeFilter');
    const source=document.getElementById('sourceFilter');
    const status=document.getElementById('statusFilter');
    const fav=document.getElementById('favouriteFilter');

    if(q) q.value=vocabItem.arabic;
    if(category) category.value='';
    if(type) type.value='';
    if(source) source.value='';
    if(status) status.value='';
    if(fav) fav.checked=false;

    document.querySelectorAll('[data-vocab-set]').forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.vocabSet==='all');
    });

    showView('vocabulary');
    renderSectionDashboards();
    renderVocabulary();

    setTimeout(()=>{
      document.querySelector(`#vocabList [data-item-id="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});
    },80);
    return;
  }

  if(verbItem){
    VERB_PAGE=1;
    VERB_COLLECTION_FILTER='all';
    SECTION_METRIC_FILTERS.verbs='all';

    const q=document.getElementById('verbSearch');
    const form=document.getElementById('formFilter');
    const type=document.getElementById('verbTypeFilter');
    const bab=document.getElementById('babFilter');

    // Search for the exact selected verb so pagination cannot hide it.
    if(q) q.value=verbItem.arabic||verbItem.past||verbItem.english||'';
    if(form) form.value='';
    if(type) type.value='';
    if(bab) bab.value='';

    document.querySelectorAll('[data-verb-set]').forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.verbSet==='all');
    });
    switchVerbPanel('reference');

    showView('verbs');
    renderSectionDashboards();
    renderVerbs();

    setTimeout(()=>{
      document.querySelector(`#verbsList [data-item-id="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});
    },80);
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
    ${x.quran_frequency?`<div class="vocab-source-row"><span class="quran-frequency-tag">Qur'an occurrences: ${x.quran_frequency}</span></div>`:''}
    <details class="verb-reference-details"><summary>Full reference</summary><div class="verb-data-grid">
      ${verbDataCell('Past',x.past,true)}${verbDataCell('Present',x.present,true)}${verbDataCell('Command',verbCommandValue(x),true)}${verbDataCell('Prohibition',verbProhibitionValue(x),true)}${verbDataCell('Passive past',verbPassivePastValue(x),true)}${verbDataCell('Passive present',verbPassivePresentValue(x),true)}${verbDataCell('Maṣdar',x.masdar,true)}
      ${verbDataCell('Active participle',x.active_participle,true)}${verbDataCell('Passive participle',x.passive_participle,true)}${verbDataCell('Pattern',x.pattern,true)}${verbDataCell('Bāb',x.bab,true)}${verbDataCell('Category',x.category,true)}${verbDataCell('Verb type',x.verb_type,true)}
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
    <div class="verb-bio"><span>Command</span><strong class="verb-ar">${verbCommandValue(currentVerbTest)}</strong></div>
    <div class="verb-bio"><span>Prohibition</span><strong class="verb-ar">${verbProhibitionValue(currentVerbTest)}</strong></div>
    <div class="verb-bio"><span>Passive past</span><strong class="verb-ar">${verbPassivePastValue(currentVerbTest)}</strong></div>
    <div class="verb-bio"><span>Passive present</span><strong class="verb-ar">${verbPassivePresentValue(currentVerbTest)}</strong></div>
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


const AR_MORPH_MARK=/[\u064B-\u065F\u0670\u06D6-\u06ED]/;
const AR_MORPH_SHADDA='\u0651';
const AR_MORPH_FATHA='\u064E';
const AR_MORPH_DAMMA='\u064F';
const AR_MORPH_KASRA='\u0650';
const AR_MORPH_SUKUN='\u0652';

function morphClusters(s){
  const out=[];
  for(const ch of String(s||'').normalize('NFC')){
    if(AR_MORPH_MARK.test(ch)&&out.length) out[out.length-1]+=ch;
    else out.push(ch);
  }
  return out.filter(Boolean);
}
function morphBase(c){return c?c[0]:'';}
function morphMarks(c){return c?c.slice(1):'';}
function morphHas(c,m){return morphMarks(c).includes(m);}
function morphVowel(c){
  if(morphHas(c,AR_MORPH_KASRA))return AR_MORPH_KASRA;
  if(morphHas(c,AR_MORPH_DAMMA))return AR_MORPH_DAMMA;
  if(morphHas(c,AR_MORPH_FATHA))return AR_MORPH_FATHA;
  if(morphHas(c,AR_MORPH_SUKUN))return AR_MORPH_SUKUN;
  return '';
}
function morphSetVowel(c,v){
  if(!c)return c;
  return morphBase(c)+(morphHas(c,AR_MORPH_SHADDA)?AR_MORPH_SHADDA:'')+(v||'');
}
function morphSetBase(c,base){return base+morphMarks(c);}
function morphBareLong(c){
  return ['ا','و','ي','ى'].includes(morphBase(c))&&!morphVowel(c)&&!morphHas(c,AR_MORPH_SHADDA);
}
function morphReseatHamza(cs){
  cs=[...cs];
  for(let i=0;i<cs.length;i++){
    if(!['ء','أ','إ','ؤ','ئ'].includes(morphBase(cs[i]))) continue;
    const own=morphVowel(cs[i]);
    let base=morphBase(cs[i]);

    if(i===0){
      base=own===AR_MORPH_KASRA?'إ':'أ';
    }else if(i===cs.length-1){
      const prev=cs[i-1];
      if(morphBareLong(prev)) base='ء';
      else{
        const pv=morphVowel(prev);
        base=pv===AR_MORPH_KASRA?'ئ':pv===AR_MORPH_DAMMA?'ؤ':pv===AR_MORPH_FATHA?'أ':'ء';
      }
    }else{
      const prev=cs[i-1];
      const pv=morphBareLong(prev)?'':morphVowel(prev);
      const rank={
        [AR_MORPH_KASRA]:4,
        [AR_MORPH_DAMMA]:3,
        [AR_MORPH_FATHA]:2,
        [AR_MORPH_SUKUN]:1,
        '':0
      };
      const strong=rank[own]>=rank[pv]?own:pv;
      base=strong===AR_MORPH_KASRA?'ئ':strong===AR_MORPH_DAMMA?'ؤ':strong===AR_MORPH_FATHA?'أ':'ء';
    }
    cs[i]=morphSetBase(cs[i],base);
  }
  return cs;
}
function morphJoin(cs){return morphReseatHamza(cs).join('').normalize('NFC');}
function verbTypeHas(x,needle){return String(x?.verb_type||'').includes(needle);}
function verbIsDefective(x){
  if(verbTypeHas(x,'النَّاقِص')||verbTypeHas(x,'اللَّفِيف')) return true;
  const cs=morphClusters(x?.present);
  const last=cs.at(-1);
  return ['ا','ى','ي','و'].includes(morphBase(last))&&!morphVowel(last);
}
function verbIsHollow(x){
  return verbTypeHas(x,'الْأَجْوَف')||verbTypeHas(x,'أَجْوَف');
}
function verbIsDoubled(x){
  return verbTypeHas(x,'الْمُضَاعَف')||morphClusters(x?.past).some(c=>morphHas(c,AR_MORPH_SHADDA));
}
function verbHasContractedHollowPresent(x,cs){
  if(!['I','IV','VII','VIII','X'].includes(x?.form)) return false;
  return cs.some((c,i)=>i>0&&i<cs.length-1&&['ا','و','ي'].includes(morphBase(c))&&morphBareLong(c));
}
function verbSecondPersonJussive(x){
  let cs=morphClusters(x?.present);
  if(!cs.length) return '';

  cs[0]=morphSetBase(cs[0],'ت');

  if(verbHasContractedHollowPresent(x,cs)){
    const li=cs.findIndex((c,i)=>i>0&&i<cs.length-1&&['ا','و','ي'].includes(morphBase(c))&&morphBareLong(c));
    if(li>0) cs.splice(li,1);
  }

  const last=cs.at(-1);
  if(['ا','ى','ي','و'].includes(morphBase(last))&&!morphVowel(last)){
    cs.pop();
    return morphJoin(cs);
  }

  if(morphHas(last,AR_MORPH_SHADDA)){
    cs[cs.length-1]=morphSetVowel(last,AR_MORPH_FATHA);
  }else{
    cs[cs.length-1]=morphSetVowel(last,AR_MORPH_SUKUN);
  }
  return morphJoin(cs);
}
function verbCommandValue(x){
  if(x?.form==='I'&&verbTypeHas(x,'الْمَهْمُوز')&&x.command&&x.command!=='—') return x.command;

  const jussive=verbSecondPersonJussive(x);
  let cs=morphClusters(jussive);
  if(!cs.length) return x?.command||'—';

  cs.shift();
  const f=x?.form||'';

  if(f==='I'){
    if(!cs.length) return x?.command||'—';
    if(morphVowel(cs[0])===AR_MORPH_SUKUN){
      const nextV=morphVowel(cs[1]||'');
      const hamzaV=nextV===AR_MORPH_DAMMA?AR_MORPH_DAMMA:AR_MORPH_KASRA;
      return morphJoin(['ا'+hamzaV,...cs]);
    }
    return morphJoin(cs);
  }
  if(f==='IV') return morphJoin(['أ'+AR_MORPH_FATHA,...cs]);
  if(['VII','VIII','IX','X'].includes(f)) return morphJoin(['ا'+AR_MORPH_KASRA,...cs]);
  return morphJoin(cs);
}
function verbProhibitionValue(x){
  const j=verbSecondPersonJussive(x);
  return j?('لَا '+j):(x?.prohibition||'—');
}

function verbPassivePastValue(x){
  let cs=morphClusters(x?.past);
  const f=x?.form||'';
  if(!cs.length) return '—';

  if(f==='I'){
    if(verbIsHollow(x)){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_KASRA);
      const li=cs.findIndex((c,i)=>i>0&&i<cs.length-1&&['ا','و','ي'].includes(morphBase(c))&&!morphHas(c,AR_MORPH_SHADDA));
      if(li>0) cs[li]='ي';
      cs[cs.length-1]=morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }else if(verbIsDefective(x)){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      if(cs.length>=2) cs[cs.length-2]=morphSetVowel(cs[cs.length-2],AR_MORPH_KASRA);
      cs[cs.length-1]='ي'+AR_MORPH_FATHA;
    }else if(verbIsDoubled(x)&&cs.length===2){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_FATHA);
    }else if(cs.length>=3){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_KASRA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
    }
  }else if(f==='II'){
    if(cs.length>=3){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='III'){
    if(cs.length>=4){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      if(morphBase(cs[1])==='ا') cs[1]='و';
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='IV'){
    cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
    if(verbIsHollow(x)&&cs.length>=4){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_KASRA);
      const li=cs.findIndex((c,i)=>i>0&&i<cs.length-1&&morphBase(c)==='ا');
      if(li>0) cs[li]='ي';
      cs[cs.length-1]=morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }else if(verbIsDefective(x)){
      if(cs.length>=3) cs[cs.length-2]=morphSetVowel(cs[cs.length-2],AR_MORPH_KASRA);
      cs[cs.length-1]='ي'+AR_MORPH_FATHA;
    }else if(cs.length===3&&morphHas(cs[2],AR_MORPH_SHADDA)){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_KASRA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
    }else if(cs.length>=4){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
    }
  }else if(f==='V'){
    if(cs.length>=4){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_DAMMA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='VI'){
    if(cs.length>=5){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_DAMMA);
      if(morphBase(cs[2])==='ا') cs[2]='و';
      cs[3]=morphSetVowel(cs[3],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='VII'){
    if(verbIsHollow(x)&&cs.length>=5){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      if(morphBase(cs[3])==='ا') cs[3]='ي';
      cs[4]=morphSetVowel(cs[4],AR_MORPH_FATHA);
    }else if(cs.length>=5){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_DAMMA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='VIII'){
    cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
    if(verbIsHollow(x)&&cs.length>=5){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      if(morphBase(cs[3])==='ا') cs[3]='ي';
      cs[4]=morphSetVowel(cs[4],AR_MORPH_FATHA);
    }else if(cs.length===4&&morphHas(cs[1],AR_MORPH_SHADDA)){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_DAMMA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
    }else if(cs.length>=5){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_DAMMA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_KASRA);
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='IX'){
    return '—';
  }else if(f==='X'){
    cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
    if(cs.length>=6){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_DAMMA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_SUKUN);
      cs[4]=morphSetVowel(cs[4],AR_MORPH_KASRA);
      if(verbIsHollow(x)){
        const li=cs.findIndex((c,i)=>i>4&&i<cs.length-1&&morphBase(c)==='ا');
        if(li>4) cs[li]='ي';
      }
      cs[cs.length-1]=verbIsDefective(x)?'ي'+AR_MORPH_FATHA:morphSetVowel(cs[cs.length-1],AR_MORPH_FATHA);
    }
  }else if(f==='Quadriliteral I'){
    if(cs.length>=4){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_KASRA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
    }
  }else if(f==='Quadriliteral derived'){
    if(cs.length>=5){
      cs[0]=morphSetVowel(cs[0],AR_MORPH_DAMMA);
      cs[1]=morphSetVowel(cs[1],AR_MORPH_DAMMA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_SUKUN);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_KASRA);
      cs[4]=morphSetVowel(cs[4],AR_MORPH_FATHA);
    }
  }
  return morphJoin(cs);
}

function verbPassivePresentValue(x){
  let cs=morphClusters(x?.present);
  const f=x?.form||'';
  if(!cs.length) return '—';

  cs[0]=morphSetVowel(morphSetBase(cs[0],'ي'),AR_MORPH_DAMMA);

  if(f==='I'){
    if(verbIsHollow(x)){
      if(cs.length>=4){
        cs[1]=morphSetVowel(cs[1],AR_MORPH_FATHA);
        const li=cs.findIndex((c,i)=>i>1&&i<cs.length-1&&['ا','و','ي'].includes(morphBase(c))&&morphBareLong(c));
        if(li>1) cs[li]='ا';
        cs[cs.length-1]=morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
      }
    }else if(verbIsDefective(x)){
      if(cs.length>=3){
        cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
        cs[cs.length-2]=morphSetVowel(cs[cs.length-2],AR_MORPH_FATHA);
        cs[cs.length-1]='ى';
      }
    }else if(verbIsDoubled(x)&&cs.length===3){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_FATHA);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_DAMMA);
    }else if(cs.length>=4){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_SUKUN);
      cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
      cs[3]=morphSetVowel(cs[3],AR_MORPH_DAMMA);
    }else if(cs.length===3){
      const pcs=morphClusters(x?.past);
      const weak=morphBase(pcs[0]);
      if(['و','ي'].includes(weak)){
        cs=[cs[0],weak,morphSetVowel(cs[1],AR_MORPH_FATHA),morphSetVowel(cs[2],AR_MORPH_DAMMA)];
      }
    }
  }else if(f==='II'){
    if(cs.length>=4){
      cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
      cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
    }
  }else if(f==='III'){
    if(cs.length>=5){
      cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
      cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
    }
  }else if(f==='IV'){
    if(verbIsHollow(x)&&cs.length>=4){
      cs[1]=morphSetVowel(cs[1],AR_MORPH_FATHA);
      const li=cs.findIndex((c,i)=>i>1&&i<cs.length-1&&morphBase(c)==='ي'&&morphBareLong(c));
      if(li>1) cs[li]='ا';
      cs[cs.length-1]=morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
    }else if(verbIsDefective(x)){
      if(cs.length>=3) cs[cs.length-2]=morphSetVowel(cs[cs.length-2],AR_MORPH_FATHA);
      cs[cs.length-1]='ى';
    }else if(cs.length>=4){
      cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
      cs[cs.length-1]=morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
    }
  }else if(f==='V'||f==='VI'){
    cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
  }else if(f==='VII'){
    if(!verbIsHollow(x)&&cs.length>=5) cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
    cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
  }else if(f==='VIII'){
    if(!verbIsHollow(x)){
      if(cs.length===4&&morphHas(cs[1],AR_MORPH_SHADDA)) cs[2]=morphSetVowel(cs[2],AR_MORPH_FATHA);
      else if(cs.length>=5) cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
    }
    cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
  }else if(f==='IX'){
    return '—';
  }else if(f==='X'){
    if(verbIsHollow(x)&&cs.length>=6){
      cs[4]=morphSetVowel(cs[4],AR_MORPH_FATHA);
      const li=cs.findIndex((c,i)=>i>4&&i<cs.length-1&&morphBase(c)==='ي'&&morphBareLong(c));
      if(li>4) cs[li]='ا';
    }else if(cs.length>=6){
      cs[4]=morphSetVowel(cs[4],AR_MORPH_FATHA);
    }
    cs[cs.length-1]=verbIsDefective(x)?'ى':morphSetVowel(cs[cs.length-1],AR_MORPH_DAMMA);
  }else if(f==='Quadriliteral I'){
    if(cs.length>=5) cs[3]=morphSetVowel(cs[3],AR_MORPH_FATHA);
  }
  return morphJoin(cs);
}

function rootItemKind(item){
  return DATA.verbs.includes(item)?'verb':'vocabulary';
}

function rootFrequencyValue(value){
  if(value===undefined||value===null||value==='') return 0;
  const match=String(value).replace(/,/g,'').match(/\d+/);
  return match?Number(match[0]):0;
}

function rootSummaryTag(label,value,arabic=false){
  if(value===undefined||value===null||value==='') return '';
  return `<div class="root-detail-stat"><span>${label}</span><strong class="${arabic?'root-detail-ar':''}">${value}</strong></div>`;
}

function rootVocabDetailCard(x){
  const p=progressFor(x.id);
  return `<article class="root-detail-item">
    <div class="root-detail-item-head">
      <div>
        <div class="arabic root-detail-word" lang="ar" dir="rtl">${x.arabic}</div>
        <h4>${x.english||'—'}</h4>
      </div>
      <span class="pill ${statusClass(p.status)}">${p.status}</span>
    </div>
    <div class="root-detail-meta">
      ${x.type?`<span>Type: ${x.type}</span>`:''}
      ${x.category?`<span>${x.category}</span>`:''}
      ${x.topic?`<span>${x.topic}</span>`:''}
      ${x.quran_frequency?`<span>Qur'an occurrences: ${x.quran_frequency}</span>`:''}
    </div>
    ${sourceValues(x).length?`<div class="vocab-source-row">${sourceValues(x).map(s=>`<span class="vocab-source-tag">${s}</span>`).join('')}</div>`:''}
    ${x.example?`<div class="root-detail-example arabic" lang="ar" dir="rtl">${x.example}</div><div class="meta">${x.example_en||''}</div>`:''}
    ${statusControls(x)}
    <button type="button" class="root-open-item" data-root-item-id="${x.id}">Open full vocabulary entry</button>
  </article>`;
}

function rootVerbDetailCard(x){
  const p=progressFor(x.id);
  return `<article class="root-detail-item root-detail-verb">
    <div class="root-detail-item-head">
      <div>
        <div class="arabic root-detail-word" lang="ar" dir="rtl">${x.arabic||x.past||''}</div>
        <h4>${x.english||'—'}</h4>
      </div>
      <span class="pill ${statusClass(p.status)}">${p.status}</span>
    </div>
    <div class="root-verb-forms">
      ${rootSummaryTag('Past',x.past,true)}
      ${rootSummaryTag('Present',x.present,true)}
      ${rootSummaryTag('Command',verbCommandValue(x),true)}
      ${rootSummaryTag('Prohibition',verbProhibitionValue(x),true)}
      ${rootSummaryTag('Passive past',verbPassivePastValue(x),true)}
      ${rootSummaryTag('Passive present',verbPassivePresentValue(x),true)}
      ${rootSummaryTag('Maṣdar',x.masdar,true)}
      ${rootSummaryTag('Form',x.form)}
      ${rootSummaryTag('Bāb',x.bab,true)}
      ${rootSummaryTag('Type',x.verb_type,true)}
    </div>
    ${x.quran_frequency?`<div class="root-quran-count">Qur'an occurrences: <strong>${x.quran_frequency}</strong></div>`:''}
    ${statusControls(x)}
    <button type="button" class="root-open-item" data-root-item-id="${x.id}">Open full verb entry</button>
  </article>`;
}

function rootSortedKeys(){
  return Object.keys(getRootGroups()).sort((a,b)=>String(a).localeCompare(String(b),'ar',{sensitivity:'base'}));
}

function openRootDetail(root){
  SELECTED_ROOT=root;
  renderRoots();
  window.scrollTo({top:0,behavior:'smooth'});
}

function closeRootDetail(){
  SELECTED_ROOT=null;
  renderRoots();
  document.getElementById('roots')?.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderRootDetail(root){
  const browse=document.getElementById('rootsBrowse');
  const detail=document.getElementById('rootDetail');
  if(!browse||!detail) return;

  const vocab=DATA.vocabulary.filter(x=>x.root===root);
  const verbs=DATA.verbs.filter(x=>x.root===root);
  const items=[...vocab,...verbs];
  if(!items.length){
    SELECTED_ROOT=null;
    browse.classList.remove('hidden');
    detail.classList.add('hidden');
    renderRoots();
    return;
  }

  const p=rootProgress(items);
  const quranTotal=items.reduce((sum,x)=>sum+rootFrequencyValue(x.quran_frequency),0);
  const forms=unique(verbs.map(x=>x.form));
  const babs=unique(verbs.map(x=>x.bab));
  const keys=rootSortedKeys();
  const pos=keys.indexOf(root);
  const previous=pos>0?keys[pos-1]:'';
  const next=pos>=0&&pos<keys.length-1?keys[pos+1]:'';

  browse.classList.add('hidden');
  detail.classList.remove('hidden');
  detail.innerHTML=`
    <div class="root-detail-topbar">
      <button type="button" class="root-back-btn" data-root-back>← All roots</button>
      <div class="root-detail-nav">
        <button type="button" ${previous?'':'disabled'} data-root-nav="${previous?encodeURIComponent(previous):''}">← Previous</button>
        <button type="button" ${next?'':'disabled'} data-root-nav="${next?encodeURIComponent(next):''}">Next →</button>
      </div>
    </div>

    <section class="root-detail-hero">
      <div>
        <span class="root-detail-kicker">ROOT FAMILY</span>
        <div class="root-detail-title arabic" lang="ar" dir="rtl">${root}</div>
        <p>${items.length} related item${items.length===1?'':'s'} across your vocabulary and verb banks.</p>
      </div>
      <div class="root-detail-progress-card">
        <div class="root-progress-head"><strong>Family progress</strong><span class="root-percent">${p.pct}%</span></div>
        <div class="root-progress-bar"><div class="root-progress-fill" style="width:${p.pct}%"></div></div>
        <div class="root-detail-status-line">
          <span>${p.notStarted} not started</span>
          <span>${p.covered+p.learning} learning</span>
          <span>${p.confident} confident</span>
          <span>${p.mastered} mastered</span>
        </div>
      </div>
    </section>

    <div class="root-detail-overview">
      ${rootSummaryTag('Vocabulary',vocab.length)}
      ${rootSummaryTag('Verbs',verbs.length)}
      ${rootSummaryTag('Qur\'an occurrences',quranTotal||'—')}
      ${rootSummaryTag('Forms',forms.length||'—')}
      ${rootSummaryTag('Bābs',babs.length||'—')}
    </div>

    ${forms.length||babs.length?`
      <section class="root-family-reference">
        ${forms.length?`<div><span>Verb forms</span><div class="root-detail-tags">${forms.map(x=>`<span>${x}</span>`).join('')}</div></div>`:''}
        ${babs.length?`<div><span>Bābs</span><div class="root-detail-tags arabic-tags" lang="ar" dir="rtl">${babs.map(x=>`<span>${x}</span>`).join('')}</div></div>`:''}
      </section>`:''}

    <section class="root-detail-section">
      <div class="root-detail-section-head">
        <div><span class="root-detail-kicker">WORD FAMILY</span><h3>Vocabulary</h3></div>
        <span>${vocab.length} item${vocab.length===1?'':'s'}</span>
      </div>
      <div class="root-detail-grid">
        ${vocab.length?vocab.map(rootVocabDetailCard).join(''):'<p class="meta">No vocabulary items are currently stored under this root.</p>'}
      </div>
    </section>

    <section class="root-detail-section">
      <div class="root-detail-section-head">
        <div><span class="root-detail-kicker">ṢARF FAMILY</span><h3>Verbs</h3></div>
        <span>${verbs.length} verb${verbs.length===1?'':'s'}</span>
      </div>
      <div class="root-detail-grid">
        ${verbs.length?verbs.map(rootVerbDetailCard).join(''):'<p class="meta">No verbs are currently stored under this root.</p>'}
      </div>
    </section>
  `;

  detail.querySelector('[data-root-back]')?.addEventListener('click',closeRootDetail);
  detail.querySelectorAll('[data-root-nav]').forEach(btn=>btn.addEventListener('click',()=>{
    if(btn.disabled||!btn.dataset.rootNav) return;
    openRootDetail(decodeURIComponent(btn.dataset.rootNav));
  }));
  detail.querySelectorAll('[data-root-item-id]').forEach(btn=>btn.addEventListener('click',()=>openRootItem(btn.dataset.rootItemId)));
  bindDynamicButtons();
}

function renderRoots(){
  if(SELECTED_ROOT){
    renderRootDetail(SELECTED_ROOT);
    return;
  }

  const browse=document.getElementById('rootsBrowse');
  const detail=document.getElementById('rootDetail');
  browse?.classList.remove('hidden');
  detail?.classList.add('hidden');

  const groups=getRootGroups();
  const sort=document.getElementById('rootSort')?.value||'alphabetical';
  const letter=document.getElementById('rootLetterFilter')?.value||'';
  const q=(document.getElementById('rootSearch')?.value||'').trim().toLowerCase();
  let entries=Object.entries(groups).map(([root,items])=>({root,items,progress:rootProgress(items)}));
  if(q) entries=entries.filter(({root,items})=>{
    const hay=[root,...items.flatMap(x=>[x.arabic,x.english,x.root,x.past,x.present,x.masdar])].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
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
    const vocabCount=items.filter(x=>rootItemKind(x)==='vocabulary').length;
    const verbCount=items.length-vocabCount;
    return `<div class="root-card ${state}">
      <button type="button" class="root-card-main" data-root-detail="${encodeURIComponent(root)}" aria-label="Open root family ${root}">
        <div class="root-title" lang="ar" dir="rtl">${root}</div>
        <div class="root-family-count">${items.length} related item${items.length===1?'':'s'} · ${vocabCount} vocab · ${verbCount} verb${verbCount===1?'':'s'}</div>
        <div class="root-progress-head"><strong>Family progress</strong><span class="root-percent">${p.pct}%</span></div>
        <div class="root-progress-bar"><div class="root-progress-fill" style="width:${p.pct}%"></div></div>
        <div class="root-status-grid">
          <div class="root-status-chip notstarted"><strong>${p.notStarted}</strong>Not started</div>
          <div class="root-status-chip learning"><strong>${p.learning+p.covered}</strong>Learning</div>
          <div class="root-status-chip confident"><strong>${p.confident}</strong>Confident</div>
          <div class="root-status-chip mastered"><strong>${p.mastered}</strong>Mastered</div>
        </div>
        <span class="root-view-family">View root family →</span>
      </button>
      <div class="root-family-words" lang="ar" dir="rtl">${items.map(x=>`<button type="button" class="root-word-link ${statusClass(itemStatus(x.id))}" data-root-item-id="${x.id}">${x.arabic}</button>`).join(' ')}</div>
    </div>`;
  }).join('')||'<p class="meta">No roots match this Arabic letter.</p>';

  document.querySelectorAll('[data-root-detail]').forEach(btn=>{
    btn.onclick=()=>openRootDetail(decodeURIComponent(btn.dataset.rootDetail));
  });
  document.querySelectorAll('[data-root-item-id]').forEach(btn=>{
    btn.onclick=()=>openRootItem(btn.dataset.rootItemId);
  });
}
function renderVerbs(){
  const form=document.getElementById('formFilter')?.value||'',type=document.getElementById('verbTypeFilter')?.value||'',bab=document.getElementById('babFilter')?.value||'',q=(document.getElementById('verbSearch')?.value||'').toLowerCase();
  let rows=DATA.verbs.filter(x=>{const h=[x.arabic,x.english,x.quran_english,x.root,x.form,x.bab,x.category,x.verb_type,x.masdar,verbCommandValue(x),verbProhibitionValue(x),verbPassivePastValue(x),verbPassivePresentValue(x),...sourceValues(x)].join(' ').toLowerCase();const collections=Array.isArray(x.collections)?x.collections:[];const inCollection=VERB_COLLECTION_FILTER==='all'||collections.includes(VERB_COLLECTION_FILTER);return inCollection&&(!form||x.form===form)&&(!type||x.verb_type===type)&&(!bab||x.bab===bab)&&h.includes(q)});rows=filterByMetric(rows,SECTION_METRIC_FILTERS.verbs);
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
function progressSourceGroups(){
  const groups=[
    {
      label:'Madinah Book 1',
      items:DATA.vocabulary.filter(x=>(Array.isArray(x.collections)?x.collections:[]).includes('Madinah Book 1'))
    },
    {
      label:'Qur\'an High Frequency Vocabulary',
      items:DATA.vocabulary.filter(x=>(Array.isArray(x.collections)?x.collections:[]).includes("Qur'an High Frequency"))
    },
    {
      label:'Qur\'an High Frequency Verbs',
      items:DATA.verbs.filter(x=>(Array.isArray(x.collections)?x.collections:[]).includes("Qur'an High Frequency Verbs"))
    },
    {
      label:'Ṣarf Verb Bank',
      items:DATA.verbs.filter(x=>!(Array.isArray(x.collections)?x.collections:[]).includes("Qur'an High Frequency Verbs"))
    }
  ];
  return groups.filter(g=>g.items.length);
}

function progressItemCard(x){
  const p=progressFor(x.id);
  const collections=Array.isArray(x.collections)?x.collections:[];
  let sourceLabel='Ṣarf Verb Bank';
  if(collections.includes('Madinah Book 1')) sourceLabel='Madinah Book 1';
  else if(collections.includes("Qur'an High Frequency")) sourceLabel="Qur'an High Frequency Vocabulary";
  else if(collections.includes("Qur'an High Frequency Verbs")) sourceLabel="Qur'an High Frequency Verbs";
  return `<article class="item progress-item"><div class="item-head"><div><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><strong>${x.english}</strong></div><span class="pill ${statusClass(p.status)}">${p.status}</span></div><div class="meta">${sourceLabel}</div></article>`;
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
  const sourceGroups=progressSourceGroups();
  document.getElementById('sourceProgress').innerHTML=sourceGroups.map(({label,items})=>{
    const started=items.filter(x=>itemStatus(x.id)!=='Not Started').length;
    const mastered=items.filter(x=>itemStatus(x.id)==='Mastered').length;
    const pct=items.length?Math.round(started/items.length*100):0;
    return `<div class="topic-row"><div class="topic-top"><strong>${label}</strong><span>${started}/${items.length} started · ${mastered} mastered</span></div><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><div class="meta">${pct}% started</div></div>`;
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
  const intro=document.getElementById('quranSurahIntro');
  const list=document.getElementById('quranAyahList');
  if(!select||!intro||!list) return;

  const selected=Number(select.value||1);
  const surah=DATA.quranicTarkeeb.find(x=>Number(x.number)===selected) || DATA.quranicTarkeeb[0];
  if(!surah){
    intro.innerHTML='<p>No Qur\'anic Tarkeeb data is available.</p>';
    list.innerHTML='';
    return;
  }

  intro.innerHTML=`
    <div>
      <div class="arabic quran-surah-title" lang="ar" dir="rtl">${surah.arabic_name}</div>
      <h3>Sūrah ${surah.english_name} — ${surah.english_title||surah.note||''}</h3>
      <p>Sūrah ${surah.number} · ${surah.ayahs.length} āyah${surah.ayahs.length===1?'':'s'} · Tarkeeb & Iʿrāb</p>
    </div>
    <div class="translation-note">
      <strong>English reference</strong>
      <p>English terminology and word meanings are based on M. A. S. Abdel Haleem, <em>The Qur'an</em> (Oxford World's Classics). Word glosses are matched to each āyah rather than taken from a generic dictionary.</p>
    </div>`;

  list.innerHTML=surah.ayahs.map(a=>`
    <article class="quran-ayah-card">
      <div class="ayah-number">${a.n}</div>

      <div class="quran-verse-pair">
        <div class="quran-arabic" lang="ar" dir="rtl">${a.arabic}</div>
        <div class="quran-english"><span class="analysis-kicker">ENGLISH MEANING</span>${a.sense||''}</div>
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
    </article>`).join('');
}

function shuffleQuizArray(items){
  const arr=[...items];
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function quizArabicValue(item){
  return String(item?.arabic||item?.past||'').trim();
}
function quizEnglishValue(item){
  return String(item?.english||item?.quran_english||'').trim();
}
function revisionQuizPool(){
  const seen=new Set();
  const vocab=DATA.vocabulary
    .filter(item=>{
      if(REVISION_QUIZ.vocabSource==='all') return true;
      const collections=Array.isArray(item.collections)?item.collections:[];
      return collections.includes(REVISION_QUIZ.vocabSource);
    })
    .map(item=>({item,kind:'vocabulary'}));

  const verbs=DATA.verbs
    .filter(item=>{
      const collections=Array.isArray(item.collections)?item.collections:[];
      const isQuran=collections.includes("Qur'an High Frequency Verbs");
      if(REVISION_QUIZ.verbSource==='quran') return isQuran;
      if(REVISION_QUIZ.verbSource==='sarf') return !isQuran;
      return true;
    })
    .map(item=>({item,kind:'verb'}));

  let rows=[];
  if(REVISION_QUIZ.bank==='vocabulary') rows=vocab;
  else if(REVISION_QUIZ.bank==='verbs') rows=verbs;
  else rows=[...vocab,...verbs];

  rows=rows.filter(({item})=>quizArabicValue(item)&&quizEnglishValue(item));

  return rows.filter(({item})=>{
    const key=(quizArabicValue(item)+'|'+quizEnglishValue(item)).toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildBalancedQuizSelection(pool,target){
  if(REVISION_QUIZ.bank!=='both') return shuffleQuizArray(pool).slice(0,target);

  const vocab=shuffleQuizArray(pool.filter(x=>x.kind==='vocabulary'));
  const verbs=shuffleQuizArray(pool.filter(x=>x.kind==='verb'));

  let vocabNeed=Math.floor(target/2);
  let verbNeed=target-vocabNeed;

  if(vocab.length<vocabNeed){
    verbNeed=Math.min(verbs.length,verbNeed+(vocabNeed-vocab.length));
    vocabNeed=vocab.length;
  }
  if(verbs.length<verbNeed){
    vocabNeed=Math.min(vocab.length,vocabNeed+(verbNeed-verbs.length));
    verbNeed=verbs.length;
  }

  return shuffleQuizArray([
    ...vocab.slice(0,vocabNeed),
    ...verbs.slice(0,verbNeed)
  ]);
}
function quizValueFor(item,direction,part){
  if(direction==='ar-en') return part==='prompt'?quizArabicValue(item):quizEnglishValue(item);
  return part==='prompt'?quizEnglishValue(item):quizArabicValue(item);
}
function quizDirectionText(direction){
  return direction==='ar-en'?'Arabic → English':'English → Arabic';
}
function buildQuizOptions(question){
  const correct=quizValueFor(question.item,question.direction,'answer');
  const sameKind=revisionQuizPool().filter(x=>x.kind===question.kind);
  const otherValues=shuffleQuizArray(
    [...new Set(sameKind.map(({item})=>quizValueFor(item,question.direction,'answer')).filter(v=>v&&v!==correct))]
  ).slice(0,3);
  return shuffleQuizArray([correct,...otherValues]);
}
function updateRevisionQuizSetupVisibility(){
  const vocabSetting=document.getElementById('quizVocabSourceSetting');
  const verbSetting=document.getElementById('quizVerbSourceSetting');
  if(vocabSetting) vocabSetting.classList.toggle('hidden',REVISION_QUIZ.bank==='verbs');
  if(verbSetting) verbSetting.classList.toggle('hidden',REVISION_QUIZ.bank==='vocabulary');
}

function showRevisionQuizSetup(){
  REVISION_QUIZ.active=false;
  REVISION_QUIZ.questions=[];
  REVISION_QUIZ.index=0;
  REVISION_QUIZ.correct=0;
  REVISION_QUIZ.wrong=0;
  REVISION_QUIZ.answered=false;
  REVISION_QUIZ.mistakes=[];
  updateRevisionQuizSetupVisibility();
  document.getElementById('revisionQuizSetup')?.classList.remove('hidden');
  document.getElementById('revisionQuizPlay')?.classList.add('hidden');
  document.getElementById('revisionQuizResult')?.classList.add('hidden');
}
function startRevisionQuiz(){
  const pool=revisionQuizPool();
  const target=Math.min(REVISION_QUIZ.length,pool.length);
  const picked=buildBalancedQuizSelection(pool,target);

  REVISION_QUIZ.questions=picked.map(({item,kind},i)=>({
    item,
    kind,
    direction:REVISION_QUIZ.direction==='both'?(i%2===0?'ar-en':'en-ar'):REVISION_QUIZ.direction,
    options:null
  }));
  REVISION_QUIZ.index=0;
  REVISION_QUIZ.correct=0;
  REVISION_QUIZ.wrong=0;
  REVISION_QUIZ.answered=false;
  REVISION_QUIZ.mistakes=[];
  REVISION_QUIZ.active=true;

  document.getElementById('revisionQuizSetup')?.classList.add('hidden');
  document.getElementById('revisionQuizResult')?.classList.add('hidden');
  document.getElementById('revisionQuizPlay')?.classList.remove('hidden');
  renderRevisionQuizQuestion();
}
function renderRevisionQuizQuestion(){
  if(!REVISION_QUIZ.active||!REVISION_QUIZ.questions.length) return;
  const q=REVISION_QUIZ.questions[REVISION_QUIZ.index];
  if(!q) return finishRevisionQuiz();

  if(!q.options) q.options=buildQuizOptions(q);
  REVISION_QUIZ.answered=false;

  const total=REVISION_QUIZ.questions.length;
  const num=REVISION_QUIZ.index+1;
  const prompt=quizValueFor(q.item,q.direction,'prompt');
  const promptArabic=q.direction==='ar-en';
  const answersArabic=q.direction==='en-ar';

  const counter=document.getElementById('quizCounter');
  const direction=document.getElementById('quizDirectionLabel');
  const promptEl=document.getElementById('quizPrompt');
  const options=document.getElementById('quizOptions');
  const feedback=document.getElementById('quizFeedback');
  const next=document.getElementById('quizNextBtn');

  if(counter) counter.textContent='Question '+num+' of '+total;
  if(direction) direction.textContent=quizDirectionText(q.direction);
  if(promptEl){
    promptEl.textContent=prompt;
    promptEl.className='quiz-prompt'+(promptArabic?' arabic':'');
    if(promptArabic){promptEl.setAttribute('lang','ar');promptEl.setAttribute('dir','rtl');}
    else{promptEl.removeAttribute('lang');promptEl.removeAttribute('dir');}
  }

  if(options){
    options.innerHTML=q.options.map((answer,i)=>{
      const cls='quiz-option'+(answersArabic?' arabic-option':'');
      const attrs=answersArabic?' lang="ar" dir="rtl"':'';
      return '<button type="button" class="'+cls+'" data-quiz-option="'+i+'"'+attrs+'>'+answer+'</button>';
    }).join('');
  }
  if(feedback){
    feedback.className='quiz-feedback hidden';
    feedback.textContent='';
  }
  if(next){
    next.classList.add('hidden');
    next.textContent=num===total?'See results':'Next question';
  }

  updateRevisionQuizScore();
  const fill=document.getElementById('quizProgressFill');
  if(fill) fill.style.width=((REVISION_QUIZ.index/total)*100)+'%';
}
function updateRevisionQuizScore(){
  const c=document.getElementById('quizCorrectCount');
  const w=document.getElementById('quizWrongCount');
  if(c)c.textContent=REVISION_QUIZ.correct;
  if(w)w.textContent=REVISION_QUIZ.wrong;
}
function recordRevisionQuizAttempt(item,isCorrect){
  const p=progressFor(item.id);
  const next={
    ...p,
    timesRevised:(p.timesRevised||0)+1,
    lastRevised:new Date().toISOString(),
    correctCount:(p.correctCount||0)+(isCorrect?1:0),
    incorrectCount:(p.incorrectCount||0)+(isCorrect?0:1)
  };
  const all=loadProgress();
  all[item.id]=next;
  saveProgress(all);
  if(currentUser) pushProgress(item.id,next);
}
function answerRevisionQuiz(optionIndex){
  if(REVISION_QUIZ.answered) return;
  const q=REVISION_QUIZ.questions[REVISION_QUIZ.index];
  if(!q) return;

  const correct=quizValueFor(q.item,q.direction,'answer');
  const selected=q.options?.[optionIndex]||'';
  const isCorrect=selected===correct;
  REVISION_QUIZ.answered=true;

  if(isCorrect){
    REVISION_QUIZ.correct++;
  }else{
    REVISION_QUIZ.wrong++;
    REVISION_QUIZ.mistakes.push({
      prompt:quizValueFor(q.item,q.direction,'prompt'),
      selected,
      correct,
      direction:q.direction,
      kind:q.kind
    });
  }

  recordRevisionQuizAttempt(q.item,isCorrect);
  updateRevisionQuizScore();

  document.querySelectorAll('#quizOptions .quiz-option').forEach((btn,i)=>{
    btn.disabled=true;
    const value=q.options?.[i]||'';
    if(value===correct) btn.classList.add('correct');
    if(i===optionIndex&&!isCorrect) btn.classList.add('wrong');
  });

  const feedback=document.getElementById('quizFeedback');
  if(feedback){
    feedback.classList.remove('hidden');
    feedback.classList.toggle('correct-feedback',isCorrect);
    feedback.classList.toggle('wrong-feedback',!isCorrect);
    if(isCorrect){
      feedback.innerHTML='<strong>Correct</strong>';
    }else{
      const answerClass=q.direction==='en-ar'?'arabic-feedback':'';
      const answerAttrs=q.direction==='en-ar'?' lang="ar" dir="rtl"':'';
      feedback.innerHTML='<strong>Incorrect</strong><span>Correct answer: <b class="'+answerClass+'"'+answerAttrs+'>'+correct+'</b></span>';
    }
  }

  const next=document.getElementById('quizNextBtn');
  if(next) next.classList.remove('hidden');
  const fill=document.getElementById('quizProgressFill');
  if(fill) fill.style.width=(((REVISION_QUIZ.index+1)/REVISION_QUIZ.questions.length)*100)+'%';
}
function nextRevisionQuizQuestion(){
  if(!REVISION_QUIZ.answered) return;
  if(REVISION_QUIZ.index>=REVISION_QUIZ.questions.length-1){
    finishRevisionQuiz();
    return;
  }
  REVISION_QUIZ.index++;
  renderRevisionQuizQuestion();
  document.getElementById('revision')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function renderRevisionMistakes(){
  const box=document.getElementById('quizMistakeReview');
  if(!box) return;

  if(!REVISION_QUIZ.mistakes.length){
    box.innerHTML='<div class="quiz-perfect-review"><strong>No mistakes to review.</strong><span>You answered every question correctly.</span></div>';
    return;
  }

  box.innerHTML='<div class="quiz-review-heading"><span class="quiz-kicker">REVIEW</span><h4>Mistakes to review</h4><p>'+REVISION_QUIZ.mistakes.length+' word'+(REVISION_QUIZ.mistakes.length===1?'':'s')+' to go over again.</p></div>'+
    '<div class="quiz-review-list">'+REVISION_QUIZ.mistakes.map((m,i)=>{
      const promptArabic=m.direction==='ar-en';
      const answerArabic=m.direction==='en-ar';
      const promptClass=promptArabic?' quiz-review-ar':'';
      const answerClass=answerArabic?' quiz-review-ar':'';
      const promptAttrs=promptArabic?' lang="ar" dir="rtl"':'';
      const answerAttrs=answerArabic?' lang="ar" dir="rtl"':'';

      return '<article class="quiz-review-item">'+
        '<div class="quiz-review-number">'+(i+1)+'</div>'+
        '<div class="quiz-review-content">'+
          '<div class="quiz-review-prompt'+promptClass+'"'+promptAttrs+'>'+m.prompt+'</div>'+
          '<div class="quiz-review-answer wrong-review-answer"><span>Your answer</span><strong class="'+(answerArabic?'quiz-review-ar':'')+'"'+answerAttrs+'>'+m.selected+'</strong></div>'+
          '<div class="quiz-review-answer correct-review-answer"><span>Correct answer</span><strong class="'+(answerArabic?'quiz-review-ar':'')+'"'+answerAttrs+'>'+m.correct+'</strong></div>'+
        '</div>'+
      '</article>';
    }).join('')+'</div>';
}

function finishRevisionQuiz(){
  REVISION_QUIZ.active=false;
  const total=REVISION_QUIZ.questions.length||1;
  const pct=Math.round((REVISION_QUIZ.correct/total)*100);

  document.getElementById('revisionQuizPlay')?.classList.add('hidden');
  document.getElementById('revisionQuizSetup')?.classList.add('hidden');
  document.getElementById('revisionQuizResult')?.classList.remove('hidden');

  const percent=document.getElementById('quizFinalPercent');
  const score=document.getElementById('quizFinalScore');
  const correct=document.getElementById('quizResultCorrect');
  const wrong=document.getElementById('quizResultWrong');
  if(percent) percent.textContent=pct+'%';
  if(score) score.textContent=REVISION_QUIZ.correct+' / '+REVISION_QUIZ.questions.length+' correct';
  if(correct) correct.textContent=REVISION_QUIZ.correct;
  if(wrong) wrong.textContent=REVISION_QUIZ.wrong;

  renderRevisionMistakes();
  renderStats();
  renderSectionDashboards();
}

function formatDate(s){return new Date(s).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
function resetVocabularyFilters(){
  VOCAB_PAGE=1;
  VOCAB_COLLECTION_FILTER='all';
  SECTION_METRIC_FILTERS.vocabulary='all';

  const values={
    vocabSearch:'',
    categoryFilter:'',
    typeFilter:'',
    sourceFilter:'',
    statusFilter:''
  };
  Object.entries(values).forEach(([id,value])=>{const el=document.getElementById(id);if(el)el.value=value;});
  const fav=document.getElementById('favouriteFilter');if(fav)fav.checked=false;
  document.querySelectorAll('[data-vocab-set]').forEach(btn=>btn.classList.toggle('active',btn.dataset.vocabSet==='all'));
  renderSectionDashboards();
  renderVocabulary();
}

function resetVerbFilters(){
  VERB_PAGE=1;
  VERB_COLLECTION_FILTER='all';
  SECTION_METRIC_FILTERS.verbs='all';

  ['verbSearch','formFilter','verbTypeFilter','babFilter'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.value='';
  });
  document.querySelectorAll('[data-verb-set]').forEach(btn=>btn.classList.toggle('active',btn.dataset.verbSet==='all'));
  renderSectionDashboards();
  renderVerbs();
  if(currentVerbTest)newVerbTestCard();
}

function resetRootFilters(){
  SELECTED_ROOT=null;
  ROOT_METRIC_FILTER='all';

  const search=document.getElementById('rootSearch');if(search)search.value='';
  const letter=document.getElementById('rootLetterFilter');if(letter)letter.value='';
  const sort=document.getElementById('rootSort');if(sort)sort.value='alphabetical';

  renderRootsDashboard();
  renderRoots();
}

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
  document.getElementById('rootSearch')?.addEventListener('input',renderRoots);
  document.getElementById('rootSort')?.addEventListener('input',renderRoots);
  document.getElementById('rootLetterFilter')?.addEventListener('input',renderRoots);
  document.getElementById('resetVocabFilters')?.addEventListener('click',resetVocabularyFilters);
  document.getElementById('resetVerbFilters')?.addEventListener('click',resetVerbFilters);
  document.getElementById('resetRootFilters')?.addEventListener('click',resetRootFilters);
  document.getElementById('speakingTopicFilter').addEventListener('input',renderSpeaking);
  document.getElementById('nahwTopicFilter')?.addEventListener('input',renderNahw);
  document.getElementById('quranSurahFilter')?.addEventListener('change',renderQuranicTarkeeb);
  document.querySelectorAll('[data-quiz-bank]').forEach(btn=>btn.addEventListener('click',()=>{
    REVISION_QUIZ.bank=btn.dataset.quizBank||'both';
    document.querySelectorAll('[data-quiz-bank]').forEach(b=>b.classList.toggle('active',b===btn));
    updateRevisionQuizSetupVisibility();
  }));
  document.querySelectorAll('[data-quiz-vocab-source]').forEach(btn=>btn.addEventListener('click',()=>{
    REVISION_QUIZ.vocabSource=btn.dataset.quizVocabSource||'all';
    document.querySelectorAll('[data-quiz-vocab-source]').forEach(b=>b.classList.toggle('active',b===btn));
  }));
  document.querySelectorAll('[data-quiz-verb-source]').forEach(btn=>btn.addEventListener('click',()=>{
    REVISION_QUIZ.verbSource=btn.dataset.quizVerbSource||'all';
    document.querySelectorAll('[data-quiz-verb-source]').forEach(b=>b.classList.toggle('active',b===btn));
  }));
  document.querySelectorAll('[data-quiz-length]').forEach(btn=>btn.addEventListener('click',()=>{
    REVISION_QUIZ.length=Number(btn.dataset.quizLength)||25;
    document.querySelectorAll('[data-quiz-length]').forEach(b=>b.classList.toggle('active',b===btn));
  }));
  document.querySelectorAll('[data-quiz-direction]').forEach(btn=>btn.addEventListener('click',()=>{
    REVISION_QUIZ.direction=btn.dataset.quizDirection||'both';
    document.querySelectorAll('[data-quiz-direction]').forEach(b=>b.classList.toggle('active',b===btn));
  }));
  document.getElementById('startRevisionQuiz')?.addEventListener('click',startRevisionQuiz);
  document.getElementById('quizOptions')?.addEventListener('click',e=>{
    const btn=e.target.closest('[data-quiz-option]');
    if(btn) answerRevisionQuiz(Number(btn.dataset.quizOption));
  });
  document.getElementById('quizNextBtn')?.addEventListener('click',nextRevisionQuizQuestion);
  document.getElementById('restartRevisionQuiz')?.addEventListener('click',showRevisionQuizSetup);
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
      renderAll();showRevisionQuizSetup();
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
