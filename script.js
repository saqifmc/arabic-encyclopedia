let DATA = { vocabulary: [], speaking: [] };
let currentCard = null;

async function loadData(){
  const res = await fetch('vocab.json');
  DATA = await res.json();
  setup();
}

function setup(){
  bindNavigation();
  renderStats();
  populateFilters();
  renderVocabulary();
  renderRoots();
  renderVerbs();
  renderSpeaking();
  newRevisionCard();
  bindEvents();
}

function bindNavigation(){
  document.querySelectorAll('[data-view]').forEach(btn=>{
    btn.addEventListener('click',()=>showView(btn.dataset.view));
  });
}
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({top:0,behavior:'smooth'});
}
function renderStats(){
  const total = DATA.vocabulary.length;
  const verbs = DATA.vocabulary.filter(x=>x.type==='Verb').length;
  const learning = DATA.vocabulary.filter(x=>x.status==='Learning').length;
  const mastered = DATA.vocabulary.filter(x=>x.status==='Mastered').length;
  const speaking = DATA.speaking.length;
  document.getElementById('stats').innerHTML = [
    ['Total Words',total],['Verbs',verbs],['Speaking Phrases',speaking],['Learning',learning],['Mastered',mastered]
  ].map(([a,b])=>`<div class="stat"><span>${a}</span><strong>${b}</strong></div>`).join('');
}
function unique(arr){ return [...new Set(arr.filter(Boolean))].sort(); }
function fillSelect(id,values){
  const el=document.getElementById(id);
  values.forEach(v=>el.insertAdjacentHTML('beforeend',`<option value="${v}">${v}</option>`));
}
function populateFilters(){
  fillSelect('typeFilter',unique(DATA.vocabulary.map(x=>x.type)));
  fillSelect('statusFilter',unique(DATA.vocabulary.map(x=>x.status)));
  fillSelect('formFilter',unique(DATA.vocabulary.map(x=>x.form)));
  fillSelect('speakingTopicFilter',unique(DATA.speaking.map(x=>x.topic)));
}
function vocabCard(x){
  return `<article class="item">
    <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
    <h3>${x.english}</h3>
    <div class="meta">Root: ${x.root||'—'} · Type: ${x.type} ${x.form?`· Form ${x.form}`:''} · ${x.status}</div>
    ${x.past?`<div class="meta">Past: <span lang="ar" dir="rtl">${x.past}</span> · Present: <span lang="ar" dir="rtl">${x.present}</span> · Maṣdar: <span lang="ar" dir="rtl">${x.masdar}</span></div>`:''}
    ${x.example?`<div class="example" lang="ar" dir="rtl">${x.example}</div><div class="meta">${x.example_en}</div>`:''}
  </article>`;
}
function renderVocabulary(){
  const q=(document.getElementById('vocabSearch')?.value||'').toLowerCase();
  const type=document.getElementById('typeFilter')?.value||'';
  const status=document.getElementById('statusFilter')?.value||'';
  const rows=DATA.vocabulary.filter(x=>{
    const hay=[x.arabic,x.english,x.root,x.topic,x.source].join(' ').toLowerCase();
    return hay.includes(q) && (!type||x.type===type) && (!status||x.status===status);
  });
  document.getElementById('vocabList').innerHTML=rows.map(vocabCard).join('')||'<p>No matches.</p>';
}
function renderRoots(){
  const groups={};
  DATA.vocabulary.filter(x=>x.root).forEach(x=>{
    groups[x.root]=groups[x.root]||[];
    groups[x.root].push(x);
  });
  document.getElementById('rootsList').innerHTML=Object.entries(groups).map(([root,items])=>`
    <div class="root-card">
      <div class="root-title" lang="ar" dir="rtl">${root}</div>
      <div class="root-words" lang="ar" dir="rtl">${items.map(x=>x.arabic).join(' · ')}</div>
      <div class="meta">${items.length} item${items.length>1?'s':''}</div>
    </div>`).join('');
}
function renderVerbs(){
  const form=document.getElementById('formFilter')?.value||'';
  const rows=DATA.vocabulary.filter(x=>x.type==='Verb'&&(!form||x.form===form));
  document.getElementById('verbsList').innerHTML=rows.map(vocabCard).join('');
}
function renderSpeaking(){
  const topic=document.getElementById('speakingTopicFilter')?.value||'';
  const rows=DATA.speaking.filter(x=>!topic||x.topic===topic);
  document.getElementById('speakingList').innerHTML=rows.map(x=>`
    <article class="item">
      <div class="arabic" lang="ar" dir="rtl">${x.arabic}</div>
      <h3>${x.english}</h3>
      <div class="meta">${x.topic} · ${x.status}</div>
    </article>`).join('');
}
function newRevisionCard(){
  const mode=document.getElementById('revisionMode')?.value||'ar-en';
  const pool=mode==='speaking'?DATA.speaking:DATA.vocabulary;
  currentCard=pool[Math.floor(Math.random()*pool.length)];
  const prompt=document.getElementById('flashPrompt');
  const answer=document.getElementById('flashAnswer');
  answer.classList.add('hidden');
  document.getElementById('ratingButtons').classList.add('hidden');
  if(mode==='ar-en'){
    prompt.textContent=currentCard.arabic; prompt.className='flash-prompt arabic';
    answer.textContent=currentCard.english; answer.className='flash-answer hidden';
  } else if(mode==='en-ar'){
    prompt.textContent=currentCard.english; prompt.className='flash-prompt';
    answer.textContent=currentCard.arabic; answer.className='flash-answer arabic hidden';
  } else {
    prompt.textContent=currentCard.english; prompt.className='flash-prompt';
    answer.textContent=currentCard.arabic; answer.className='flash-answer arabic hidden';
  }
}
function bindEvents(){
  ['vocabSearch','typeFilter','statusFilter'].forEach(id=>document.getElementById(id).addEventListener('input',renderVocabulary));
  document.getElementById('formFilter').addEventListener('input',renderVerbs);
  document.getElementById('speakingTopicFilter').addEventListener('input',renderSpeaking);
  document.getElementById('revisionMode').addEventListener('change',newRevisionCard);
  document.getElementById('newCardBtn').addEventListener('click',newRevisionCard);
  document.getElementById('revealBtn').addEventListener('click',()=>{
    document.getElementById('flashAnswer').classList.remove('hidden');
    document.getElementById('ratingButtons').classList.remove('hidden');
  });
  document.querySelectorAll('[data-rating]').forEach(btn=>btn.addEventListener('click',newRevisionCard));
  document.getElementById('globalSearch').addEventListener('input',e=>{
    const q=e.target.value.trim().toLowerCase();
    const box=document.getElementById('searchResults');
    if(!q){box.classList.add('hidden');box.innerHTML='';return;}
    const vocab=DATA.vocabulary.filter(x=>[x.arabic,x.english,x.root,x.topic].join(' ').toLowerCase().includes(q));
    const speaking=DATA.speaking.filter(x=>[x.arabic,x.english,x.topic].join(' ').toLowerCase().includes(q));
    box.classList.remove('hidden');
    box.innerHTML=[...vocab.map(vocabCard),...speaking.map(x=>`<article class="item"><div class="arabic" lang="ar" dir="rtl">${x.arabic}</div><h3>${x.english}</h3><div class="meta">${x.topic}</div></article>`)].join('')||'<p>No matches.</p>';
  });
}

loadData();
