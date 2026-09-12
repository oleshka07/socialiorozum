// ЛОГІКА ЗАСТОСУНКУ (винесена з app.html): один глобальний скоуп, як і inline-скрипт раніше.
// Лінт: npm run lint (eslint public/app.js - ловить TDZ/undef/дублікати до деплою).
// Наступний крок модульності: різати на composer.js / studio.js / calendar.js / settings.js.

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// ===== ГЛОБАЛЬНИЙ СТАН (оголошення вгорі - ESLint no-use-before-define ловить TDZ-баги) =====
let curLayout='studio';        // активна розкладка Створення (studio|pipeline)
let PRO=false;                 // тариф-флаг (перемикач в аватар-меню)
let Rubrics=[];                // рубрики воркспейсу (для селектів/чіпів)
let ChanStatus={};             // підключені мережі {net:true}
let ThStrat={};                // threads_strategy JSON {thread,cta_min,takes}
let Pub={ bank: [], slots: [] };   // банк затверджених + слоти календаря
let obVoiceImported=false;     // онбординг: чи вже тягнули голос з IG
const NETS=[['telegram','Telegram'],['instagram','Instagram'],['facebook','Facebook'],['threads','Threads'],['linkedin','LinkedIn']];
// 🎨 формат контент-одиниці: третій вимір поруч із рубрикою (про що) і каналом (куди)
const FMT_META={post:['📝','Пост','звичайний текстовий пост'],carousel:['🖼','Карусель','кілька слайдів, які читач перегортає - найкраще збирає збереження'],reel:['🎬','Рілс','короткий вертикальний відео-сценарій - найкраще охоплення'],story:['⚡','Сторіс','ефемерний кадр на 24 години']};
const FMT_KEYS=['post','carousel','reel','story'];
const NETVAR={telegram:'--tg',instagram:'--ig',facebook:'--fb',threads:'--th',linkedin:'--li'};
const NETICON={telegram:'M22 4L2 11l6 2 2 6 3-4 5 4 4-15z',instagram:'M7 3h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7a4 4 0 014-4zm5 5a4 4 0 100 8 4 4 0 000-8z',facebook:'M14 9V7c0-1 .5-1.5 1.5-1.5H17V2h-3c-2.5 0-4 1.5-4 4v3H7v3h3v9h4v-9h3l.5-3H14z',threads:'M12 3c5 0 8 3 8 9s-3 9-8 9-8-3-8-9c0-2 .5-3.5 1.5-4.5',linkedin:'M4 4h4v16H4V4zm2-1a2 2 0 110-4 2 2 0 010 4zm5 5h4v2c.8-1.3 2.2-2.3 4-2.3 3 0 5 2 5 5.3V20h-4v-8c0-1.5-.8-2.5-2-2.5s-2 1-2 2.5v8h-5V8z'};
const CP_LABEL={telegram:'Telegram',instagram:'Instagram',threads:'Threads',facebook:'Facebook'};
const STEP  = {1:'extract_ideas',3:'drafts',4:'tone',5:'format',6:'deai',7:'strategy'};
const ORDER = [1,3,4,5,6,7];
const SET = {mkt:'marketing_context', tov:'tone_of_voice', deai:'deai_rules', strat:'content_strategy', voiceExamples:'voice_examples', imgStyle:'image_style', vSign:'voice_signature', vStop:'voice_stoplist', goalMetric:'goal_metric', bAssoc:'brand_assoc', bAntiAssoc:'brand_antiassoc', bStory:'brand_story', bInterests:'brand_interests', offerLow:'offer_low', offerMid:'offer_mid', offerHigh:'offer_high', brandThesis:'brand_thesis', painPoints:'pain_points'};
const AUTORUN_WARN='Авто-прогін запускатиме повну AI-генерацію постів на КОЖНУ нову статтю/зустріч - це витрачає кошти на AI. Увімкнути?';
// час: усе планування рахуємо в поясі TZ (обирається в Налаштуваннях); у БД - UTC
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv';
const TZS=['Europe/Kyiv','Europe/Warsaw','Europe/Berlin','Europe/London','Europe/Lisbon','America/New_York','America/Chicago','America/Los_Angeles','Asia/Dubai','Asia/Jerusalem','UTC'];
function buildTzSel(){ const sel=$('tzSel'); if(!sel) return; const list=TZS.includes(TZ)?TZS:[TZ].concat(TZS); sel.innerHTML=list.map(z=>'<option'+(z===TZ?' selected':'')+'>'+z+'</option>').join(''); }
const locDate=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));
const locHM=(d)=>new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d));
function tzOffMs(date){ const p=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(date).reduce((a,x)=>{a[x.type]=x.value;return a;},{}); const asUTC=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+(p.second||0)); return asUTC-date.getTime(); }
function zonedToUTCISO(dateStr,timeStr){ const [Y,Mo,D]=dateStr.split('-').map(Number); const [h,m]=timeStr.split(':').map(Number); const guess=Date.UTC(Y,Mo-1,D,h,m); return new Date(guess - tzOffMs(new Date(guess))).toISOString(); }
const SAMPLE = `Клієнт: я постійно відкладаю важливі справи, сідаю за роботу і одразу лізу в телефон.
Коуч: давай подивимось, що відбувається в момент перед тим, як ти береш телефон. Який це стан?
Клієнт: тривога. Ніби боюся почати, бо раптом не вийде ідеально.
Коуч: тобто телефон - це спосіб втекти від тривоги, а не лінь. Перфекціонізм часто маскується під прокрастинацію.
Клієнт: так, я ніколи так не думав. Я себе просто вважав лінивим.
Коуч: спробуй наступного разу домовитись із собою про «погану першу версію» - дозволь зробити неідеально за 10 хвилин.
Клієнт: о, це звучить реально. І ще я помітив, що зранку легше, коли я не дивлюся новини відразу.
Коуч: чудове спостереження. Ранковий простір без шуму - це ресурс. Зробимо це твоїм експериментом на тиждень.`;

let runId = localStorage.getItem('kg_run') || null;
let S = {plan:[], schedule:{}};
let busy = false;
let curView = 'create';
// вкладки розділів: стан угорі, бо його читає маршрутизатор ROUTE_TABS (визначений вище за setXTab)
let cTab='posts', pTab='cal', bTab='voice', sTab='profile';
let _cmpOpenId=null;      // id поста, відкритого в композері (для deep-лінка #/post/<id>)
let _routeSilent=false;   // перемикаємо розділ БЕЗ запису адреси (її пише той, хто головний - напр. композер)
let Finals = [];
let Guide={tips:[],i:0,on:true,busy:false,shownAt:0}; // 🦉 сова-провідник (стан угорі - selectView його читає)
function owlEl(){ return $('owl'); } // hoisted - безпечно з selectView вище

async function api(path, opts){
  const r = await fetch('/api'+path, opts||{});
  if(!r.ok){
    // сервер віддає {error:"людський текст"} - показуємо саме його, а не сирий JSON зі статусом;
    // 402 = стеля витрат на AI (не «зламалось», а «ліміт») - код лишаємо в повідомленні для ясності
    // Якщо сервер дав {error:"…"} - це вже людський текст, і префікс «500:» перед ним лише лякає
    // («сервер зламався», хоча це, скажімо, стеля витрат). Статус лишаємо тільки для не-JSON відповідей.
    const t = await r.text(); let msg='';
    try{ const j=JSON.parse(t); if(j&&j.error) msg=String(j.error); }catch(e){}
    throw new Error(msg || (r.status+': '+t.slice(0,200)));
  }
  const ct = r.headers.get('content-type')||'';
  return ct.includes('json') ? r.json() : r.text();
}
let _toastT; function flash(m){ const t=$('toast'); if(!t) return; t.textContent=m; t.classList.add('show'); clearTimeout(_toastT); _toastT=setTimeout(()=>t.classList.remove('show'),2300); }
// глобальний індикатор довгої AI-дії: aiBusy('що робимо…') на старті, aiDone() у finally.
// Лічильник дозволяє паралельні дії - банер зникає, коли завершилась остання.
let _aiN=0;
function aiBusy(label){ _aiN++; let b=$('aiBusy'); if(!b){ b=document.createElement('div'); b.id='aiBusy'; b.innerHTML='<span class="orb"></span><span id="aiBusyTxt"></span>'; document.body.appendChild(b); } const t=$('aiBusyTxt'); if(t) t.textContent=label||'AI працює…'; requestAnimationFrame(()=>b.classList.add('show')); }
function aiDone(){ _aiN=Math.max(0,_aiN-1); if(_aiN<1){ const b=$('aiBusy'); if(b) b.classList.remove('show'); } }

// ---------- тема ----------
const MOON='M21 12.8A9 9 0 1111.2 3a7 7 0 109.8 9.8z';
const SUN='M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M6 18l-1.5 1.5M19.5 4.5L18 6M12 8a4 4 0 100 8 4 4 0 000-8z';
function setTheme(t){ document.body.setAttribute('data-theme',t); localStorage.setItem('kg_theme',t); const ic=$('themeIcon'); if(ic) ic.setAttribute('d', t==='light'?MOON:SUN); }
$('themeToggle').onclick=()=>setTheme(document.body.getAttribute('data-theme')==='light'?'dark':'light');

// ---------- навігація ----------
const PAGES={today:['Сьогодні','Що виходить, що затвердити і що зробити зараз'],create:['Створення','Переглянь і затвердь готові пости'],publish:['Публікація','Запланований контент і календар'],brand:['Бренд і стратегія','Голос, візуал і цілі - вводяться раз, працюють всюди'],analytics:['Аналітика','Ефективність контенту і витрати'],settings:['Налаштування','Профіль, канали публікації та джерела'],tools:['Інструменти','Розширені й рідко вживані функції']};
// ---------- 📌 липка плашка розділу: вкладки + дії розділу переїжджають у неї ----------
// Вкладки кожного розділу ФІЗИЧНО переносяться у #phTabs (вузол той самий - обробники живі),
// тож не треба дублювати розмітку й переписувати всі setCTab/setPTab/setBTab/setSTab.
const VIEW_TABS={create:'cTabs',publish:'pubTabs',brand:'bTabs',settings:'sTabs'};
function mountViewTabs(v){
  const host=$('phTabs'); if(!host) return;
  // повертаємо попередні вкладки на їхнє місце в секції (щоб не загубились між перемиканнями)
  [...host.children].forEach(el=>{ const home=el._home; if(home) home.appendChild(el); else el.remove(); });
  const id=VIEW_TABS[v]; if(!id) return;
  const t=$(id); if(!t) return;
  if(!t._home) t._home=t.parentNode;   // запамʼятовуємо, куди вертати
  host.appendChild(t);
}
// поп-ап, що «виїжджає» з кнопки: панель фізично переїздить у нього й вертається назад при закритті
let PopOpen=null;
function closePop(){ if(!PopOpen) return;
  const { pop, bg, node, home, btn } = PopOpen; PopOpen=null;
  if(node&&home) home.appendChild(node);          // панель вертається у свій схований хост
  pop.remove(); bg.remove(); if(btn) btn.classList.remove('on');
}
function openPop(btn, hostId, title){
  const host=$(hostId); if(!host) return;
  const node=host.firstElementChild; if(!node) return;
  if(PopOpen&&PopOpen.hostId===hostId){ closePop(); return; }   // повторний клік = згорнути назад у кнопку
  closePop();
  const bg=document.createElement('div'); bg.className='popov-bg';
  const pop=document.createElement('div'); pop.className='popov';
  pop.innerHTML='<div class="popov-h"><b>'+esc(title)+'</b><button class="icon" id="popX" style="margin-left:auto" title="Закрити">✕</button></div><div id="popBody"></div>';
  document.body.appendChild(bg); document.body.appendChild(pop);
  pop.querySelector('#popBody').appendChild(node);
  PopOpen={ pop, bg, node, home:host, btn, hostId };
  btn.classList.add('on');
  // позиція: під кнопкою, вирівняно по правому краю кнопки, з утриманням у межах екрана
  const r=btn.getBoundingClientRect();
  const w=Math.min(560, window.innerWidth-20);
  pop.style.width=w+'px';
  pop.style.top=Math.min(window.innerHeight-60, r.bottom+8)+'px';
  pop.style.left=Math.max(10, Math.min(window.innerWidth-w-10, r.right-w))+'px';
  bg.onclick=closePop; pop.querySelector('#popX').onclick=closePop;
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&PopOpen) closePop(); });
// дії розділу праворуч у липкій плашці (для Публікації залежать від активної вкладки)
function renderViewActions(v){
  const box=$('phActions'); if(!box) return;
  closePop(); box.innerHTML='';
  if(v!=='publish') return;
  const isPlan=$('layPlan')&&$('layPlan').style.display!=='none'&&$('pubPlanHost')&&$('pubPlanHost').style.display!=='none';
  // Банк тепер ЖИВЕ лівою колонкою біля календаря (не попапом) - кнопки для нього тут нема;
  // попапами лишились лише панелі Плану, які справді потрібні раз на кілька днів.
  const btns=isPlan
    ? [['skeletonHost','📋 Скелет','Згенерувати скелет плану: горизонт, темп, теми'],
       ['rhythmHost','📡 Ритм каналів','Дні/час/формати публікацій по мережах']]
    : [];
  btns.forEach(([hostId,label,tip])=>{
    const b=document.createElement('button'); b.className='ghost'; b.title=tip; b.textContent=label;
    b.style.cssText='padding:6px 12px;font-size:12.5px';
    b.onclick=()=>openPop(b,hostId,label.replace(/^\S+\s/,''));
    box.appendChild(b);
  });
}
// 🏦 згортання лівої колонки банку: стан памʼятається між сесіями (кому банк не треба - той його
// закрив раз і бачить весь календар; drag-drop не ламається, бо вузли лишаються в DOM)
function setBankFold(fold){
  const col=$('bankHost'), un=$('bankUnfold'); if(!col||!un) return;
  col.style.display=fold?'none':''; un.style.display=fold?'flex':'none';
  try{ localStorage.setItem('kg_bankfold', fold?'1':'0'); }catch(e){}
}
if($('bankFold')) $('bankFold').onclick=()=>setBankFold(true);
if($('bankUnfold')) $('bankUnfold').onclick=()=>setBankFold(false);
try{ setBankFold(localStorage.getItem('kg_bankfold')==='1'); }catch(e){}
// ---------- 🔗 маршрутизація: у кожного розділу й вкладки своя адреса (#/publish/plan) ----------
// Раніше стан жив лише у змінних + латка в localStorage, тож оновлення сторінки кидало на ДЕФОЛТНУ
// вкладку розділу (Публікація → завжди Календар, Бренд → завжди Голос), кнопка «назад» виходила із
// застосунку, а поділитись посиланням на конкретний екран було ніяк. Хеш-маршрути (а не History API)
// свідомо: не треба ні нового роуту на сервері, ні правок nginx, ні змін у OAuth-редіректах на /app.
const ROUTE_TABS={
  create:  { keys:['materials','posts','ideas'], set:(t)=>setCTab(t), get:()=>cTab },
  publish: { keys:['cal','plan'],                set:(t)=>setPTab(t), get:()=>pTab },
  brand:   { keys:['voice','visual','strat'],    set:(t)=>setBTab(t), get:()=>bTab },
  settings:{ keys:['profile','channels','sources'], set:(t)=>setSTab(t), get:()=>sTab },
};
const ROUTE_VIEWS=['today','create','publish','brand','analytics','settings','tools'];
function writeRoute(v,tab){
  if(_routeSilent) return;
  const h='#/'+v+(tab?'/'+tab:'');
  if(location.hash===h) return;
  location.hash=h; // саме hash (а не pushState): дає запис в історії, тож «назад» працює
}
// застосувати адресу до інтерфейсу. Ідемпотентна НАВМИСНО: writeRoute→hashchange→applyRoute не
// зациклюється, бо коли потрібний розділ/вкладка вже активні, функція нічого не робить.
function applyRoute(){
  const parts=(location.hash||'').replace(/^#\/?/,'').split('/').filter(Boolean);
  const v=parts[0]||'', tab=parts[1]||'';
  // 🔗 deep-link на КОНКРЕТНИЙ пост: `#/post/<id>` відкриває його в композері. Саме це дає лінкам
  // з бота («сценарій готовий», «пост залетів») вести прямо в потрібний пост, а не просто «в застосунок».
  if(v==='post'&&parts[1]){
    if(_cmpOpenId===parts[1]) return true;             // уже відкритий - нічого не робимо (ідемпотентність)
    // розділ під композером перемикаємо МОВЧКИ: адресу тримає сам композер, інакше selectView
    // перезаписав би її на #/create/posts і лінк на пост загубився б
    _routeSilent=true; try{ selectView('create','posts'); } finally { _routeSilent=false; }
    if(typeof openComposer==='function') openComposer(parts[1]);
    return true;
  }
  // 🔗 deep-link на КОНКРЕТНИЙ матеріал: `#/material/<id>` веде з бота прямо в той запис щоденника.
  // Фільтри стрічки скидаємо НАВМИСНО: якщо активний фільтр за типом чи стрічкою, потрібний матеріал
  // просто не потрапив би в список, і лінк привів би у порожній екран.
  if(v==='material'&&parts[1]){ openMaterialDeep(parts[1]); return true; }
  if(!ROUTE_VIEWS.includes(v)) return false;
  if(v!==curView) selectView(v,tab||undefined);
  else if(tab){ const r=ROUTE_TABS[v]; if(r&&r.keys.includes(tab)&&r.get()!==tab) r.set(tab); }
  return true;
}
window.addEventListener('hashchange',applyRoute);
function selectView(v,tab){
  if(v==='sources'){ v='settings'; tab=tab||'sources'; } // джерела живуть у Налаштуваннях
  if(v==='strategy'){ v='brand'; tab=tab||'strat'; }     // Стратегія злита з Брендом («Бриф і цілі»)
  document.querySelectorAll('.navitem').forEach(x=>x.classList.toggle('active',x.dataset.view===v));
  document.querySelectorAll('.viewsec').forEach(x=>x.classList.toggle('active',x.dataset.view===v));
  const p=PAGES[v]||['','']; $('pageTitle').textContent=p[0]; $('pageSub').textContent=p[1];
  mountViewTabs(v); renderViewActions(v);        // вкладки й дії розділу - у липку плашку
  $('genPostsBtn').style.display='inline-flex'; // «＋ Додати матеріал» доступна з будь-якого розділу
  if(v==='today') loadToday();
  if(v==='analytics') loadAnalytics();
  if(v==='publish'){ loadPublish(); loadPlan(); }
  if(v==='create') loadStudioPosts();
  if(v==='settings'){ loadAccount(); loadPlans(); }
  if(v==='tools') loadAbTest(); // каталог моделей тягнеться раз (див. _abReady)
  if(typeof loadTasks==='function') loadTasks();
  curView=v; if(typeof renderTaskStrip==='function') renderTaskStrip(v);
  // вкладку застосовуємо ПІСЛЯ перемикання розділу (setXTab покладеться на curView), і лише якщо
  // вона валідна для цього розділу; інакше лишається та, що була (або дефолтна)
  const r=ROUTE_TABS[v];
  if(r&&tab&&r.keys.includes(tab)&&r.get()!==tab) r.set(tab);
  else writeRoute(v, r?r.get():'');
  try{ localStorage.setItem('kg_view', v); }catch(e){} // фолбек, коли відкривають /app без адреси
  // сова перепозиціонується під поточну ціль підказки після зміни розділу (макет змінився)
  try{ if(Guide&&Guide.on&&Guide.tips.length&&owlEl()&&owlEl().style.display!=='none'){ const t=Guide.tips[Guide.i]; if(t&&$('owlBubble').style.display!=='none'){ const p=owlPosition(t.target); $('owlBubble').classList.toggle('below',p==='below'); } } }catch(e){}
}
function go(v){ selectView(v); }
document.querySelectorAll('.navitem').forEach(n=>n.onclick=()=>selectView(n.dataset.view));

// ---------- вкладки Бренду (Голос/Візуал) і Налаштувань (Профіль/Канали/Джерела) ----------
function setBTab(b){
  bTab=b; if(curView==='brand') writeRoute('brand',b);
  document.querySelectorAll('#bTabs .tab').forEach(x=>x.classList.toggle('on',x.dataset.btab===b));
  if($('brandVoice')) $('brandVoice').style.display=b==='voice'?'':'none';
  if($('brandVisual')) $('brandVisual').style.display=b==='visual'?'':'none';
  if($('brandStratHost')) $('brandStratHost').style.display=b==='strat'?'':'none';
  if(b==='visual'){ try{ loadBroll(); }catch(e){} }
}
// переселення розділу «Стратегія» у вкладку Бренду (вузол той самий - обробники живі)
(function(){ const host=$('brandStratHost'), sec=document.querySelector('.viewsec[data-view="strategy"]');
  if(host&&sec){ while(sec.firstChild) host.appendChild(sec.firstChild); sec.remove(); } })();
document.querySelectorAll('#bTabs .tab').forEach(x=>x.onclick=()=>setBTab(x.dataset.btab));
function setSTab(s){
  sTab=s; if(curView==='settings') writeRoute('settings',s);
  document.querySelectorAll('#sTabs .tab').forEach(x=>x.classList.toggle('on',x.dataset.stab===s));
  const M={profile:'setProfile',channels:'setChannels',sources:'setSources'};
  for(const k in M){ const el=$(M[k]); if(el) el.style.display=k===s?'':'none'; }
}
document.querySelectorAll('#sTabs .tab').forEach(x=>x.onclick=()=>setSTab(x.dataset.stab));

// ---------- меню під аватаром ----------
(function(){
  const av=$('avatar'), um=$('userMenu'); if(!av||!um) return;
  const close=()=>{ um.style.display='none'; };
  av.onclick=(e)=>{ e.stopPropagation(); um.style.display=um.style.display==='none'?'':'none'; };
  document.addEventListener('click',(e)=>{ if(um.style.display!=='none' && !um.contains(e.target) && e.target!==av) close(); });
  um.querySelectorAll('.umitem[data-um]').forEach(it=>it.onclick=()=>{ close(); selectView('settings'); setSTab({profile:'profile',channels:'channels',sources:'sources'}[it.dataset.um]); });
  // 🧰 Інструменти: окремий розділ з розширеними функціями (конвеєр, промт, GDrive, транскрибатори)
  const tools=$('umTools'); if(tools) tools.onclick=()=>{ close(); selectView('tools'); };
  // 🦉 «Помічник Розум» у меню - обробник навішується в owlInit (щоб не викликати до визначення)
})();

// ---------- розділ «Інструменти»: переселення розширених панелей з Джерел (вузли ті самі - обробники живі) ----------
(function(){
  const mv=(innerId,hostId)=>{ const el=$(innerId), host=$(hostId); if(!el||!host) return null; const p=el.closest('.panel'); if(p){ const g=p.parentElement; host.appendChild(p); if(g&&g.classList.contains('grid2')&&g.children.length<2) g.style.display='block'; } return p; };
  mv('gdStatus','toolsGdriveHost');   // 📁 Google Drive - просунута інтеграція, щоденним Джерелам не потрібна
  mv('ffKey','toolsTransHost');       // 🎙 Транскрибація (Fireflies) - підключається раз
  mv('mtUrl','toolsTransHost');       // 🎤 свій транскрибатор (Vymova) - поруч, це той самий сценарій
  const tp=$('toolsPipeline'); if(tp) tp.onclick=()=>{
    if(!PRO){ flash('Конвеєр - інструмент режиму PRO (перемкни в меню акаунта)'); return; }
    selectView('create'); setLayout('pipeline'); };
})();

// ---------- layout switcher (Студія/Конвеєр/Інбокс) ----------
// ---------- задачі / бал заповнення (гейміфікація) ----------
let _lastScore=-1;
async function loadTasks(){ try{ const d=await api('/tasks'); window._tasks=d.tasks||[]; window._ctx=d.context||{}; try{ renderCtxBadge(d.context); }catch(e){} const v=$('scoreVal'); if(v)v.textContent=d.score+'%'; const sp=$('scorePill'); if(sp){ sp.style.color=d.score>=80?'var(--brand)':(d.score>=40?'var(--amber)':'var(--muted)'); sp.style.borderColor=d.score>=80?'var(--brand)':'var(--line2)'; } if(_lastScore>=0 && d.score>_lastScore) flyPoints('+'+(d.score-_lastScore)+'%'); _lastScore=d.score; const bySec={}; (d.tasks||[]).forEach(t=>{ if(!t.done) bySec[t.section]=(bySec[t.section]||0)+1; }); document.querySelectorAll('.navitem[data-view]').forEach(it=>{ const s=it.dataset.view; let b=it.querySelector('.navbadge'); const n=bySec[s]||0; if(!b){ b=document.createElement('span'); b.className='navbadge'; it.appendChild(b); } b.textContent=n||''; b.style.display=n?'inline-flex':'none'; }); renderTaskStrip(curView); }catch(e){} }
function flyPoints(txt){ const sp=$('scorePill'); if(!sp) return; const r=sp.getBoundingClientRect(); const el=document.createElement('div'); el.textContent=txt; el.style.cssText='position:fixed;left:'+(r.left+r.width/2)+'px;top:'+r.top+'px;transform:translateX(-50%);font-weight:800;color:var(--brand);font-size:16px;z-index:90;pointer-events:none;transition:top 1.1s ease,opacity 1.1s ease'; document.body.appendChild(el); requestAnimationFrame(()=>{ el.style.top=(r.top-48)+'px'; el.style.opacity='0'; }); setTimeout(()=>el.remove(),1200); try{ sp.animate([{transform:'scale(1)'},{transform:'scale(1.18)'},{transform:'scale(1)'}],{duration:480}); }catch(e){} }
function openTasksModal(){ const tasks=window._tasks||[]; const SECN={create:'Створення',publish:'Публікація',brand:'База бренду',strategy:'Стратегія',sources:'Джерела',settings:'Налаштування',analytics:'Аналітика'}; const order=['brand','strategy','settings','sources','create','publish']; const bySec={}; tasks.forEach(t=>{ (bySec[t.section]=bySec[t.section]||[]).push(t); }); const done=tasks.filter(t=>t.done).length;
  let html='<div class="modal-card" style="max-width:560px;padding:22px;max-height:86vh;overflow:auto"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="font-size:18px">🚀 Налаштування профілю</b><button class="icon" id="tkX" style="margin-left:auto">✕</button></div><div class="hint" style="margin-bottom:8px">Виконано '+done+' із '+tasks.length+' - що більше, то кращі пости.</div>';
  // 🔴 ПЕРШИМ РЯДКОМ - розшифровка червоної точки біля відсотка. Сама по собі вона нічого не пояснює:
  // людина бачить тривожний маркер і не знає ні що він означає, ні куди йти (фідбек Олега).
  const ctx=window._ctx||{};
  if(ctx.critical) html+='<div style="display:flex;align-items:center;gap:11px;padding:12px 13px;margin-bottom:6px;border:1px solid var(--danger);border-radius:11px;background:var(--danger-soft)">'
    +'<span style="font-size:15px">🔴</span><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:13.5px">Червона точка: у базі бренду '+ctx.critical+' суперечність(і)</div>'
    +'<div style="font-size:12.5px;color:var(--ink2);margin-top:2px">Поля, з яких збирається промт, заперечують одне одному - через це пости виходять слабкішими, скільки б задач ти не виконав.</div></div>'
    +'<button class="primary" id="tkCtx" style="padding:6px 12px;font-size:12.5px;flex:none">Перевірити</button></div>';
  order.concat(Object.keys(bySec).filter(s=>!order.includes(s))).forEach(sec=>{ const list=bySec[sec]; if(!list) return; html+='<div style="font-weight:700;font-size:12.5px;color:var(--muted);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.03em">'+(SECN[sec]||sec)+'</div>'; list.forEach(t=>{ html+='<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:12px;'+(t.done?'background:var(--brand);color:#fff':'border:2px solid var(--line2);color:var(--faint)')+'">'+(t.done?'✓':'')+'</span><div style="flex:1;font-size:13.5px;'+(t.done?'color:var(--faint);text-decoration:line-through':'')+'">'+esc(t.label)+'</div><span style="font-size:12px;color:var(--muted)">+'+t.points+'</span>'+(t.done?'':(t.id==='plans'?'<button class="ghost tkAck" data-key="seen_plans" style="padding:5px 10px;font-size:12px">Зрозуміло</button>':'<button class="ghost tkGo" data-sec="'+(t.id==='transcriber'||t.id==='gdrive'?'tools':t.section)+'" style="padding:5px 10px;font-size:12px">Перейти</button>'))+'</div>'; }); });
  html+='</div>'; const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='75'; ov.innerHTML=html; document.body.appendChild(ov); const close=()=>ov.remove(); ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#tkX').onclick=close;
  const ctxBtn=ov.querySelector('#tkCtx'); if(ctxBtn) ctxBtn.onclick=()=>{ close(); selectView('brand'); setBTab('voice');
    setTimeout(()=>{ const p=$('ctxPanel'); if(p) p.scrollIntoView({behavior:'smooth',block:'center'}); const r=$('ctxRun'); if(r) r.click(); },300); }; ov.querySelectorAll('.tkGo').forEach(b=>b.onclick=()=>{ close(); go(b.dataset.sec); }); ov.querySelectorAll('.tkAck').forEach(b=>b.onclick=async()=>{ try{ await api('/tasks/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:b.dataset.key})}); close(); loadTasks(); }catch(e){} }); }
if($('scorePill')) $('scorePill').onclick=openTasksModal;
const TASK_TARGET={brand:'#mkt',voice:'#tov',pains:'#painPoints',goal:'#goalChips',plan:'#planGenBtn',chan1:'#tgSharedBox',chan2:'#mtConnect',bot:'#tgSharedBox',transcriber:'#ffKey',plans:'#planPro',gdrive:'#gdConnect',source:'#rssUrl',media:'#mediaFile',strategy:'#genStrat',gen10:'#genPostsBtn',approve:'#genPostsBtn',schedule:'#bank',publish:'#bank'};
const _tdismiss=new Set(); const _tidx={};
function highlightTarget(sel){ const el=sel&&document.querySelector(sel); if(!el||!el.offsetParent) return; el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('thl'); setTimeout(()=>el.classList.remove('thl'),2200); }
// стан контексту поруч зі шкалою налаштування: детермінований шар безкоштовний, тож критичні
// суперечності видно ще до того, як людина здогадається натиснути «Перевірити»
function renderCtxBadge(c){
  const n=(c&&c.critical)||0, tot=(c&&c.total)||0;
  const b=$('ctxBadge');
  if(b){ b.style.display=tot?'inline':'none'; b.style.color=n?'var(--danger)':'var(--amber)';
    b.textContent=tot?(n?('🔴 '+n+' критичних'):('🟠 '+tot+' зауваж.')):''; }
  const sp=$('scorePill');
  if(sp){ let d=sp.querySelector('.ctxdot');
    if(n&&!d){ d=document.createElement('span'); d.className='ctxdot'; d.textContent='🔴';
      d.title='У базі бренду є суперечності, через які пости виходять слабкішими. Бренд → Голос → «Перевірка контексту»';
      d.style.cssText='margin-left:5px;font-size:10px'; sp.appendChild(d); }
    else if(!n&&d) d.remove(); }
}
function renderTaskStrip(view){ const strip=$('taskStrip'); if(!strip) return; const all=(window._tasks||[]).filter(t=>t.section===view && !t.done && !_tdismiss.has(t.id)); if(!all.length){ strip.style.display='none'; strip.innerHTML=''; return; } let i=_tidx[view]||0; if(i>=all.length) i=0; _tidx[view]=i; const t=all[i]; const tgt=TASK_TARGET[t.id]; strip.style.display='flex'; strip.className='tstrip'; strip.innerHTML='<span style="font-size:16px">💡</span><div style="flex:1;min-width:0"><b>'+esc(t.label)+'</b> <span style="color:var(--brand);font-weight:700">+'+t.points+'</span></div>'+(tgt?'<button class="ghost" id="tsShow" style="padding:5px 11px;font-size:12.5px">Показати</button>':'')+(all.length>1?'<button class="icon" id="tsPrev" title="Попередня">◀</button><span style="font-size:12px;color:var(--muted)">'+(i+1)+'/'+all.length+'</span><button class="icon" id="tsNext" title="Наступна">▶</button>':'')+'<button class="icon" id="tsX" title="Сховати">✕</button>'; const q=(s)=>strip.querySelector(s); if(q('#tsShow')) q('#tsShow').onclick=()=>highlightTarget(tgt); if(q('#tsPrev')) q('#tsPrev').onclick=()=>{ _tidx[view]=(i-1+all.length)%all.length; renderTaskStrip(view); }; if(q('#tsNext')) q('#tsNext').onclick=()=>{ _tidx[view]=(i+1)%all.length; renderTaskStrip(view); }; q('#tsX').onclick=()=>{ _tdismiss.add(t.id); renderTaskStrip(view); }; }
function loadPlans(){ const lite=$('planLiteBtn'), pro=$('planProBtn'); if(!pro) return;
  if(PRO){ pro.textContent='✓ Активно - вимкнути'; pro.className='ghost'; if(lite){ lite.textContent='Обрати Lite'; lite.className='ghost'; } }
  else { pro.textContent='Перейти на ПРО'; pro.className='primary'; if(lite){ lite.textContent='Поточний'; lite.className='ghost'; } }
  api('/tasks/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'seen_plans'})}).then(()=>{ if(typeof loadTasks==='function') loadTasks(); }).catch(()=>{});
}
if($('planProBtn')) $('planProBtn').onclick=async()=>{ try{ const next=PRO?'0':'1'; await saveSetting('pro',next); PRO=(next==='1'); if(typeof updateProUI==='function') updateProUI(); loadPlans(); if(typeof loadTasks==='function') loadTasks(); flash(PRO?'ПРО увімкнено ✓':'ПРО вимкнено'); if(!PRO&&$('layPipeline')&&$('layPipeline').style.display!=='none') setLayout('studio'); }catch(e){ flash('⚠ '+e.message); } };
if($('planLiteBtn')) $('planLiteBtn').onclick=async()=>{ if(!PRO) return; try{ await saveSetting('pro','0'); PRO=false; if(typeof updateProUI==='function') updateProUI(); loadPlans(); if(typeof loadTasks==='function') loadTasks(); flash('Lite активний'); if($('layPipeline')&&$('layPipeline').style.display!=='none') setLayout('studio'); }catch(e){} };
// ---------- конвеєр Створення: Матеріали → План → Чорновики ----------
function setCTab(t){
  if(t==='plan'){ selectView('publish'); setPTab('plan'); return; } // План переїхав у Публікацію (хаб календаря)
  cTab=t;
  if(curView==='create') writeRoute('create',t);
  try{ localStorage.setItem('kg_ctab', t); }catch(e){} // фолбек, коли відкривають /app без адреси
  document.querySelectorAll('#cTabs .tab').forEach(x=>x.classList.toggle('on',x.dataset.ctab===t));
  const show=(id,on)=>{ const el=$(id); if(el) el.style.display=on?'':'none'; };
  show('layMaterials',t==='materials');
  show('layIdeas',t==='ideas');
  const posts=t==='posts';
  show('layStudio',posts&&curLayout==='studio'); show('layPipeline',posts&&curLayout==='pipeline');
  const H={materials:'Стрічка сировини - все, з чого можна зробити пост',posts:'Переглянь, відредагуй, затвердь',ideas:'Банк ідей: з бота, AI-продовжень і твої власні - пост у 1 тап'};
  $('layoutHint').textContent=H[t]||''; if($('pageSub')) $('pageSub').textContent=H[t]||'';
  if(t==='materials') loadMaterials();
  if(t==='ideas') loadIdeasTab();
}
// ---- вкладки Публікації: Календар | План і ритм (layPlan фізично переїздить сюди при старті) ----
function setPTab(t){
  pTab=t; if(curView==='publish') writeRoute('publish',t);
  document.querySelectorAll('#pubTabs .tab').forEach(x=>x.classList.toggle('on',x.dataset.ptab===t));
  if($('pubCal')) $('pubCal').style.display=t==='cal'?'':'none';
  const host=$('pubPlanHost'); if(host) host.style.display=t==='plan'?'':'none';
  const lp=$('layPlan'); if(lp) lp.style.display=t==='plan'?'':'none';
  if(t==='plan'){ loadPlan(); try{ renderRhythm(); }catch(e){} try{ renderPlanNets(); }catch(e){} }
  // кнопки в липкій плашці різні для Календаря (🏦 Банк) і Плану (📋 Скелет, 📡 Ритм)
  try{ renderViewActions('publish'); }catch(e){}
}
document.querySelectorAll('#pubTabs .tab').forEach(x=>x.onclick=()=>setPTab(x.dataset.ptab));
// переселення панелі плану в хаб Публікації (обробники лишаються живими - вузол той самий)
(function(){ const host=$('pubPlanHost'), lp=$('layPlan'); if(host&&lp) host.appendChild(lp); })();
document.querySelectorAll('#cTabs .tab').forEach(x=>x.onclick=()=>setCTab(x.dataset.ctab));
function setLayout(l){
  curLayout=l;
  if(cTab!=='posts') setCTab('posts');
  const map={studio:'layStudio',pipeline:'layPipeline',inbox:'layInbox'};
  for(const k in map){ const el=$(map[k]); if(el) el.style.display = (k===l&&cTab==='posts')?'':'none'; }
  document.querySelectorAll('#layoutTabs .tab').forEach(t=>t.classList.toggle('on',t.dataset.lay===l));
}
function updateProUI(){
  const sl=$('segLite'), sp=$('segPro');
  if(sl&&sp){ sl.classList.toggle('on',!PRO); sp.classList.toggle('on',PRO); }
  if($('avProBadge')) $('avProBadge').style.display=PRO?'':'none';
  if($('umPro')) $('umPro').style.display=PRO?'':'none';
  document.querySelectorAll('.proonly').forEach(el=>el.style.display=PRO?'':'none');
  const lt=$('layoutTabs'); if(lt) lt.style.display='none'; // Конвеєр живе в аватар-меню «🧰 Інструменти», вкладки сховані назавжди
  if(!PRO && curLayout==='pipeline') setLayout('studio');
  if(cTab==='plan' && typeof loadPlan==='function') loadPlan(); // Lite↔PRO змінює канал скелета (all↔telegram) - перезавантажуємо
  // рілс-кнопки (🎬/🎞/▶️/📤) вшиті в розмітку карток - перерендер після перемикання режиму
  try{ if(typeof renderMaterials==='function') renderMaterials(); }catch(e){}
  try{ if(typeof renderStudio==='function') renderStudio(); }catch(e){}
}
// просте перемикання Lite/PRO (тарифи будуть поповненням токенів окремо)
async function setMode(pro){ try{ await saveSetting('pro',pro?'1':'0'); PRO=pro; updateProUI(); flash(pro?'Режим PRO - усі інструменти відкрито ⚡':'Режим Lite - тільки головне'); }catch(e){ flash('⚠ '+e.message); } }
if($('segLite')) $('segLite').onclick=()=>{ if(PRO) setMode(false); };
if($('segPro')) $('segPro').onclick=()=>{ if(!PRO) setMode(true); };
document.querySelectorAll('#layoutTabs .tab').forEach(t=>t.onclick=()=>setLayout(t.dataset.lay));
$('toStudio').onclick=()=>setLayout('studio');

// ---------- МАТЕРІАЛИ: стрічка сировини ----------
let Mats=[], MatFilter='Усі', MatFeedFilter=null, MatOpen=null, Ideas=[];
const MAT_TYPE={mcp:'🔌 З Claude',bot:'🤖 З бота',manual:'✍️ Нотатка',rss:'📡 RSS',fireflies:'🎙 Транскрипт',grain:'🎙 Транскрипт',meetgeek:'🎙 Транскрипт',gdrive:'📁 Drive',brand:'✨ Бренд',plan:'📅 План',idea:'💡 Ідея',diary:'📔 Щоденник',meeting:'🎤 Зустріч'};
async function loadMaterials(){ try{ const r=await api('/materials'); Mats=r.materials||[]; }catch(e){ Mats=[]; } try{ const ib=await api('/ideas'); Ideas=ib.ideas||[]; }catch(e){ Ideas=[]; } renderMaterials(); updateCounts(); }
function matType(m){ return MAT_TYPE[m.origin]||m.origin; }
function renderMaterials(){
  const feed=$('matFeed'); if(!feed) return;
  const types=['Усі',...new Set(Mats.map(matType))];
  const ft=$('matFilters'); if(ft){ let html=types.map(t=>{ const n=t==='Усі'?Mats.length:Mats.filter(m=>matType(m)===t).length; return '<div class="ftab'+(MatFilter===t?' on':'')+'" data-mf="'+esc(t)+'">'+esc(t)+' <span style="opacity:.6">'+n+'</span></div>'; }).join('');
    // (Банк ідей переїхав у власну вкладку «💡 Ідеї» - чіп звідси прибрано)
    // другий ряд: фільтр за КОНКРЕТНОЮ стрічкою («ця інста / ця тема новин / той телеграм»)
    const feeds={}; Mats.forEach(m=>{ if(m.feed_id&&!feeds[m.feed_id]) feeds[m.feed_id]=(typeof rssNiceUrl==='function'&&m.feed_url&&rssNiceUrl({url:m.feed_url})!==m.feed_url)?rssNiceUrl({url:m.feed_url}):(m.feed_title||'стрічка'); });
    if(Object.keys(feeds).length) html+='<div style="flex-basis:100%;height:0"></div>'+Object.entries(feeds).map(([id,t])=>{ const n=Mats.filter(m=>m.feed_id===id).length; const lbl=String(t).length>26?String(t).slice(0,24)+'…':t; return '<div class="ftab'+(MatFeedFilter===id?' on':'')+'" data-mff="'+id+'" title="'+esc(String(t))+'">'+esc(lbl)+' <span style="opacity:.6">'+n+'</span></div>'; }).join('');
    ft.style.flexWrap='wrap';
    ft.innerHTML=html;
    ft.querySelectorAll('[data-mf]').forEach(x=>x.onclick=()=>{ MatFilter=x.dataset.mf; MatFeedFilter=null; renderMaterials(); });
    ft.querySelectorAll('[data-mff]').forEach(x=>x.onclick=()=>{ MatFeedFilter=MatFeedFilter===x.dataset.mff?null:x.dataset.mff; renderMaterials(); }); }
  let show=MatFilter==='Усі'?Mats:Mats.filter(m=>matType(m)===MatFilter);
  if(MatFeedFilter) show=show.filter(m=>m.feed_id===MatFeedFilter);
  if(!show.length){ feed.innerHTML='<div class="empty" style="padding:20px">Порожньо. Додай матеріал кнопкою вище - або підключи RSS/транскрибатор у «Джерелах», нове зʼявиться тут само.</div>'; return; }
  feed.innerHTML=show.map(m=>{
    const open=MatOpen===m.id;
    const match=m.slot_id?'<span class="ptag" style="color:var(--amber);border-color:var(--amber)">🏷 підходить: '+esc(m.slot_rubric||'')+' · '+esc(String(m.slot_date||'').slice(5,10))+'</span>':'';
    const score=m.ai_score?'<span class="ptag" title="'+esc(m.ai_score_why||'AI-оцінка цікавості для твоєї аудиторії')+'" style="'+(m.ai_score>=8?'color:var(--brand);border-color:var(--brand);font-weight:700':(m.ai_score>=5?'color:var(--amber);border-color:var(--amber)':'color:var(--faint)'))+'">⭐ '+m.ai_score+'/10</span>':'';
    return '<div data-mat="'+m.id+'" style="padding:13px 18px;border-bottom:1px solid var(--line);background:'+(open?'var(--surface2)':'transparent')+'">'
      +'<div class="matHead" style="cursor:pointer">'
        +'<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="ptag">'+esc(matType(m))+'</span><b style="font-size:14px;flex:1;min-width:180px">'+esc(m.title||'Без назви')+'</b>'+score+match+'<span style="font-size:11.5px;color:var(--faint)">'+new Date(m.created_at).toLocaleDateString('uk')+' · '+(m.chars||0)+' симв.</span></div>'
        +'<div style="font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'+esc(m.preview||'')+'</div>'
      +'</div>'
      +(open?'<div id="matFull" style="margin-top:10px;background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:12px 14px;font-size:13px;line-height:1.6;color:var(--ink2);white-space:pre-wrap;max-height:300px;overflow:auto"><span class="spin"></span></div>'
        +'<div class="btnrow" style="margin-top:10px;flex-wrap:wrap"><button class="primary" data-ma="post">✨ Створити пост</button><button class="ghost" data-ma="series">⚡ Серія (~6 постів)</button><button class="ghost" data-ma="ideas">💡 Витягнути ідеї</button>'+(PRO?'<button class="ghost" data-ma="reels">🎬 Сценарій Reels</button>':'')+(PRO&&(m.chars||0)>800?'<button class="ghost" data-ma="slices" title="Довгий матеріал → 5-7 самостійних сценаріїв Reels, тиждень відео-контенту">🎞 Нарізка на рілси</button>':'')+'<button class="ghost" data-ma="del" style="margin-left:auto;color:var(--danger)">🗑 Прибрати</button></div>':'')
      +'</div>';
  }).join('');
  feed.querySelectorAll('[data-mat]').forEach(row=>{
    const id=row.dataset.mat;
    row.querySelector('.matHead').onclick=async()=>{ MatOpen=MatOpen===id?null:id; renderMaterials(); if(MatOpen===id){ try{ const f=await api('/materials/'+id); const el=$('matFull'); if(el) el.textContent=f.transcript||''; }catch(e){} } };
    row.querySelectorAll('[data-ma]').forEach(b=>b.onclick=async(ev)=>{ ev.stopPropagation(); const a=b.dataset.ma;
      if(a==='del'){ if(!confirm('Прибрати матеріал зі стрічки?')) return; try{ await api('/materials/'+id+'/archive',{method:'POST'}); await loadMaterials(); }catch(e){ flash('⚠ '+e.message); } return; }
      if(a==='post'){ aiBusy('✨ Створюю пост з матеріалу…'); setCTab('posts'); setLayout('studio');
        try{ await api('/materials/'+id+'/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}); await loadStudioPosts(); flash('Готово - пост у стрічці ✓'); }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } return; }
      if(a==='series'){ if(!confirm('Нарізати матеріал на серію з ~6 постів? Кожен - окремий тейк зі своїм кутом і гачком.')) return;
        aiBusy('⚡ Нарізаю матеріал на серію постів…'); setCTab('posts'); setLayout('studio');
        try{ const r=await api('/materials/'+id+'/series',{method:'POST'}); await loadStudioPosts(); flash('Серія готова - '+(r.count||0)+' постів у Чорновиках ✓'); }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } return; }
      if(a==='reels'){ const sec=await askReelLen('🎬 Сценарій Reels'); if(!sec) return;
        aiBusy('🎬 Пишу сценарій Reels з матеріалу…'); setCTab('posts'); setLayout('studio');
        try{ await api('/materials/'+id+'/reels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetSec:sec})}); await loadStudioPosts(); flash('Сценарій Reels у Чорновиках ✓'); }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } return; }
      if(a==='slices'){ const sec=await askReelLen('🎞 Нарізка на 5-7 рілсів'); if(!sec) return;
        aiBusy('🎞 Нарізаю на сценарії Reels (порядок на тиждень)…'); setCTab('posts'); setLayout('studio');
        try{ const r=await api('/materials/'+id+'/reel-slices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetSec:sec})}); await loadStudioPosts(); flash('Нарізка готова - '+(r.count||0)+' сценаріїв 🎬 у Чорновиках, у порядку на тиждень ✓'); }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } return; }
      if(a==='ideas'){ openMaterialIdeas(id); }
    });
  });
}
// Відкрити конкретний матеріал за адресою `#/material/<id>` (лінк «🌐 Перейти» з бота).
// Стрічка може бути ще не завантажена (перехід із зовнішнього посилання одразу після старту),
// тому спершу тягнемо матеріали, і лише тоді розгортаємо потрібний.
async function openMaterialDeep(id){
  selectView('create','materials');
  MatFilter='Усі'; MatFeedFilter=null; MatOpen=id;
  if(!Mats.length){ try{ await loadMaterials(); }catch(e){} }
  MatOpen=id; renderMaterials();
  const row=document.querySelector('[data-mat="'+id+'"]');
  if(!row){ flash('Матеріал не знайдено - можливо, його прибрали зі стрічки'); return; }
  row.scrollIntoView({behavior:'smooth',block:'center'});
  row.classList.add('thl'); setTimeout(()=>row.classList.remove('thl'),2200);
  try{ const f=await api('/materials/'+id); const el=$('matFull'); if(el) el.textContent=f.transcript||''; }catch(e){}
}
// вкладка «💡 Ідеї» (Створення): банк ідей окремою адресою - з бота, AI-продовжень і власних
async function loadIdeasTab(){
  const feed=$('ideaBankFeed'); if(!feed) return;
  try{ const ib=await api('/ideas'); Ideas=ib.ideas||[]; }catch(e){ Ideas=[]; }
  const cnt=$('ideaTabCount'); if(cnt) cnt.textContent=Ideas.length||'';
  renderIdeaBank(feed);
}
async function refreshIdeaViews(){ await loadMaterials(); if(cTab==='ideas') await loadIdeasTab(); }
function bindIbAdd(){ const b=$('ibAdd'); if(b) b.onclick=async()=>{ const t=prompt('Нова ідея (1 рядок):'); if(!t||!t.trim()) return; try{ await api('/ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t.trim()})}); await refreshIdeaViews(); }catch(e){ flash('⚠ '+e.message); } }; }
function renderIdeaBank(feed){
  const addBtn='<div style="padding:12px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px"><span style="font-size:12.5px;color:var(--muted)">Готові концепти постів. Витягуються в Telegram-боті командою /idea.</span><button class="ghost" id="ibAdd" style="margin-left:auto">＋ Додати ідею</button></div>';
  if(!Ideas.length){ feed.innerHTML=addBtn+'<div class="empty" style="padding:20px">Банк порожній. Додай ідею вручну - або вони зʼявляться сюди з Telegram-бота.</div>'; bindIbAdd(); return; }
  feed.innerHTML=addBtn+Ideas.map(it=>{
    const tag=(s,c)=>'<span class="ptag"'+(c?' style="color:'+c+';border-color:'+c+'"':'')+'>'+s+'</span>';
    const meta=(it.rubric?tag('🏷 '+esc(it.rubric)):'')+(it.origin==='bot'?tag('🤖 з Telegram','var(--tg)'):'')+(it.origin==='ai'?tag('✨ AI'):'');
    return '<div data-idea="'+it.id+'" style="padding:13px 18px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">'
      +'<div style="flex:1;min-width:180px;font-size:14px;line-height:1.5">'+esc(it.text||'')+(meta?' '+meta:'')+'</div>'
      +'<div class="btnrow" style="margin:0"><button class="primary" data-ia="post">✨ Пост</button><button class="ghost" data-ia="del" style="color:var(--danger)">🗑</button></div>'
      +'</div>';
  }).join('');
  bindIbAdd();
  feed.querySelectorAll('[data-idea]').forEach(row=>{ const id=row.dataset.idea;
    row.querySelectorAll('[data-ia]').forEach(b=>b.onclick=async()=>{ const a=b.dataset.ia;
      if(a==='del'){ try{ await api('/ideas/'+id+'/archive',{method:'POST'}); await refreshIdeaViews(); }catch(e){ flash('⚠ '+e.message); } return; }
      if(a==='post'){ aiBusy('✨ Створюю пост з ідеї…'); setCTab('posts'); setLayout('studio');
        try{ await api('/ideas/'+id+'/post',{method:'POST'}); await loadStudioPosts(); await refreshIdeaViews(); flash('Готово - пост у Чорновиках ✓'); }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } return; }
    });
  });
}
function openAddMaterial(){
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  const card=document.createElement('div'); card.className='modal-card'; card.style.cssText='max-width:560px;padding:20px';
  ov.appendChild(card); document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  let mode='topic', topicCount=3, topicText=''; // текст живе поза render(): перемикання «3»→«5» перемальовує картку, і без цього набране зникало
  function render(){
    card.innerHTML='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><b style="font-size:16px">＋ Додати контент</b><button class="icon" id="amX" style="margin-left:auto">✕</button></div>'
      +'<div class="tabs" style="margin-bottom:14px"><div class="tab'+(mode==='topic'?' on':'')+'" data-m="topic">✍️ Написати про тему</div><div class="tab'+(mode==='material'?' on':'')+'" data-m="material">📥 Додати матеріал</div></div>'
      +(mode==='topic'
        ? '<div class="hint" style="margin-bottom:8px">Задай напрям - про що саме зробити пост(и). Ми напишемо у голосі бренду. Це вирішує «AI пише не про те».</div>'
          +'<textarea class="txt" id="amTopic" rows="4" placeholder="Напр.: чому наш новий тариф вигідніший; помилка, яку роблять новачки в холодних дзвінках; кейс клієнта, що виріс на 25%…">'+esc(topicText)+'</textarea>'
          +'<div style="font-size:12.5px;font-weight:600;color:var(--ink2);margin:14px 0 7px">Скільки постів</div>'
          +'<div style="display:flex;gap:6px" id="amCountChips">'+[1,3,5].map(n=>'<div class="cchip'+(n===topicCount?' on':'')+'" data-n="'+n+'">'+n+'</div>').join('')+'</div>'
          +'<div class="btnrow" style="margin-top:18px"><button class="primary" id="amGen" style="width:100%">✨ Зробити пост(и) про це</button></div>'
        : '<div class="hint" style="margin-bottom:8px">Встав сировину (транскрипт/статтю/нотатку) - вона ляже у стрічку Матеріалів, з неї витягнеш ідеї.</div>'
          +'<input class="txt" id="amTitle" placeholder="Назва (необовʼязково)" style="margin-bottom:8px">'
          +'<textarea class="txt" id="amText" rows="7" placeholder="Встав транскрипт, статтю, нотатку чи просто думку…"></textarea>'
          +'<div class="btnrow" style="margin-top:12px"><button class="primary" id="amSave" style="width:100%">Додати у стрічку</button></div>');
    card.querySelector('#amX').onclick=close;
    card.querySelectorAll('[data-m]').forEach(t=>t.onclick=()=>{ mode=t.dataset.m; render(); });
    if(mode==='topic'){
      card.querySelector('#amTopic').addEventListener('input',e=>{ topicText=e.target.value; });
      card.querySelectorAll('#amCountChips [data-n]').forEach(c=>c.onclick=()=>{ topicCount=+c.dataset.n; render(); });
      card.querySelector('#amGen').onclick=async()=>{ const topic=card.querySelector('#amTopic').value.trim(); if(!topic){ flash('Напиши, про що зробити пост'); return; }
        close(); aiBusy('✨ Пишу '+topicCount+' пост(и) про: «'+topic.slice(0,50)+'»…'); selectView('create'); setCTab('posts'); setLayout('studio');
        try{ const r=await api('/generate/topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,count:topicCount})}); await loadStudioPosts(); flash('Готово - '+(r.count||0)+' пост(ів) ✓'); }
        catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } };
    } else {
      card.querySelector('#amSave').onclick=async()=>{ const text=card.querySelector('#amText').value.trim(); if(!text){ flash('Встав текст'); return; }
        const title=card.querySelector('#amTitle').value.trim();
        try{ await api('/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:text,title:title||undefined})}); close(); await loadMaterials(); try{ await api('/plan/match',{method:'POST'}); await loadMaterials(); }catch(_){} flash('Матеріал додано ✓'); }
        catch(e){ flash('⚠ '+e.message); } };
    }
  }
  render();
}
if($('addMaterialBtn')) $('addMaterialBtn').onclick=openAddMaterial;
// модалка «Ідеї з матеріалу»: КРОК 1 налаштування генерації -> КРОК 2 обери ідеї -> чернетки постів
async function openMaterialIdeas(matId){
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  const card=document.createElement('div'); card.className='modal-card'; card.style.cssText='max-width:560px;padding:20px';
  ov.appendChild(card); document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  // ---- КРОК 1: Налаштування генерації (кількість + рубрики) ----
  let miCount=6; const miRubs=new Set((Rubrics||[]).map(r=>r.name));
  function renderSettings(){
    card.innerHTML='<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><b style="font-size:16px">⚙️ Налаштування генерації</b><button class="icon" id="miX" style="margin-left:auto">✕</button></div>'
      +'<div style="font-size:12.5px;font-weight:600;color:var(--ink2);margin-bottom:8px">Скільки ідей</div>'
      +'<div style="display:flex;gap:6px" id="miCountChips">'+[3,6,9,12].map(n=>'<div class="cchip'+(n===miCount?' on':'')+'" data-n="'+n+'">'+n+'</div>').join('')+'</div>'
      +((Rubrics&&Rubrics.length)?('<div style="font-size:12.5px;font-weight:600;color:var(--ink2);margin:16px 0 8px">Рубрики в міксі</div>'
        +'<div style="display:flex;flex-wrap:wrap;gap:6px" id="miRubChips">'+Rubrics.map(r=>'<label class="rchip on"><input type="checkbox" class="miRub" value="'+esc(r.name)+'" checked> '+(r.emoji||'')+' '+esc(r.name)+'</label>').join('')+'</div>'):'')
      +'<div class="btnrow" style="margin-top:18px"><button class="primary" id="miNext" style="width:100%">💡 Витягнути ідеї →</button></div>';
    card.querySelector('#miX').onclick=close;
    card.querySelectorAll('#miCountChips [data-n]').forEach(c=>c.onclick=()=>{ miCount=+c.dataset.n; renderSettings(); });
    card.querySelectorAll('.miRub').forEach(cb=>cb.addEventListener('change',()=>{ cb.checked?miRubs.add(cb.value):miRubs.delete(cb.value); cb.closest('.rchip').classList.toggle('on',cb.checked); }));
    card.querySelector('#miNext').onclick=()=>loadIdeas();
  }
  renderSettings();
  // ---- КРОК 2: список ідей ----
  async function loadIdeas(){
  card.innerHTML='<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">💡 Ідеї з матеріалу</b><button class="icon" id="miX" style="margin-left:auto">✕</button></div>'
    +'<div id="miList"><div class="empty"><span class="spin"></span> AI шукає ідеї…</div></div>'
    +'<div class="btnrow" style="margin-top:12px"><button class="ghost" id="miBack">← Налаштування</button><button class="primary" id="miGo" disabled>✨ Створити пости з обраних</button></div>';
  card.querySelector('#miX').onclick=close; card.querySelector('#miBack').onclick=renderSettings;
  aiBusy('💡 Витягую ідеї з матеріалу…');
  let ideas=[];
  try{ const r=await api('/materials/'+matId+'/ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:miCount,rubrics:[...miRubs]})}); ideas=r.ideas||[]; }
  catch(e){ const l=card.querySelector('#miList'); if(l) l.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
  finally{ aiDone(); }
  const list=card.querySelector('#miList'); if(!list) return;
  if(ideas.length){
    list.innerHTML=ideas.map((it,i)=>'<label class="rchip on" style="display:flex;gap:8px;align-items:flex-start;width:100%;padding:9px 12px;margin-bottom:5px;text-align:left;font-weight:500;line-height:1.4"><input type="checkbox" class="miCb" data-i="'+i+'" checked><span style="flex:1">'+esc(it.idea)
      +(it.hook?'<span style="display:block;font-size:12px;color:var(--muted);font-weight:400;margin-top:3px">🪝 '+esc(it.hook)+'</span>':'')+'</span>'
      +((it.angle||it.rubric||it.format)?'<span style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">'+(it.rubric?'<span class="ptag">🏷 '+esc(it.rubric)+'</span>':'')+(it.angle?'<span class="ptag">🎯 '+esc(it.angle)+'</span>':'')+(it.format?'<span class="ptag">'+(it.format==='рілс'?'🎬':(it.format==='карусель'?'🖼':'📝'))+' '+esc(it.format)+'</span>':'')+'</span>':'')+'</label>').join('');
    list.querySelectorAll('.rchip').forEach(l=>{ const cb=l.querySelector('input'); cb.addEventListener('change',()=>l.classList.toggle('on',cb.checked)); });
    const go=card.querySelector('#miGo'); go.disabled=false;
    go.onclick=async()=>{ const sel=[...list.querySelectorAll('.miCb:checked')].map(c=>ideas[+c.dataset.i]);
      const picked=sel.map(it=>it.idea+(it.angle?' Кут: '+it.angle+'.':'')+(it.hook?' Гачок: '+it.hook:''));
      // формат, який Розвідник уже порадив (раніше він показувався бейджем і губився) - їде разом з ідеєю
      const formats=sel.map(it=>it.fmt||'post');
      if(!picked.length){ flash('Обери хоча б одну ідею'); return; }
      close(); aiBusy('✨ Створюю '+picked.length+' постів з ідей…'); setCTab('posts'); setLayout('studio');
      try{ const r=await api('/materials/'+matId+'/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ideas:picked,formats})}); await loadStudioPosts(); flash('Готово - '+(r.count||0)+' постів ✓'); }
      catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } };
  } else if(!list.textContent.includes('⚠')) list.innerHTML='<div class="empty">Ідей не знайшлось - спробуй «Створити пост» напряму.</div>';
  }
}

// ---------- ПЛАН: скелет ----------
let PlanSlots=[], PlanAll=[], PlanChan='__all', PlanChans=[];
const CP_LBL={telegram:'Telegram',instagram:'Instagram',threads:'Threads',facebook:'Facebook',linkedin:'LinkedIn',all:'Спільний'};
const CP_ICON={telegram:'✈️',instagram:'📸',threads:'🧵',facebook:'📘',linkedin:'💼',all:'📋'};
const SLOT_ST={empty:['⬜ порожньо','var(--faint)','var(--surface2)'],matched:['📎 є матеріал','var(--amber)','var(--amber-soft, #f7ecd8)'],drafted:['✍️ пост','var(--tg)','var(--surface2)'],approved:['✅ затверджено','var(--brand)','var(--brand-soft)'],scheduled:['🗓 у календарі','var(--brand)','var(--brand-soft)'],published:['✈️ вийшло','var(--muted)','var(--surface2)']};
function planSyncMode(){
  // вкладки за РЕАЛЬНИМИ мережами плану (не за PRO). Кілька мереж → вкладка «Усі» + по вкладці на мережу.
  const tabs=$('planChanTabs');
  const perNet=PlanChans.filter(c=>c&&c!=='all');
  if(!tabs) return;
  if(perNet.length<=1 && !(perNet.length===1&&PlanChans.includes('all'))){ // одна модель - без вкладок
    PlanChan='__all'; tabs.style.display='none'; return;
  }
  const opts=['__all'].concat(PlanChans.slice().sort());
  if(!opts.includes(PlanChan)) PlanChan='__all';
  tabs.style.display='';
  tabs.innerHTML=opts.map(c=>{ const cnt=c==='__all'?PlanAll.length:PlanAll.filter(s=>s.channel===c).length;
    return '<div class="tab'+(PlanChan===c?' on':'')+'" data-pc="'+c+'">'+(c==='__all'?'Усі':((CP_ICON[c]||'')+' '+(CP_LBL[c]||c)))+' <span style="opacity:.6">'+cnt+'</span></div>'; }).join('');
  tabs.querySelectorAll('[data-pc]').forEach(t=>t.onclick=()=>{ PlanChan=t.dataset.pc; applyPlanFilter(); });
}
function applyPlanFilter(){
  planSyncMode();
  PlanSlots = PlanChan==='__all' ? PlanAll : PlanAll.filter(s=>s.channel===PlanChan);
  renderPlan(); updateCounts();
}
// 🔬 розширений режим «окремий план на мережу» (дефолт ВИМКНЕНО - стандарт CORE: один майстер-план
// з адаптацією при публікації). Чекбокси мереж показуються лише в розширеному режимі.
async function renderPlanNets(){
  const box=$('planNets'); if(!box) return;
  if(!Object.keys(ChanStatus||{}).length){ try{ await loadChanStatus(); }catch(e){} }
  const conn=NETS.filter(n=>ChanStatus[n[0]]);
  const list=conn.length?conn:NETS; // якщо нічого не підключено - показуємо всі (план можна будувати наперед)
  box.innerHTML=list.map(n=>'<label class="rchip'+(ChanStatus[n[0]]?' on':'')+'" style="font-size:12.5px"><input type="checkbox" class="planNet" value="'+n[0]+'"'+(ChanStatus[n[0]]?' checked':'')+'> '+(CP_ICON[n[0]]||'')+' '+esc(n[1])+'</label>').join('')
    +(conn.length?'':'<div style="font-size:11.5px;color:var(--faint);width:100%;margin-top:4px">Підключи мережі в Налаштування → Канали, щоб націлити план точніше.</div>');
  box.querySelectorAll('.planNet').forEach(cb=>cb.addEventListener('change',()=>{ cb.closest('.rchip').classList.toggle('on',cb.checked); updPlanEst(); }));
  const adv=$('planAdv');
  if(adv&&!adv._wired){ adv._wired=true; adv.checked=localStorage.getItem('kg_plan_adv')==='1';
    adv.addEventListener('change',()=>{ localStorage.setItem('kg_plan_adv',adv.checked?'1':'0'); box.style.display=adv.checked?'flex':'none'; updPlanEst(); }); }
  box.style.display=(adv&&adv.checked)?'flex':'none';
  renderPlanMix();
}
// ✨ чорнові болі клієнта з брифу (в textarea, юзер редагує; автосейв спрацює через SET)
if($('painsSuggest')) $('painsSuggest').onclick=async()=>{
  const ta=$('painPoints'), m=$('painsMsg');
  if(ta.value.trim() && !confirm('Поточний список болів буде замінено чорновиком від AI. Продовжити?')) return;
  m.textContent='думаю…'; $('painsSuggest').disabled=true;
  try{ const r=await api('/brand/suggest-pains',{method:'POST'}); ta.value=r.pains||''; ta.dispatchEvent(new Event('input')); m.textContent='готово ✓ відредагуй під себе (особливо [доказ?])'; }
  catch(e){ m.textContent='⚠ '+e.message; } finally{ $('painsSuggest').disabled=false; }
};

// 📊 видима пропорція рубрик (частки зі Стратегії): план явно будується за цим міксом
function renderPlanMix(){
  const wrap=$('planMixWrap'), bar=$('planMixBar'), leg=$('planMixLegend'); if(!wrap||!bar) return;
  const rubs=(Rubrics||[]).filter(r=>r.name);
  if(!rubs.length){ wrap.style.display='none'; return; }
  const total=rubs.reduce((s,r)=>s+(+r.share||0),0)||rubs.length*25;
  const COLORS=['var(--brand)','var(--tg)','var(--amber)','var(--th, #999)','#8e6bbf','#5a9e6f'];
  wrap.style.display='';
  bar.innerHTML=rubs.map((r,i)=>{ const pct=Math.round(((+r.share||25)/total)*100); return '<div style="width:'+pct+'%;background:'+COLORS[i%COLORS.length]+';opacity:.8" title="'+esc(r.name)+' '+pct+'%"></div>'; }).join('');
  leg.innerHTML=rubs.map((r,i)=>{ const pct=Math.round(((+r.share||25)/total)*100); return '<span><span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:'+COLORS[i%COLORS.length]+';margin-right:3px"></span>'+(r.emoji||'')+esc(r.name)+' '+pct+'%</span>'; }).join('');
}
async function loadPlan(){
  try{ const r=await api('/plan'); PlanAll=r.slots||[]; PlanChans=[...new Set(PlanAll.map(s=>s.channel).filter(Boolean))]; renderFmtFact(r.realizedMix||{}); }
  catch(e){ PlanAll=[]; PlanChans=[]; }
  applyPlanFilter();
  // хаб Публікації: лічильник тем біля календаря + перерендер привидів-тем
  try{ const cs=$('calSum'); if(cs){ const th=PlanAll.filter(s=>['empty','matched','drafted'].includes(s.status)).length; cs.textContent=th?('· у плані '+th+' тем'):''; }
    if($('cal')&&$('cal').childNodes.length) renderCal(); }catch(e){}
}
// 🎨 ФАКТИЧНИЙ мікс форматів за 30 днів. Цього не показує жоден конкурент (у Buffer/Later формат
// живе або лише в аналітиці, або в ручних тегах), а дані в нас уже є - тож видно, чи реальний
// контент відповідає задуманому міксу, чи «збиралися робити каруселі», а вийшли самі пости.
function renderFmtFact(mix){
  const box=$('fmtFact'); if(!box) return;
  const total=Object.values(mix).reduce((a,b)=>a+(+b||0),0);
  if(!total){ box.style.display='none'; return; }
  const keys=FMT_KEYS.filter(k=>mix[k]);
  if(keys.length<2){ box.style.display='none'; return; } // один формат - нема що порівнювати
  const COL={post:'var(--muted)',carousel:'var(--brand)',reel:'var(--ig)',story:'var(--amber)'};
  box.style.display='';
  box.innerHTML='<div style="font-size:11.5px;color:var(--muted);margin-bottom:4px">Фактично за 30 днів <span class="qh" title="Скільки чернеток кожного формату реально створено за останній місяць - щоб було видно, чи контент справді виходить таким, як задумано в міксі форматів.">?</span></div>'
    +'<div style="display:flex;height:10px;border-radius:6px;overflow:hidden;border:1px solid var(--line)">'
    +keys.map(k=>'<div style="width:'+Math.round(mix[k]/total*100)+'%;background:'+COL[k]+'" title="'+esc(FMT_META[k][1])+': '+mix[k]+'"></div>').join('')+'</div>'
    +'<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;font-size:11px;color:var(--muted)">'
    +keys.map(k=>'<span>'+FMT_META[k][0]+' '+esc(FMT_META[k][1])+' '+Math.round(mix[k]/total*100)+'%</span>').join('')+'</div>';
}
// ---- 📡 Ритм каналів (спадкування «як у бренду» / свій ритм: дні, час, рубрики) ----
const DAY_LBL=[['1','пн'],['2','вт'],['3','ср'],['4','чт'],['5','пт'],['6','сб'],['0','нд']];
async function renderRhythm(){
  const box=$('rhythmRows'); if(!box) return;
  if(!Object.keys(ChanStatus||{}).length){ try{ await loadChanStatus(); }catch(e){} }
  let rh={}; try{ const rows=await api('/settings'); const m=Object.fromEntries(rows.map(r=>[r.key,r.content])); rh=JSON.parse(m.channel_rhythm||'{}')||{}; }catch(e){ rh={}; }
  const nets=NETS.filter(n=>ChanStatus[n[0]]);
  if(!nets.length){ box.innerHTML='<div style="font-size:12.5px;color:var(--faint)">Спершу підключи мережі в Налаштування → Канали.</div>'; return; }
  // компактні рядки; кілька часів на мережу (Threads 2-3 рази/день): часи ротуються між постами
  box.innerHTML=nets.map(n=>{ const k=n[0], r=rh[k]||null, custom=!!r;
    const times=(r&&(Array.isArray(r.times)?r.times:(r.time?[r.time]:[])))||[];
    return '<div style="padding:7px 0;border-bottom:1px solid var(--line)" data-net="'+k+'">'
      +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        +'<span style="font-size:12.5px;font-weight:700;min-width:80px">'+esc(n[1])+'</span>'
        +'<select class="rhMode txt" style="width:auto;padding:4px 7px;font-size:11.5px"><option value="inherit"'+(custom?'':' selected')+'>як у бренду</option><option value="custom"'+(custom?' selected':'')+'>свій ритм</option></select>'
        +'<span class="rhCustom" style="display:'+(custom?'flex':'none')+';gap:6px;align-items:center;flex-wrap:wrap">'
          +'<span style="display:flex;gap:2px">'+DAY_LBL.map(d=>'<button class="rhDay" data-d="'+d[0]+'" style="padding:2px 6px;font-size:11px;border-radius:6px;border:1px solid var(--line);background:'+((r&&r.days||[]).includes(+d[0])?'var(--brand-soft)':'transparent')+';color:'+((r&&r.days||[]).includes(+d[0])?'var(--brand)':'var(--muted)')+';cursor:pointer">'+d[1]+'</button>').join('')+'</span>'
          +'<span class="rhTimes" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">'
            +(times.length?times:['']).map(t=>'<input class="rhTime txt" type="time" value="'+esc(t)+'" style="width:auto;padding:3px 6px;font-size:11.5px" title="час публікації (порожній - час бренду)">').join('')
            +'<button class="rhAddTime icon" title="Ще один час на день (пости ротуються між часами)" style="width:24px;height:24px;font-size:13px">＋</button>'
          +'</span>'
          +'<input class="rhRub txt" placeholder="рубрики через кому" value="'+esc(((r&&r.rubrics)||[]).join(', '))+'" style="width:150px;padding:3px 7px;font-size:11.5px" title="ця мережа братиме лише ці рубрики (порожньо = всі)">'
        +'</span>'
      // 🎨 мікс форматів саме ПО МЕРЕЖАХ: той самий формат у різних мережах працює по-різному
      // (LinkedIn виграє каруселями-документами, IG - рілсами по охвату). Дефолт - лише пости,
      // тож поки юзер нічого не обрав, поведінка плану не змінюється.
      +'<div class="rhFmts" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:5px;padding-left:2px">'
        +'<span style="font-size:11px;color:var(--faint);min-width:74px">формати:</span>'
        +FMT_KEYS.map(k=>{ const row=((r&&r.formats)||[]).find(x=>(x&&x.f)===k); const on=!!row;
          return '<label class="rhFmt" data-f="'+k+'" style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer" title="'+FMT_META[k][2]+'">'
            +'<input type="checkbox" class="rhFmtOn"'+(on?' checked':'')+'> '+FMT_META[k][0]+' '+esc(FMT_META[k][1])
            +'<input type="number" class="rhFmtShare txt" min="0" max="100" value="'+(on?(Number(row.share)||25):25)+'" style="width:44px;padding:2px 4px;font-size:11px;display:'+(on?'inline-block':'none')+'" title="приблизна частка слотів, %"><span class="rhFmtPct" style="display:'+(on?'inline':'none')+';color:var(--faint)">%</span></label>'; }).join('')
      +'</div>'
      +'</div>'; }).join('')
    +'<div style="font-size:11px;color:var(--faint);margin-top:7px">Застосовується при «AI-розподілі» та автопублікації з плану. Кілька часів = кілька постів на день у цій мережі. Формати: нічого не обрано - усі слоти цієї мережі будуть звичайними постами; частки - орієнтир пропорції, не точна математика.</div>';
  const save=async()=>{ const out={};
    box.querySelectorAll('[data-net]').forEach(row=>{ if(row.querySelector('.rhMode').value!=='custom') return;
      const days=[...row.querySelectorAll('.rhDay')].filter(b=>b.dataset.on==='1').map(b=>+b.dataset.d);
      const times=[...row.querySelectorAll('.rhTime')].map(i=>i.value).filter(Boolean);
      const rubrics=row.querySelector('.rhRub').value.split(',').map(s=>s.trim()).filter(Boolean);
      const formats=[...row.querySelectorAll('.rhFmt')].filter(l=>l.querySelector('.rhFmtOn').checked)
        .map(l=>({f:l.dataset.f, share:Math.max(0,Math.min(100,+l.querySelector('.rhFmtShare').value||25))}));
      out[row.dataset.net]={...(days.length?{days}:{}),...(times.length?{times}:{}),...(rubrics.length?{rubrics}:{}),...(formats.length?{formats}:{})}; });
    try{ await saveSetting('channel_rhythm', JSON.stringify(out)); }catch(e){} };
  box.querySelectorAll('[data-net]').forEach(row=>{
    row.querySelectorAll('.rhDay').forEach(b=>{ const r=rh[row.dataset.net]; b.dataset.on=((r&&r.days)||[]).includes(+b.dataset.d)?'1':'0';
      b.onclick=()=>{ const on=b.dataset.on!=='1'; b.dataset.on=on?'1':'0'; b.style.background=on?'var(--brand-soft)':'transparent'; b.style.color=on?'var(--brand)':'var(--muted)'; save(); }; });
    row.querySelector('.rhMode').onchange=(e)=>{ row.querySelector('.rhCustom').style.display=e.target.value==='custom'?'flex':'none'; save(); };
    row.querySelectorAll('.rhTime').forEach(i=>i.onchange=save);
    row.querySelector('.rhAddTime').onclick=()=>{ const wrap=row.querySelector('.rhTimes'); const inp=document.createElement('input');
      inp.className='rhTime txt'; inp.type='time'; inp.style.cssText='width:auto;padding:3px 6px;font-size:11.5px'; inp.onchange=save;
      wrap.insertBefore(inp, row.querySelector('.rhAddTime')); inp.focus(); };
    row.querySelector('.rhRub').addEventListener('input',()=>{ clearTimeout(row._t); row._t=setTimeout(save,700); });
    row.querySelectorAll('.rhFmt').forEach(l=>{ const cb=l.querySelector('.rhFmtOn'), sh=l.querySelector('.rhFmtShare'), pct=l.querySelector('.rhFmtPct');
      cb.onchange=()=>{ sh.style.display=cb.checked?'inline-block':'none'; pct.style.display=cb.checked?'inline':'none'; save(); };
      sh.addEventListener('input',()=>{ clearTimeout(l._t); l._t=setTimeout(save,700); }); });
  });
}
function renderPlan(){
  const list=$('planList'); if(!list) return;
  const filled=PlanSlots.filter(s=>s.status!=='empty').length;
  if($('planProgressLabel')) $('planProgressLabel').textContent=PlanSlots.length?('Скелет · заповнено '+filled+' з '+PlanSlots.length):'Скелет плану';
  if($('planProgressBar')) $('planProgressBar').style.width=PlanSlots.length?Math.round(filled/PlanSlots.length*100)+'%':'0%';
  if(!PlanSlots.length){ list.innerHTML='<div class="empty" style="padding:20px">Скелета ще нема - натисни «Згенерувати скелет» (спершу потрібна стратегія: розділ Стратегія → Згенерувати).</div>'; return; }
  const DOW=['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
  list.innerHTML=PlanSlots.map(s=>{
    const st=SLOT_ST[s.status]||SLOT_ST.empty;
    const d=new Date(String(s.slot_date).slice(0,10)+'T12:00:00Z');
    const day=DOW[d.getUTCDay()]+' '+String(d.getUTCDate()).padStart(2,'0')+'.'+String(d.getUTCMonth()+1).padStart(2,'0');
    let act='';
    if(s.status==='empty') act='<button class="ghost" data-pa="theme">Згенерувати з теми</button>';
    if(s.status==='matched') act='<button class="primary" data-pa="material">✨ З матеріалу</button><button class="ghost" data-pa="theme">З теми</button>';
    if(s.status==='drafted') act='<button class="ghost" data-pa="topost">→ до чорновика</button>';
    if(s.status==='approved'||s.status==='scheduled') act='<button class="ghost" data-pa="tocal">→ календар</button>';
    return '<div data-slot="'+s.id+'" style="display:flex;align-items:center;gap:11px;padding:12px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap">'
      +'<span style="font-size:12px;font-weight:700;color:var(--ink2);background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:5px 10px;min-width:82px;text-align:center;flex:none">'+day+'</span>'
      +(s.rubric?'<span class="ptag" style="color:var(--brand);border-color:var(--brand)">🏷 '+esc(s.rubric)+'</span>':'')
      +((s.format&&s.format!=='post'&&FMT_META[s.format])?'<span class="ptag" title="Формат: '+FMT_META[s.format][2]+'">'+FMT_META[s.format][0]+' '+esc(FMT_META[s.format][1].toLowerCase())+'</span>':'')
      +((s.channel&&s.channel!=='all')?'<span class="ptag">'+(CP_ICON[s.channel]||'')+' '+esc(CP_LBL[s.channel]||s.channel)+'</span>':'')
      +'<div style="flex:1;min-width:200px"><div style="font-size:13.5px;font-weight:600;line-height:1.35">'+esc(s.theme||'')+'</div>'
        +(s.match_note?'<div style="font-size:11.5px;color:var(--amber);margin-top:2px">📎 '+esc(s.match_note)+'</div>':'')+'</div>'
      +'<span style="flex:none;font-size:11.5px;font-weight:700;color:'+st[1]+';background:'+st[2]+';padding:5px 11px;border-radius:20px">'+st[0]+'</span>'
      +(act?'<span class="btnrow" style="margin:0;flex:none">'+act+'</span>':'')
      +'</div>';
  }).join('');
  list.querySelectorAll('[data-slot]').forEach(row=>{
    const id=row.dataset.slot; const slot=PlanSlots.find(x=>x.id===id);
    row.querySelectorAll('[data-pa]').forEach(b=>b.onclick=async()=>{ const a=b.dataset.pa;
      if(a==='topost'){ setCTab('posts'); setLayout('studio'); return; }
      if(a==='tocal'){ go('publish'); return; }
      const from=a==='material'?'material':'theme';
      aiBusy('✨ Генерую пост: «'+((slot&&slot.theme)?slot.theme.slice(0,60):'')+'»…');
      try{ await api('/plan/slots/'+id+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from})}); await loadPlan(); setCTab('posts'); setLayout('studio'); await loadStudioPosts(); flash('Пост створено і привʼязано до слота ✓'); }
      catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); }
    });
  });
}
// мережі для генерації: ЛИШЕ в розширеному режимі; дефолт [] = один майстер-план (CORE)
function planSelectedNets(){ const adv=$('planAdv'); if(!adv||!adv.checked) return []; return [...document.querySelectorAll('#planNets .planNet:checked')].map(c=>c.value); }
if($('planGenBtn')) $('planGenBtn').onclick=async()=>{
  const m=$('planMsg'); const nets=planSelectedNets();
  if(PlanSlots.some(s=>s.status==='empty'||s.status==='matched') && !confirm('Незаповнені слоти поточного скелета буде замінено новими. Продовжити?')) return;
  m.style.color='var(--muted)'; m.textContent='будую скелет…'; aiBusy(nets.length?('📅 Будую окремі плани для '+nets.length+' мереж…'):'📅 Будую майстер-план (адаптація під мережі - при публікації)…');
  const body={horizon:+$('planHorizon').value||14,posts_per_week:+$('planPpw').value||4,networks:nets,topic:($('planTopic')&&$('planTopic').value.trim())||undefined};
  try{ const r=await api('/plan/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const byNet=r.byNet||{}; const parts=Object.keys(byNet).map(k=>(CP_ICON[k]||'')+(byNet[k]));
    m.style.color='var(--brand)'; m.textContent='готово ✓ '+r.slots+' слотів'+(parts.length>1?(' ('+parts.join(' ')+')'):'')+(r.matched?(' · '+r.matched+' метчів'):''); await loadPlan(); }
  catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } finally{ aiDone(); }
};
// живий підрахунок «скільки постів вийде»: днів/7 × постів/тиж × кількість обраних мереж
function updPlanEst(){ const el=$('planEst'); if(!el) return; const h=+$('planHorizon').value||14, p=+$('planPpw').value||4;
  const nets=Math.max(1,planSelectedNets().length); const per=Math.max(1,Math.min(400,Math.round(h/7*p)));
  document.querySelectorAll('#planPace [data-ppw]').forEach(c=>c.classList.toggle('on',+c.dataset.ppw===p));
  el.textContent='≈ '+(per*nets)+' постів'+(nets>1?(' ('+per+'×'+nets+' мереж)'):''); }
if($('planHorizon')){ $('planHorizon').addEventListener('input',updPlanEst); $('planPpw').addEventListener('input',updPlanEst); updPlanEst(); }
// темп одним кліком: «кожні 3 год» = 8/день = 56/тиж (запит тестера під Threads)
document.querySelectorAll('#planPace [data-ppw]').forEach(c=>c.onclick=()=>{ $('planPpw').value=c.dataset.ppw; updPlanEst(); });
if($('planMatchBtn')) $('planMatchBtn').onclick=async()=>{
  const m=$('planMsg'); m.style.color='var(--muted)'; m.textContent='шукаю матеріали під слоти…'; aiBusy('🔗 Підбираю наявні матеріали під теми плану…');
  try{ const r=await api('/plan/match',{method:'POST'}); m.style.color='var(--brand)'; m.textContent=r.matched?('підібрано матеріалів: '+r.matched+' ✓'):'нових метчів нема (додай матеріали в «Матеріали»)'; await loadPlan(); }
  catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } finally{ aiDone(); }
};
// лічильники на вкладках конвеєра
function updateCounts(){
  if($('matCount')) $('matCount').textContent=Mats.length||'';
  const todo=PlanSlots.filter(s=>s.status==='empty'||s.status==='matched').length;
  if($('planCount')) $('planCount').textContent=todo||'';
  const rev=(Finals||[]).filter(p=>p.review!=='approved').length;
  if($('postCount')) $('postCount').textContent=rev||'';
}
$('toCalendar').onclick=()=>go('publish');

// ---------- аналітика ----------
// ---------- ⚡ СЬОГОДНІ: стан дня одним екраном (той самий зміст, що ранковий дайджест бота) ----------
async function loadToday(){
  const w=$('todayWrap'); if(!w) return;
  let t; try{ t=await api('/today'); }catch(e){ w.innerHTML='<div class="empty" style="padding:24px">⚠ '+esc(e.message)+'</div>'; return; }
  if(!Object.keys(ChanStatus||{}).length){ try{ await loadChanStatus(); }catch(e){} }
  const slotIcon=(s)=>s.status==='posted'?'✅':(s.status==='failed'?'⚠️':(s.status==='posting'?'⏳':'🕓'));
  const slots=(t.slots||[]).length
    ? t.slots.map(s=>'<div class="tdRow" data-slot="'+s.id+'" data-post="'+s.post_id+'" data-at="'+esc(s.scheduled_at)+'" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer" title="'+esc(s.result||s.status)+' · відкрити в композері">'
        +'<b style="min-width:52px;font-variant-numeric:tabular-nums">'+locHM(s.scheduled_at)+'</b><span>'+slotIcon(s)+'</span><span style="font-size:14px">'+chanIcons(s.channels)+'</span>'
        +'<span style="flex:1;min-width:0;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(s.title||'')+'</span></div>').join('')
    : '<div class="empty" style="padding:14px 0">Сьогодні нічого не заплановано.'+(t.nextSlot?'':' Згенеруй пост або відкрий календар.')+'</div>';
  const drafts=(t.drafts||[]).length
    ? t.drafts.map(d=>'<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">'
        +(d.rubric?'<span class="ptag" style="flex:none">🏷 '+esc(d.rubric)+'</span>':'')
        +'<span style="flex:1;min-width:0;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(d.title||'')+'</span>'
        +'<button class="ghost tdEdit" data-post="'+d.id+'" style="padding:5px 11px;font-size:12px;flex:none">✍ Редагувати</button>'
        +'<button class="primary tdOk" data-post="'+d.id+'" style="padding:5px 11px;font-size:12px;flex:none">✅ Затвердити</button></div>').join('')
    : '<div class="empty" style="padding:14px 0">Все затверджено 🙌</div>';
  const th=t.threads;
  // 🚀 швидкий старт: 3 кроки до першої публікації - видно, поки хоч один не виконано
  const qs=t.quickstart||{};
  const qsSteps=[
    ['📡','Підключи канал публікації','куди поїдуть пости: Telegram, Instagram, Threads чи Facebook', (qs.channels||0)>0, 'Підключити →', ()=>{ selectView('settings'); setSTab('channels'); }],
    ['🗂','Згенеруй контент-план','теми на тижні вперед - календар заповниться сам', (qs.plan||0)>0, 'Створити план →', ()=>{ selectView('publish'); setPTab('plan'); }],
    ['✅','Затверди перший пост','переглянь чернетку і натисни «Затвердити»', (qs.approved||0)>0, 'До чернеток →', ()=>{ selectView('create'); setCTab('posts'); }],
  ];
  const qsLeft=qsSteps.filter(s=>!s[3]).length;
  const qsHtml=(t.quickstart&&qsLeft)
    ? '<div class="panel" style="margin:0 0 16px;border:1px solid var(--brand-soft2)"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="font-weight:700;font-size:14.5px">🚀 Швидкий старт</div><span style="font-size:12px;color:var(--muted)">'+(qsSteps.length-qsLeft)+' з '+qsSteps.length+' виконано</span></div>'
      +qsSteps.map((s,i)=>'<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">'
        +'<span style="width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:12px;'+(s[3]?'background:var(--brand);color:#fff':'border:2px solid var(--line2);color:var(--faint)')+'">'+(s[3]?'✓':(i+1))+'</span>'
        +'<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600;'+(s[3]?'color:var(--faint);text-decoration:line-through':'')+'">'+s[0]+' '+s[1]+'</div>'+(s[3]?'':'<div style="font-size:12px;color:var(--muted)">'+s[2]+'</div>')+'</div>'
        +(s[3]?'':'<button class="primary qsGo" data-i="'+i+'" style="padding:6px 12px;font-size:12.5px;flex:none">'+s[4]+'</button>')+'</div>').join('')
      +'</div>'
    : '';
  // ⚠ збої публікацій (48г): раніше ховались у тултіпах календаря - тепер видно одразу
  const fails=(t.failed||[]);
  const failHtml=fails.length
    ? '<div class="panel" style="margin:0 0 16px;border:1px solid var(--danger)"><div style="font-weight:700;font-size:14px;color:var(--danger);margin-bottom:4px">⚠ Не опублікувалось ('+fails.length+')</div>'
      +fails.map(f=>'<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">'
        +'<span style="font-size:12px;color:var(--muted);flex:none">'+locDate(f.scheduled_at)+' '+locHM(f.scheduled_at)+'</span>'
        +'<div style="flex:1;min-width:0"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(f.title||'')+'</div>'
        +(f.result?'<div style="font-size:11.5px;color:var(--danger);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(f.result)+'</div>':'')+'</div>'
        +'<button class="ghost tdFix" data-post="'+f.post_id+'" data-slot="'+f.id+'" style="padding:5px 11px;font-size:12px;flex:none">Відкрити й повторити</button></div>').join('')
      +'</div>'
    : '';
  const fm=t.freshMaterials||{};
  // 🔀 воркфлоу-лійка (підглянуто в конкурентів): Новини → Чернетки → Опубліковано, клікабельно
  const funnel=[
    ['📥 Новини', String(fm.count||0), (fm.top?('за 24г · топ ⭐'+fm.top+'/10'):'нових за 24г'), ()=>{ selectView('create'); setCTab('materials'); }],
    ['📝 Чернетки', String(t.draftsTotal||0), 'на перегляд', ()=>{ selectView('create'); setCTab('posts'); }],
    ['✅ Опубліковано', String(t.publishedToday||0), 'сьогодні', ()=>selectView('analytics')],
  ];
  const funnelHtml='<div class="panel" style="margin:0 0 16px"><div style="display:flex;align-items:stretch;gap:6px;flex-wrap:wrap">'
    +funnel.map((f,i)=>(i?'<div style="display:flex;align-items:center;color:var(--faint);font-size:20px;padding:0 2px">→</div>':'')
      +'<div class="stat tdFn" data-fn="'+i+'" style="flex:1;min-width:120px;cursor:pointer"><div class="l">'+f[0]+'</div><div class="v">'+f[1]+'</div><div class="d">'+f[2]+'</div></div>').join('')
    +'</div></div>';
  // 📡 канали публікації: статус підключення + скільки пішло сьогодні, клік = Налаштування→Канали
  const chStatus=ChanStatus||{}, netT=t.netToday||{};
  const chanHtml='<div class="panel" style="margin-top:16px"><div style="font-weight:700;font-size:14.5px;margin-bottom:10px">📡 Канали публікації</div>'
    +'<div style="display:flex;gap:10px;flex-wrap:wrap">'
    +NETS.map(([k,label])=>{ const on=!!chStatus[k]; const n=netT[k]||0;
      return '<div class="tdChan" data-net="'+k+'" style="flex:1;min-width:130px;border:1px solid var(--line);border-radius:var(--r);padding:12px;cursor:pointer'+(on?'':';opacity:.75')+'">'
        +'<div style="display:flex;align-items:center;gap:8px"><span style="width:26px;height:26px;border-radius:50%;flex:none;display:grid;place-items:center;background:'+(on?'var('+NETVAR[k]+')':'var(--line2)')+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="'+NETICON[k]+'"></path></svg></span><b style="font-size:13.5px">'+label+'</b></div>'
        +(on?'<div style="font-size:12px;color:var(--muted);margin-top:6px">'+n+' сьогодні · <span style="color:var(--brand)">✓ підключено</span></div>'
            :'<div style="font-size:12px;color:var(--muted);margin-top:6px">не підключено</div><button class="ghost tdChanGo" style="margin-top:6px;padding:4px 10px;font-size:11.5px;width:100%">Підключити →</button>')
        +'</div>'; }).join('')
    +'</div></div>';
  const tiles=[
    th?['🔥 Стрік Threads', th.streak+' дн.', th.postedToday?'сьогодні вже є пост ✓':'<span style="color:var(--danger)">сьогодні ще пусто</span>']:null,
    th?['💬 Коменти','<span id="tdComm"><span class="spin"></span></span>','без відповіді · клік = відповісти']:null,
    ['✈️ Вчора вийшло', String(t.publishedYesterday||0), 'публікацій · клік = аналітика'],
    ['💡 Ідеї в банку', String(t.ideas||0), 'клік = відкрити'],
  ].filter(Boolean);
  w.innerHTML=funnelHtml+qsHtml+failHtml
    +'<div class="stat-grid" style="margin-bottom:16px">'+tiles.map((s,i)=>'<div class="stat tdTile" data-tile="'+i+'" style="cursor:pointer"><div class="l">'+s[0]+'</div><div class="v" style="font-size:21px">'+s[1]+'</div><div class="d">'+s[2]+'</div></div>').join('')+'</div>'
    +'<div class="grid2" style="align-items:start">'
      +'<div class="panel" style="margin:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-weight:700;font-size:14.5px">📤 Сьогодні виходить</div><button class="ghost" id="tdCal" style="margin-left:auto;padding:5px 11px;font-size:12px">🗓 Календар</button></div>'+slots+'</div>'
      +'<div class="panel" style="margin:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-weight:700;font-size:14.5px">✅ На затвердження</div><button class="ghost" id="tdAll" style="margin-left:auto;padding:5px 11px;font-size:12px">Всі чернетки →</button></div>'+drafts+'</div>'
    +'</div>'
    +'<div class="panel" style="margin-top:16px"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      +'<div style="flex:1;min-width:220px"><div style="font-weight:700;font-size:14.5px;margin-bottom:3px">⚡ Зробити зараз</div>'
      +(t.nextSlot?'<div style="font-size:13px;color:var(--ink2)">Наступна тема плану: <b>'+esc(String(t.nextSlot.theme||'').slice(0,90))+'</b> <span style="color:var(--faint)">('+esc(String(t.nextSlot.slot_date).slice(5))+')</span></div>':'<div style="font-size:13px;color:var(--muted)">План порожній - згенеруй скелет у «Публікація → План і ритм».</div>')+'</div>'
      +(t.nextSlot?'<button class="primary" id="tdGenSlot">✍️ Пост із теми дня</button>':'')
      +(th?'<button class="ghost" id="tdTakes" title="3 короткі тейки в чернетки - врятувати день у Threads">🧵 3 тейки</button>':'')
    +'</div></div>'
    +chanHtml;
  // дії
  w.querySelectorAll('.tdFn').forEach(el=>el.onclick=()=>funnel[+el.dataset.fn][3]());
  w.querySelectorAll('.tdChan').forEach(el=>el.onclick=(ev)=>{ ev.stopPropagation(); selectView('settings'); setSTab('channels'); });
  w.querySelectorAll('.qsGo').forEach(b=>b.onclick=()=>qsSteps[+b.dataset.i][5]());
  w.querySelectorAll('.tdRow').forEach(r=>r.onclick=()=>openComposer(r.dataset.post,{scheduledAt:r.dataset.at,slotId:r.dataset.slot}));
  w.querySelectorAll('.tdEdit').forEach(b=>b.onclick=()=>openComposer(b.dataset.post));
  w.querySelectorAll('.tdOk').forEach(b=>b.onclick=async()=>{ b.disabled=true;
    try{ await api('/posts/'+b.dataset.post+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'approved'})}); flash('✅ Затверджено'); loadToday(); try{ loadStudioPosts(); }catch(e){} try{loadGuide(true);}catch(e){} }
    catch(e){ flash('⚠ '+e.message); b.disabled=false; } });
  const tCal=$('tdCal'); if(tCal) tCal.onclick=()=>{ selectView('publish'); setPTab('cal'); };
  const tAll=$('tdAll'); if(tAll) tAll.onclick=()=>{ selectView('create'); setCTab('posts'); };
  w.querySelectorAll('.tdFix').forEach(b=>b.onclick=()=>openComposer(b.dataset.post,{slotId:b.dataset.slot}));
  w.querySelectorAll('.tdTile').forEach(el=>el.onclick=()=>{ const lbl=tiles[+el.dataset.tile][0];
    if(lbl.includes('Коменти')) openThreadsComments();
    else if(lbl.includes('Ідеї')){ selectView('create'); setCTab('ideas'); }
    else if(lbl.includes('Чернеток')){ selectView('create'); setCTab('posts'); }
    else if(lbl.includes('матеріали')){ selectView('create'); setCTab('materials'); }
    else if(lbl.includes('Вчора')||lbl.includes('Стрік')) selectView('analytics'); });
  const tGen=$('tdGenSlot'); if(tGen) tGen.onclick=async()=>{ tGen.disabled=true; aiBusy('✍️ Генерую пост із теми дня…');
    try{ await api('/plan/slots/'+t.nextSlot.id+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:'theme'})}); flash('Чернетка готова ✓'); loadToday(); try{ loadStudioPosts(); }catch(e){} }
    catch(e){ flash('⚠ '+e.message); tGen.disabled=false; } finally{ aiDone(); } };
  const tTk=$('tdTakes'); if(tTk) tTk.onclick=async()=>{ tTk.disabled=true; aiBusy('🧵 Пишу тейки…');
    try{ const r=await api('/posts/threads-takes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:3})}); flash('🧵 +'+r.created+' чернеток'); loadToday(); }
    catch(e){ flash('⚠ '+e.message); tTk.disabled=false; } finally{ aiDone(); } };
  // лічильник коментарів - окремо (живі виклики Threads API, не блокують екран)
  if(th){ api('/threads/comments?countOnly=1').then(r=>{ const el=$('tdComm'); if(el) el.textContent=String(r.count||0); })
    .catch(()=>{ const el=$('tdComm'); if(el){ el.textContent='—'; el.title='не вдалося прочитати (перепідключи Threads для нових дозволів)'; } }); }
}

async function loadAnalytics(){
  const box=$('analyticsBox'); if(!box) return;
  // миттєвий скелетон + ПАРАЛЕЛЬНІ локальні запити; повільна статистика мереж підтягується окремо після рендера
  box.innerHTML='<div class="stat-grid" style="margin-bottom:18px">'+[1,2,3,4].map(()=>'<div class="stat"><div class="l" style="opacity:.4">…</div><div class="v" style="opacity:.25">—</div></div>').join('')+'</div><div class="empty">Завантажую аналітику…</div>';
  let usage={},slots=[],bank=[],pub={posts:0,sends:0,recent:[]};
  const rs=await Promise.allSettled([api('/usage'),api('/schedule'),api('/bank'),api('/published')]);
  if(rs[0].status==='fulfilled') usage=rs[0].value; if(rs[1].status==='fulfilled') slots=rs[1].value;
  if(rs[2].status==='fulfilled') bank=rs[2].value;  if(rs[3].status==='fulfilled') pub=rs[3].value;
  const mstats={}; // мережева статистика вантажиться асинхронно нижче (не блокує сторінку)
  const queued=slots.filter(s=>s.status==='planned').length; const failed=slots.filter(s=>s.status==='failed').length;
  const toks=(usage.prompt_tokens||0)+(usage.completion_tokens||0);
  const stats=[['Опубліковано',pub.posts,pub.sends+' у мережах'],['У черзі',queued,'заплановано'+(failed?(' · '+failed+' ⚠'):'')],['Витрати на AI','$'+(Number(usage.cost)||0).toFixed(2),toks.toLocaleString('uk')+' токенів'],['У банку',bank.length,'затверджених']];
  const rec=pub.recent||[];
  const wk=[0,0,0,0,0,0,0,0];
  const weekStart=new Date(); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate()-49);
  rec.forEach(r=>{ const diff=Math.floor((new Date(r.created_at)-weekStart)/(7*864e5)); if(diff>=0&&diff<8) wk[diff]++; });
  const mx=Math.max(1,...wk);
  const chCount={telegram:0,instagram:0,facebook:0,threads:0}; let chTot=0;
  rec.forEach(r=>{ if(chCount[r.net]!=null){ chCount[r.net]++; chTot++; } });
  const CHN={telegram:['Telegram','--tg'],instagram:['Instagram','--ig'],facebook:['Facebook','--fb'],threads:['Threads','--th']};
  const igHtml = '<div id="igLive" style="margin-top:14px;padding:13px;border-radius:11px;background:var(--brand-soft);font-size:12.5px;color:var(--brand)"><span class="spin"></span> Завантажую статистику Instagram/Facebook…</div>';
  // 💸 куди йдуть гроші на AI: розріз за моделями й кроками (30 днів) + вхід у порівняння моделей.
  // Дані лежали в llm_usage з першого дня, але ніде не показувались, а панель порівняння була
  // захована в меню аватара - тут і те, й те опиняється саме там, де виникає питання «яка модель».
  const usageRow=(r,tot)=>'<div style="display:flex;align-items:baseline;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px">'
    +'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(r.name)+'</span>'
    +'<span style="color:var(--muted);font-variant-numeric:tabular-nums">'+(r.calls||0)+' викл.</span>'
    +'<span style="font-weight:700;font-variant-numeric:tabular-nums;min-width:64px;text-align:right">$'+(Number(r.cost)||0).toFixed(4)+'</span>'
    +'<span style="color:var(--faint);font-variant-numeric:tabular-nums;min-width:38px;text-align:right">'+(tot?Math.round((Number(r.cost)||0)/tot*100):0)+'%</span></div>';
  const byModel=(usage.byModel||[]).slice(0,6).map(r=>({name:r.model,calls:r.calls,cost:r.cost}));
  const byStep=(usage.byStep||[]).slice(0,6).map(r=>({name:r.step,calls:r.calls,cost:r.cost}));
  const totCost=(usage.byModel||[]).reduce((a,r)=>a+(Number(r.cost)||0),0);
  // стеля витрат: видно ДО того, як упрешся в неї (0 = без обмеження)
  const cap=usage.cap||{}; const capRow=(label,spent,lim)=>{ const pct=lim>0?Math.min(100,Math.round(spent/lim*100)):0; const warn=pct>=80;
    return '<div style="margin-top:6px"><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>'+label+'</span><span style="font-variant-numeric:tabular-nums;font-weight:600;color:'+(warn?'var(--amber)':'inherit')+'">$'+(Number(spent)||0).toFixed(2)+(lim>0?' із $'+Number(lim).toFixed(2):' · без стелі')+'</span></div>'
      +(lim>0?'<div style="height:6px;border-radius:4px;background:var(--surface2);overflow:hidden;margin-top:3px"><div id="capBar'+label.slice(0,1)+'" style="width:'+pct+'%;height:100%;background:'+(warn?'var(--amber)':'var(--brand)')+'"></div></div>':'')+'</div>'; };
  const capHtml = cap.capDay!=null ? '<div id="capBox" style="margin-bottom:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px"><div style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em">Стеля витрат на AI</div>'
    +capRow('Сьогодні',cap.spentDay,cap.capDay)+capRow('Цей місяць',cap.spentMonth,cap.capMonth)
    +'<div class="hint" style="margin-top:6px">Коли стеля вичерпана, генерація зупиняється до опівночі (UTC). Потрібно більше - напиши адміністратору.</div></div>' : '';
  const spendHtml='<div class="panel" style="margin:0 0 18px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    +'<div style="font-weight:700;font-size:14px">💸 Куди йдуть гроші на AI</div>'
    +'<span style="font-size:12px;color:var(--muted)">за 30 днів</span>'
    +'<button class="ghost" id="anAbBtn" style="margin-left:auto;padding:5px 12px;font-size:12.5px" title="Прогнати один матеріал кількома моделями і порівняти тексти поруч">🧪 Порівняти моделі</button></div>'
    +capHtml
    // 🤖 Виклики через підписку коштують чесний нуль, тобто в таблиці витрат їх не видно взагалі.
    // Цей рядок - єдине місце, де відповідь на «а воно взагалі економить?» стає числом.
    +((usage.saved&&Number(usage.saved.usd)>0)
      ? '<div id="cliSaved" style="margin-bottom:10px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;font-size:12.5px">🤖 Через підписку Claude (без оплати токенів): <b>'+Number(usage.saved.calls||0)+'</b> викликів · заощаджено <b>$'+Number(usage.saved.usd).toFixed(2)+'</b> за 30 днів</div>' : '')
    +(byModel.length
      ? '<div class="grid2" style="gap:16px"><div><div style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">За моделями</div>'+byModel.map(r=>usageRow(r,totCost)).join('')+'</div>'
        +'<div><div style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">За кроками</div>'+byStep.map(r=>usageRow(r,totCost)).join('')+'</div></div>'
      : '<div class="empty" style="padding:12px">За останні 30 днів викликів не було.</div>')+'</div>';
  box.innerHTML=
    '<div class="stat-grid" style="margin-bottom:18px">'+stats.map(s=>'<div class="stat"><div class="l">'+s[0]+'</div><div class="v">'+s[1]+'</div><div class="d">'+s[2]+'</div></div>').join('')+'</div>'
    +spendHtml
    +'<div class="grid2" style="grid-template-columns:1.5fr 1fr">'
    +'<div class="panel" style="margin:0"><div style="font-weight:700;font-size:14px;margin-bottom:18px">Опубліковано за тиждень</div><div class="bars">'+wk.map((v,i)=>'<div class="bar"><div class="b" style="height:'+(v/mx*100)+'%;background:'+(i===7?'var(--brand)':'var(--brand-soft2)')+'"></div><div class="lab">Т'+(i+1)+'</div></div>').join('')+'</div></div>'
    +'<div class="panel" style="margin:0"><div style="font-weight:700;font-size:14px;margin-bottom:14px">За каналами</div>'
      +(chTot?Object.keys(CHN).map(k=>{ const pct=Math.round(chCount[k]/chTot*100); return '<div style="margin-bottom:14px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="width:11px;height:11px;border-radius:4px;background:var('+CHN[k][1]+')"></span><span style="font-size:13px;font-weight:600;flex:1">'+CHN[k][0]+'</span><span style="font-size:13px;font-weight:700">'+pct+'%</span></div><div style="height:7px;border-radius:5px;background:var(--surface2);overflow:hidden"><div style="width:'+pct+'%;height:100%;background:var('+CHN[k][1]+')"></div></div></div>'; }).join(''):'<div class="empty">Ще немає опублікованих постів.</div>')
      +igHtml+'</div>'
    +'</div>'
    +'<div class="panel" style="margin:18px 0 0"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px"><div style="font-weight:700;font-size:14px">📊 Пости відносно твоєї норми</div><button class="ghost" id="topPatBtn" style="margin-left:auto;padding:5px 12px;font-size:12.5px" title="AI розбирає топ-пости і знаходить 1-2 патерни, що повторюються в усіх хітах">🔍 Що спрацювало</button></div><div class="hint" style="margin-bottom:8px">Норма = медіана переглядів твоїх постів у мережі за 90 днів. ×2.0 = удвічі краще за твій звичайний пост. Статистика збирається автоматично раз на добу.</div><div id="bmLive"><span class="spin"></span></div></div>'
    +'<div class="panel" id="thAnPanel" style="margin:18px 0 0;display:none"></div>'
    +'<div class="panel" style="margin:18px 0 0"><div style="font-weight:700;font-size:14px;margin-bottom:6px">Останні публікації</div>'+(rec.length?rec.slice(0,12).map(r=>'<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--line)"><span style="font-size:15px">'+({telegram:"✈️",instagram:"📸",facebook:"📘",threads:"🧵"}[r.net]||"•")+'</span><div style="flex:1;min-width:0"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc((r.content||"").replace(/\n+/g," ").slice(0,80))+'</div><div style="font-size:11px;color:var(--muted)">'+(CHN[r.net]?CHN[r.net][0]:r.net)+" · "+new Date(r.created_at).toLocaleString("uk")+'</div></div>'+(r.permalink?'<a href="'+esc(r.permalink)+'" target="_blank" rel="noopener" title="Відкрити пост у мережі" style="font-size:12px;font-weight:700;color:var(--brand);text-decoration:none;flex:none">↗</a>':'')+'</div>').join(""):'<div class="empty">Ще нічого не опубліковано. Опублікуй пост - і він зʼявиться тут.</div>')+'</div>';
  if($('topPatBtn')) $('topPatBtn').onclick=topPatterns;
  if($('anAbBtn')) $('anAbBtn').onclick=()=>{ selectView('tools'); setTimeout(()=>{ const p=$('abModels'); if(p) p.closest('.panel').scrollIntoView({behavior:'smooth',block:'center'}); },250); };
  api('/analytics/benchmarks').then(b=>{
    const el=$('bmLive'); if(!el) return;
    const nets=Object.keys(b.networks||{});
    if(!nets.length){ el.innerHTML='<div class="empty" style="padding:10px 0">Ще збираю статистику опублікованих постів (Threads / Instagram / Facebook). Потрібно ≥3 пости з метриками на мережу - зазирни за день-два.</div>'; return; }
    const NICO={threads:'🧵',instagram:'📸',facebook:'📘'};
    el.innerHTML='<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px">'+nets.map(n=>'<span style="font-size:12.5px;color:var(--muted)">'+(NICO[n]||'')+' норма '+n+': <b style="color:var(--ink)">'+b.networks[n].median.toLocaleString('uk')+'</b> переглядів ('+b.networks[n].count+' постів)</span>').join('')+'</div>'
      +(b.posts||[]).slice(0,10).map(p=>{ const c=p.mult>=1.5?'var(--ok,#22a06b)':(p.mult<0.7?'var(--danger)':'var(--muted)');
        return '<div style="display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--line)"><b style="min-width:48px;color:'+c+'">×'+p.mult+'</b><span style="font-size:14px">'+(NICO[p.network]||'')+'</span><div style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.title)+'</div><span style="font-size:11.5px;color:var(--muted)">'+p.views.toLocaleString('uk')+'</span></div>'; }).join('');
  }).catch(()=>{ const el=$('bmLive'); if(el) el.innerHTML='<div class="empty" style="padding:10px 0">Не вдалося завантажити бенчмарки.</div>'; });
  // 🧵 розширена аналітика Threads (живі інсайти профілю + таблиця постів; кеш 15 хв на сервері)
  api('/analytics/threads').then(t=>{
    const el=$('thAnPanel'); if(!el) return; el.style.display='';
    const dlt=(k)=>{ if(!t.now||!t.prev||!(k in t.prev)) return '';
      const a=Number(t.now[k])||0, b=Number(t.prev[k])||0; if(!b) return '';
      const p=Math.round((a-b)/b*100); return '<span style="font-size:11px;font-weight:700;color:'+(p>=0?'var(--ok,#22a06b)':'var(--danger)')+'">'+(p>=0?'+':'')+p+'%</span>'; };
    const fmt=(v)=>v==null?'—':Number(v).toLocaleString('uk');
    const tiles=[
      ['Перегляди', t.now?fmt(t.now.views):'—', dlt('views')],
      ['Лайки', t.now?fmt(t.now.likes):'—', dlt('likes')],
      ['Відповіді', t.now?fmt(t.now.replies):'—', dlt('replies')],
      ['Репости', t.now?fmt(t.now.reposts):'—', dlt('reposts')],
      ['Цитати', t.now?fmt(t.now.quotes):'—', dlt('quotes')],
      ['Пости', fmt(t.postsCount), ''],
      ['Інтервал', t.intervalH!=null?(t.intervalH+' год'):'—', ''],
      ['🔥 Стрік', t.streak+' дн.', t.postedToday?'':'<span style="font-size:11px;color:var(--danger)">сьогодні ще пусто</span>'],
    ];
    const posts=(t.posts||[]).length
      ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:560px"><tr style="color:var(--muted);text-align:right"><th style="text-align:left;padding:6px 4px;font-weight:600">Пост</th><th style="padding:6px 4px">👁</th><th style="padding:6px 4px">❤️</th><th style="padding:6px 4px">💬</th><th style="padding:6px 4px">🔁</th><th style="padding:6px 4px">❝</th></tr>'
        +t.posts.map(p=>'<tr style="border-top:1px solid var(--line);text-align:right"><td style="text-align:left;padding:7px 4px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.title||'')+'<div style="font-size:10.5px;color:var(--faint)">'+new Date(p.created_at).toLocaleDateString('uk')+'</div></td><td style="padding:7px 4px">'+fmt(p.views)+'</td><td style="padding:7px 4px">'+fmt(p.likes)+'</td><td style="padding:7px 4px">'+fmt(p.replies)+'</td><td style="padding:7px 4px">'+fmt(p.reposts)+'</td><td style="padding:7px 4px">'+fmt(p.quotes)+'</td></tr>').join('')+'</table></div>'
      : '<div class="empty">Ще нема опублікованих Threads-постів.</div>';
    let demo='';
    const dg=(t.demographics&&t.demographics.gender)||[], da=(t.demographics&&t.demographics.age)||[], dc=(t.demographics&&t.demographics.country)||[];
    if(dg.length||da.length||dc.length){
      const bar=(rows)=>{ const mx2=Math.max(1,...rows.map(r=>r.value)); return rows.slice(0,6).map(r=>'<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px"><span style="min-width:64px;font-size:11.5px;color:var(--muted)">'+esc(r.key)+'</span><div style="flex:1;height:8px;border-radius:5px;background:var(--surface2);overflow:hidden"><div style="width:'+(r.value/mx2*100)+'%;height:100%;background:var(--th)"></div></div><b style="font-size:11.5px;min-width:30px;text-align:right">'+r.value+'</b></div>').join(''); };
      demo='<div style="font-weight:700;font-size:13px;margin:16px 0 8px">Хто підписаний</div><div class="grid2">'
        +(dg.length?'<div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Стать</div>'+bar(dg)+'</div>':'')
        +(da.length?'<div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Вік</div>'+bar(da)+'</div>':'')
        +(dc.length?'<div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Країни</div>'+bar(dc)+'</div>':'')+'</div>';
    }
    el.innerHTML='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px"><div style="font-weight:700;font-size:14px">🧵 Threads'+(t.username?(' · @'+esc(t.username)):'')+'</div>'
      +(t.followers!=null?'<span style="font-size:12.5px;color:var(--muted)">підписників: <b style="color:var(--ink)">'+fmt(t.followers)+'</b></span>':'')
      +'<button class="ghost" id="anThComments" style="margin-left:auto;padding:5px 12px;font-size:12.5px" title="Коментарі під твоїми постами + AI-драфти відповідей">💬 Коменти</button>'
      +'<span style="font-size:11px;color:var(--faint)">останні 7 днів vs попередні 7</span></div>'
      +(t.insightsError?'<div class="hint" style="margin:4px 0 8px">⚠ Інсайти профілю недоступні: '+esc(t.insightsError)+' (можливо, чекаємо схвалення threads_manage_insights)</div>':'')
      +'<div class="stat-grid" style="margin:10px 0 14px">'+tiles.map(s=>'<div class="stat"><div class="l">'+s[0]+'</div><div class="v" style="font-size:19px">'+s[1]+'</div><div class="d">'+(s[2]||'&nbsp;')+'</div></div>').join('')+'</div>'
      +'<div style="font-weight:700;font-size:13px;margin-bottom:6px">Останні пости</div>'+posts+demo;
    const cb=$('anThComments'); if(cb) cb.onclick=()=>openThreadsComments(cb);
  }).catch(()=>{ /* Threads не підключено - панель лишається схованою */ });
  // мережева статистика довантажується ПІСЛЯ рендера сторінки (Graph API повільний - не блокуємо аналітику)
  api('/integrations/meta/stats').then(m=>{
    const el=$('igLive'); if(!el) return;
    const ig=m.instagram, igi=m.instagramInsights||{}, fb=m.facebook;
    el.innerHTML=(ig||fb)
      ? (ig?'<div style="font-size:12.5px;font-weight:700;color:var(--brand)">📸 Instagram @'+esc(ig.username||'')+'</div><div style="font-size:12.5px;color:var(--ink2);margin-top:3px">'+(ig.followers_count||0)+' підписників · '+(ig.media_count||0)+' постів'+(igi.reach!=null?(' · охоплення 28д: <b>'+igi.reach+'</b>'):'')+'</div>':'')
        +(fb?'<div style="font-size:12.5px;font-weight:700;color:var(--brand);margin-top:'+(ig?'8px':'0')+'">📘 Facebook '+esc(fb.name||'')+'</div><div style="font-size:12.5px;color:var(--ink2);margin-top:3px">'+(fb.followers_count||fb.fan_count||0)+' підписників</div>':'')
      : 'Підключи Instagram/Facebook у Налаштуваннях, щоб бачити охоплення й підписників.';
  }).catch(()=>{ const el=$('igLive'); if(el) el.textContent='Підключи Instagram/Facebook у Налаштуваннях, щоб бачити охоплення й підписників.'; });
}

// 🔍 «Що спрацювало»: AI-розбір топ-постів (за ×N) → повторювані патерни → правило голосу в 1 клік
async function topPatterns(){ aiBusy('🔍 Розбираю топ-пости: шукаю, що повторюється в усіх хітах…');
  let r; try{ r=await api('/analytics/top-patterns',{method:'POST'}); }catch(e){ aiDone(); flash('⚠ '+e.message); return; } finally{ aiDone(); }
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='80';
  ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🔍 Що спрацювало (розбір '+(r.sample||0)+' топ-постів)</b><button class="icon" id="tpX" style="margin-left:auto">✕</button></div>'
    +'<div class="hint" style="margin-bottom:10px">Патерни, що повторюються у ВСІХ твоїх найкращих постах. Те, що було лише в одному хіті - шум, його тут нема.</div>'
    +(r.patterns||[]).map(p=>'<div class="card" style="margin-bottom:8px"><b>'+esc(p.pattern)+'</b><div style="font-size:12.5px;color:var(--ink2);margin-top:4px;line-height:1.45">'+esc(p.evidence||'')+'</div></div>').join('')
    +(r.rule?'<div style="margin-top:12px;padding:12px;border-radius:10px;background:var(--brand-soft)"><div style="font-size:12px;color:var(--brand);font-weight:700;margin-bottom:4px">Готове правило для генерації:</div><div style="font-size:13px">'+esc(r.rule)+'</div><div class="btnrow" style="margin-top:10px"><button class="primary" id="tpSave">✍ Запамʼятати як правило голосу</button><span id="tpMsg" style="font-size:12px;color:var(--muted)"></span></div></div>':'')
    +'</div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#tpX').onclick=close;
  const sv=ov.querySelector('#tpSave'); if(sv) sv.onclick=async()=>{ sv.disabled=true;
    try{ await api('/voice-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule:r.rule})}); ov.querySelector('#tpMsg').textContent='✓ тепер кожна генерація враховує це'; try{loadSettings();}catch(e){} }
    catch(e){ ov.querySelector('#tpMsg').textContent='⚠ '+e.message; sv.disabled=false; } };
}

// ---------- база бренду (settings) ----------
async function loadSettings(){
  try{
    const rows = await api('/settings');
    const map = Object.fromEntries(rows.map(r=>[r.key, r.content]));
    for(const [tid,key] of Object.entries(SET)){ if(map[key]!=null && $(tid)) $(tid).value = map[key]; }
    if(map.output_language && $('langSel')){ ensureLangOption(map.output_language); $('langSel').value = map.output_language; }
    TZ = map.timezone || TZ; buildTzSel();
    PRO = (map.pro==='1'); updateProUI();
    if(map.tone_of_voice_derived) renderDerived(map.tone_of_voice_derived);
    if($('vAddr')) $('vAddr').value=map.voice_address||'';
    if($('reelRend')) $('reelRend').value=map.reel_renderer||'classic';
    if($('reelVis')){ $('reelVis').value=map.reel_visual||'stock'; if(map.kie_video_model&&$('reelKieModel')){ const o=document.createElement('option'); o.value=o.textContent=map.kie_video_model; $('reelKieModel').appendChild(o); $('reelKieModel').value=map.kie_video_model; } syncReelVis(); }
    if($('vEmoji')) $('vEmoji').value=map.voice_emoji||'';
    { let qg={}; try{ qg=JSON.parse(map.qa_gates||'{}'); }catch(e){ qg={}; }
      if($('qgDirector')) $('qgDirector').checked=!!qg.director;
      if($('qgAiaudit')) $('qgAiaudit').checked=!!qg.aiaudit;
      if($('qgStorytelling')) $('qgStorytelling').checked=!!qg.storytelling; }
    // чесний бейдж: голос НЕ відкалібрований, поки нема ані ToV, ані прикладів постів
    if($('voiceCalBadge')) $('voiceCalBadge').style.display=((map.tone_of_voice||'').trim()||(map.voice_examples||'').trim())?'none':'inline';
    window._v2 = (map.prompt_engine!=='legacy'); // v2 - дефолтний рушій
    if($('briefView')) renderBrief(map.strategy_brief||'');
    $('srvDot').style.background='var(--brand)';
  }catch(e){ $('srvDot').style.background='var(--danger)'; }
}
// 🩺 перевірка контексту: показує, ЧОМУ пости виходять не такі, ще до того, як їх генерувати.
// Ключова ідея, яку перевірка доносить до людини: приклади голосу сильніші за written-правила, тож
// суперечність між ними - не дрібниця, а головна причина «правильних, але нічиїх» текстів.
const CTX_SEV={critical:['🔴','var(--danger)','критично'],warn:['🟠','var(--amber)','варто виправити'],info:['⚪','var(--muted)','дрібниця']};
function renderCtx(r){
  const box=$('ctxOut'); if(!box) return;
  const f=r.findings||[];
  if(!f.length){ box.innerHTML='<div style="padding:12px;border-radius:10px;background:var(--brand-soft);color:var(--brand);font-size:13px;font-weight:600">✓ Суперечностей не знайшов. Контекст готовий до генерації.</div>'; return; }
  const crit=f.filter(x=>x.severity==='critical').length;
  box.innerHTML='<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap">'
    +'<b style="font-size:15px">Оцінка контексту: '+(r.score||0)+'/10</b>'
    +(crit?'<span style="font-size:12.5px;color:var(--danger);font-weight:700">'+crit+' критичн.</span>':'')
    +(r.promptChars?'<span style="font-size:12px;color:var(--faint)">промт '+r.promptChars+' симв.</span>':'')+'</div>'
    +f.map((x,i)=>{ const sv=CTX_SEV[x.severity]||CTX_SEV.info;
      return '<div style="border-left:3px solid '+sv[1]+';background:var(--surface2);border-radius:0 9px 9px 0;padding:10px 13px;margin-bottom:8px">'
        +'<div style="display:flex;gap:7px;align-items:baseline;flex-wrap:wrap"><span>'+sv[0]+'</span><b style="font-size:13.5px">'+esc(x.title)+'</b>'
        +'<span style="font-size:11px;color:var(--faint)">'+esc(x.field||'')+'</span></div>'
        +(x.why?'<div style="font-size:12.5px;color:var(--ink2);margin-top:4px;line-height:1.5">'+esc(x.why)+'</div>':'')
        +(x.fix?'<div style="font-size:12.5px;color:'+sv[1]+';margin-top:5px;line-height:1.5"><b>Що зробити:</b> '+esc(x.fix)+'</div>':'')
        +(x.key?'<button class="ghost ctxFix" data-i="'+i+'" style="margin-top:8px;padding:5px 12px;font-size:12.5px">✏️ Виправити</button>':'')
        +'</div>'; }).join('');
  box.querySelectorAll('.ctxFix').forEach(b=>b.onclick=()=>openCtxFix(f[+b.dataset.i]));
}
// «Виправити» просто в місці знахідки: ліворуч ЩО Є (з підсвіченими проблемними фрагментами),
// праворуч ЩО СТАНЕ - редагується й зберігається. Причина такого рішення: знайти проблему виявилось
// легше, ніж її полагодити - людина бачила діагноз і не знала, куди йти й що саме писати.
// ⚠️ Кнопка «✨ Запропонувати» є НЕ скрізь. Приклади голосу й докази переписує лише людина: приклад,
// написаний моделлю, перестає бути прикладом ГОЛОСУ, а вигаданий доказ - це те, від чого ми якраз
// ставили запобіжник.
const CTX_FIELD_LABEL={voice_examples:'Приклади постів',strategy_brief:'Стратегічний бриф',pain_points:'Болі клієнта',
  tone_of_voice:'Голос бренду',voice_stoplist:'Стоп-лист',brand_story:'Історія бренду',brand_antiassoc:'Анти-асоціації'};
function hlQuotes(text,quotes){
  let h=esc(text);
  (quotes||[]).forEach(qt=>{ const q=esc(String(qt||'').trim()); if(q.length<3) return;
    // ⚠️ регістронезалежно: слова зі стоп-листа приходять нормалізованими в нижній регістр, тож
    // точний збіг не підсвітив би «Ключовий фактор» у тексті - тобто саме те, на що вказує знахідка
    // пробіли/переноси прирівнюємо: scanAiTraces віддає цитату з \n, заміненими на пробіли, тож
    // точний збіг НІКОЛИ не знаходився в оригіналі - саме тому підсвітки не було видно
    const rx=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'[\\s]+'),'gi');
    h=h.replace(rx,'<mark style="background:var(--amber-soft);color:var(--ink);border-radius:3px">$&</mark>'); });
  return h;
}
async function openCtxFix(fnd){
  if(!fnd||!fnd.key) return;
  let cur=''; try{ const st=await api('/settings'); const row=(st||[]).find(r=>r.key===fnd.key); cur=(row&&row.content)||''; }catch(e){}
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='96';
  const aiOk=fnd.mode==='ai';
  ov.innerHTML='<div class="modal-card" style="max-width:900px;padding:20px;max-height:88vh;overflow:auto">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><b style="font-size:16px">✏️ '+esc(fnd.title)+'</b><button class="icon" id="cfX" style="margin-left:auto">✕</button></div>'
    +'<div class="hint" style="margin-bottom:12px">'+esc(fnd.fix||'')+'</div>'
    +'<div class="btnrow" style="margin:0 0 12px;flex-wrap:wrap;align-items:center">'
      +(aiOk?'<button class="primary" id="cfAi">✨ Запропонувати варіант</button><span style="font-size:12px;color:var(--muted)">перепише лише формулювання, факти й зміст лишить</span>'
           :'<span style="font-size:12px;color:var(--muted)">✍️ Це поле пишеш лише ти: текст, написаний моделлю, перестане бути твоїм голосом - і наступні пости вчитимуться вже на ньому.</span>')
    +'</div>'
    +'<div class="grid2" style="gap:14px;align-items:start">'
      +'<div><div style="font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--faint);text-transform:uppercase;margin-bottom:5px">Було</div>'
        +'<div style="border:1px solid var(--line);border-radius:10px;padding:11px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;max-height:44vh;overflow:auto;background:var(--surface2)">'+(cur?hlQuotes(cur,fnd.quotes):'<span style="color:var(--muted)">порожньо</span>')+'</div></div>'
      +'<div><div style="font-size:11px;font-weight:800;letter-spacing:.07em;color:var(--faint);text-transform:uppercase;margin-bottom:5px">Стало ('+esc(CTX_FIELD_LABEL[fnd.key]||fnd.key)+') <span id="cfState" style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--amber)">- поки без змін</span></div>'
        +'<textarea id="cfNew" class="txt" style="min-height:44vh;font-size:12.5px;line-height:1.6"></textarea></div>'
    +'</div>'
    +'<div class="btnrow" style="margin-top:12px"><span style="flex:1"></span><button class="primary" id="cfSave">💾 Зберегти</button></div>'
    +'<div id="cfMsg" style="font-size:12.5px;color:var(--muted);margin-top:8px;min-height:16px"></div></div>';
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('#cfX').onclick=close;
  const ta=ov.querySelector('#cfNew'); ta.value=cur;
  ta.addEventListener('input',()=>{ const stx=ov.querySelector('#cfState');
    if(stx){ const ch=ta.value!==cur; stx.textContent=ch?'- відредаговано':'- поки без змін'; stx.style.color=ch?'var(--brand)':'var(--amber)'; } });
  const msg=ov.querySelector('#cfMsg');
  const ai=ov.querySelector('#cfAi');
  if(ai) ai.onclick=async()=>{ ai.disabled=true; msg.textContent='пишу варіант…'; aiBusy('✨ Готую виправлений варіант…');
    try{ const r=await runAiJob('/brand/context-fix',{key:fnd.key,problem:fnd.title+'. '+(fnd.why||'')},(sec)=>{ msg.textContent='пишу варіант… '+sec+'с'; });
      ta.value=r.suggestion||''; const stx=ov.querySelector('#cfState'); if(stx){ stx.textContent='- варіант від AI'; stx.style.color='var(--brand)'; }
      msg.textContent='готово - перечитай і, якщо треба, поправ своєю рукою'; }
    catch(e){ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; }
    finally{ ai.disabled=false; aiDone(); } };
  ov.querySelector('#cfSave').onclick=async()=>{
    const btn=ov.querySelector('#cfSave'); btn.disabled=true; msg.style.color='var(--muted)'; msg.textContent='зберігаю…';
    try{ await api('/settings/'+fnd.key,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:ta.value})});
      const el=$(Object.keys(SET).find(k=>SET[k]===fnd.key)||''); if(el) el.value=ta.value;   // поле в кабінеті теж оновлюємо
      close();
      // перечитуємо ШВИДКИЙ шар: виправлений пункт має зникнути одразу, без нового платного розбору
      try{ renderCtx(await api('/brand/context-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deep:false})})); }catch(e){}
      loadTasks(); flash('Збережено ✓');
    }catch(e){ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; btn.disabled=false; }
  };
}
if($('ctxRun')) $('ctxRun').onclick=async()=>{
  const b=$('ctxRun'); b.disabled=true; $('ctxOut').innerHTML='<span class="spin"></span> читаю зібраний промт…'; aiBusy('🩺 Перевіряю контекст на суперечності…');
  try{ renderCtx(await runAiJob('/brand/context-check',{deep:true},(sec)=>{ $('ctxOut').innerHTML='<span class="spin"></span> читаю зібраний промт… '+sec+'с'; })); loadTasks(); }
  catch(e){ $('ctxOut').innerHTML='<div style="color:var(--danger);font-size:13px">⚠ '+esc(e.message)+'</div>'; }
  finally{ b.disabled=false; aiDone(); }
};
function renderBrief(text){ const o=$('briefView'); if(!o) return; o.innerHTML = text ? '<pre style="white-space:pre-wrap;font:inherit;margin:0;color:var(--ink2);line-height:1.65">'+esc(text)+'</pre>' : '<div class="empty">Натисни «Згенерувати» вгорі - бриф зʼявиться тут.</div>'; }
let saveT;
function flashSaved(){ const s=$('saved'); if(!s) return; s.style.opacity='1'; clearTimeout(flashSaved._t); flashSaved._t=setTimeout(()=>s.style.opacity='0',1500); }
async function saveSetting(key,val){ try{ await api('/settings/'+key,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:val})}); flashSaved(); }catch(e){} }
for(const tid of Object.keys(SET)){ const el=$(tid); if(el) el.addEventListener('input', ()=>{ clearTimeout(saveT); saveT=setTimeout(()=>saveSetting(SET[tid],el.value),700); }); }
$('langSel').onchange=()=>saveSetting('output_language',$('langSel').value);
if($('vAddr')) $('vAddr').onchange=()=>saveSetting('voice_address',$('vAddr').value);
if($('reelRend')) $('reelRend').onchange=()=>saveSetting('reel_renderer',$('reelRend').value);
if($('reelVis')) $('reelVis').onchange=()=>{ saveSetting('reel_visual',$('reelVis').value); syncReelVis(); };
if($('reelKieModel')) $('reelKieModel').onchange=()=>{ saveSetting('kie_video_model',$('reelKieModel').value); showKieCost(); };
// Селект відео-моделі наповнюється з ЖИВОГО прайса kie.ai, а не зі списку в коді: захардкоджений
// перелік застаріє за місяць і - гірше - брехатиме про ціну. Тому й ціна показується поруч.
let KieVid=null;
function showKieCost(){
  const o=$('reelKieCost'); if(!o||!KieVid) return;
  const m=KieVid.find(x=>x.id===$('reelKieModel').value);
  o.innerHTML = m ? ('Приблизно <b>$'+m.usd.toFixed(3)+'</b> за кліп'+(m.unit?' ('+esc(m.unit)+')':'')+'. У рілсі стільки кліпів, скільки бітів у сценарії - тобто ~$'+(m.usd*4).toFixed(2)+' за ролик із 4 бітів.')
    : 'Перелік і ціни тягнуться з живого прайса kie.ai.';
}
async function syncReelVis(){
  const w=$('reelKieWrap'); if(!w) return;
  const on = $('reelVis') && $('reelVis').value==='ai';
  w.style.display = on ? '' : 'none';
  if(!on || KieVid) { showKieCost(); return; }
  try{
    const r=await api('/pricing/media?category=video');
    KieVid=r.kie||[];
    const cur=$('reelKieModel').value;
    $('reelKieModel').innerHTML=KieVid.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.id)+' - $'+m.usd.toFixed(3)+'</option>').join('');
    if(cur && KieVid.some(m=>m.id===cur)) $('reelKieModel').value=cur;
    if(!r.kieReady) $('reelKieCost').innerHTML='<span style="color:var(--amber)">Ключ kie.ai не доданий - AI-відео не запуститься, кадри й далі братимуться зі стоку. Додати: Налаштування → Профіль → 🔑 Ключі провайдерів.</span>';
    else showKieCost();
  }catch(e){ $('reelKieCost').textContent='⚠ не вдалося отримати перелік моделей: '+e.message; }
}
// 💰 Ціна одного зображення - щоб рішення «міняти провайдера чи ні» приймалось за цифрою.
if($('imgCostBtn')) $('imgCostBtn').onclick=async()=>{
  const box=$('imgCost'); if(box.style.display!=='none'){ box.style.display='none'; return; }
  box.style.display=''; box.innerHTML='<div class="empty">…</div>';
  try{
    const r=await api('/pricing/media?category=image');
    const row=(label,usd,note,ok)=>'<div class="card" style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b>'+esc(label)+'</b><span style="color:var(--brand);font-weight:700">$'+usd.toFixed(3)+'</span></div><div class="hint">'+esc(note)+(ok===false?' · <span style="color:var(--amber)">ключ не доданий</span>':'')+'</div></div>';
    let h='<div style="font-weight:700;font-size:13px;margin-bottom:6px">Підключені зараз</div>';
    h+=r.ours.map(o=>row(o.label,o.usd,o.note,o.available)).join('');
    if(r.kie.length){
      h+='<div style="font-weight:700;font-size:13px;margin:14px 0 6px">Доступні через kie.ai '+(r.kieReady?'':'<span style="color:var(--amber);font-weight:400">(ключ ще не доданий)</span>')+'</div>';
      h+=r.kie.slice(0,12).map(m=>row(m.id,m.usd,m.description||m.unit||'')).join('');
      h+='<div class="hint" style="margin-top:8px">Ціни живі, з прайса kie.ai. Порівнюй із рядками вище: різниця в центах на зображення перетворюється на десятки доларів на сотні постів. Перемикати генерацію зображень на kie.ai поки НЕ будемо - спершу цифри.</div>';
    } else h+='<div class="hint" style="margin-top:8px">Прайс kie.ai зараз недоступний - спробуй пізніше.</div>';
    box.innerHTML=h;
  }catch(e){ box.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
};
if($('vEmoji')) $('vEmoji').onchange=()=>saveSetting('voice_emoji',$('vEmoji').value);
function saveQaGates(){ saveSetting('qa_gates',JSON.stringify({director:!!($('qgDirector')&&$('qgDirector').checked),aiaudit:!!($('qgAiaudit')&&$('qgAiaudit').checked),storytelling:!!($('qgStorytelling')&&$('qgStorytelling').checked)})); }
['qgDirector','qgAiaudit','qgStorytelling'].forEach(id=>{ const el=$(id); if(el) el.onchange=saveQaGates; });
function ensureLangOption(lang){ const sel=$('langSel'); if(!sel||!lang) return; if(![].some.call(sel.options,o=>o.value===lang||o.text===lang)){ const o=document.createElement('option'); o.textContent=lang; sel.appendChild(o); } }
buildTzSel(); if($('tzSel')) $('tzSel').onchange=()=>{ TZ=$('tzSel').value; saveSetting('timezone',TZ); buildTzSel(); try{ if(curView==='publish') loadPublish(); }catch(e){} };
function renderDerived(text){
  const o=$('derivedVoice'); if(!o) return; if(!text){ o.innerHTML=''; return; }
  o.innerHTML='<div class="card" style="margin-top:10px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Запропонований голос (ще не застосовано):</div><div class="post">'+esc(text)+'</div><div class="btnrow"><button class="primary" id="acceptVoice">Прийняти → у Tone of Voice</button></div></div>';
  $('acceptVoice').onclick=()=>{ $('tov').value=text; saveSetting('tone_of_voice',$('tov').value); $('derivedVoice').querySelector('.btnrow').innerHTML='<span style="color:var(--brand);font-size:12px">✓ застосовано до Tone of Voice</span>'; };
}
$('deriveVoiceBtn').onclick=async()=>{ const m=$('voiceMsg'); m.style.color='var(--muted)'; m.textContent='аналізую приклади…'; aiBusy('🧠 Аналізую твої пости і виводжу голос бренду…'); try{ const r=await api('/brand/derive-voice',{method:'POST'}); m.textContent=''; renderDerived(r.derived); flash('Голос виведено ✓'); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }finally{ aiDone(); } };
// ---------- стан прогону ----------
const badge=(n,cls,txt)=>{const b=$('b'+n); if(b){ b.className='badge '+(cls||''); b.innerHTML=txt; }};
const stepEl=n=>$('s'+n);
function applyState(d){
  const byKey=Object.fromEntries((d.steps||[]).map(s=>[s.step_key,s]));
  for(const n of ORDER){ const s=byKey[STEP[n]];
    if(s){ const map={fresh:['ok','готово'],stale:['stale','застаріло'],running:['run','<span class="spin"></span> генерую'],error:['stale','помилка'],idle:['','очікує']};
      const [c,t]=map[s.status]||['','очікує']; badge(n,c,t); stepEl(n).classList.toggle('done',s.status==='fresh'); stepEl(n).classList.toggle('stale',s.status==='stale'||s.status==='error');
    } else { badge(n,'','очікує'); stepEl(n).classList.remove('done','stale'); }
  }
  renderIdeas(d.ideas||[]);
  const byStage={draft:[],toned:[],formatted:[],final:[]};
  (d.posts||[]).forEach(p=>{ if(byStage[p.stage]) byStage[p.stage].push(p); });
  renderPosts('o3',byStage.draft,'Спершу відбери ідеї на кроці 1.');
  renderPosts('o4',byStage.toned);
  renderPosts('o5',byStage.formatted);
  renderFinals(byStage.final);
  loadStudioPosts();
  renderStudioSteps(byKey);
  S.plan=(d.plan||[]).map(p=>({id:p.id,title:p.title,content:p.post_content||p.title,type:p.type,dayOffset:p.day_offset||0}));
  renderLegacyPlan();
  renderSourceCard(d.source);
  const si=$('srcInfo'); if(si) si.innerHTML = d.source ? ('📄 <b>'+esc(d.source.title||'(вставлений текст)')+'</b> · '+(d.source.len||0)+' симв.') : 'Немає активного джерела.';
}
function renderIdeas(ideas){
  const o=$('o1'); if(!o) return;
  if(!ideas.length){ o.innerHTML='<div class="empty">Ідеї з\'являться тут після кроку 1.</div>'; return; }
  o.innerHTML='';
  ideas.forEach(it=>{ const d=document.createElement('div'); d.className='card idea';
    d.innerHTML='<input type="checkbox" '+(it.selected?'checked':'')+' data-id="'+it.id+'"><div style="flex:1"><b>'+esc(it.idea)+'</b>'+(it.angle?'<div class="ang">↳ '+esc(it.angle)+'</div>':'')+'</div>';
    o.appendChild(d); });
  o.querySelectorAll('input').forEach(c=>c.onchange=saveSelection);
}
async function saveSelection(){ if(!runId) return; const ids=[...$('o1').querySelectorAll('input:checked')].map(c=>c.dataset.id); try{ await api('/runs/'+runId+'/ideas/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selectedIds:ids})}); flashSaved(); }catch(e){} }
function renderPosts(oid,posts,emptyTxt){ const o=$(oid); if(!o) return; if(!posts||!posts.length){ o.innerHTML='<div class="empty">'+(emptyTxt||'-')+'</div>'; return; } o.innerHTML=posts.map(p=>'<div class="card post">'+esc(p.content)+'</div>').join(''); }

// ---------- мережі ----------
// клієнтська розбивка на гілку Threads (прев'ю в композері; сервер при публікації ріже точніше через AI)
function clientThreadSplit(text){ const parts=[]; const paras=String(text||'').split(/\n{2,}/).map(p=>p.trim()).filter(Boolean); let cur='';
  for(const p of paras){ if((cur?cur+'\n\n'+p:p).length<=450) cur=cur?cur+'\n\n'+p:p; else { if(cur) parts.push(cur); cur=p.length<=450?p:p.slice(0,449); } }
  if(cur) parts.push(cur); return (parts.length?parts:[String(text||'').slice(0,450)]).slice(0,8); }
// ---------- 🎯 головна ціль («Директор») + 📮 CTA-конфіг («Дистриб'ютор») ----------
const GOALS=[['money','💰 Гроші / продажі'],['leads','📩 Ліди / заявки'],['growth','📈 Зростання аудиторії'],['authority','🎓 Авторитет'],['quality','💎 Якість аудиторії']];
const CTA_TYPES=[['link','🔗 Посилання'],['keyword','🔑 Кодове слово'],['action','👉 Дія']];
let CurGoal='', CtaCfg={};
function renderGoal(){ const box=$('goalChips'); if(!box) return;
  box.innerHTML=GOALS.map(g=>'<div class="cchip'+(CurGoal===g[0]?' on':'')+'" data-g="'+g[0]+'">'+g[1]+'</div>').join('');
  box.querySelectorAll('[data-g]').forEach(c=>c.onclick=async()=>{ CurGoal=CurGoal===c.dataset.g?'':c.dataset.g; await saveSetting('primary_goal',CurGoal); renderGoal(); }); }
function renderCta(){ const box=$('ctaRows'); if(!box) return;
  box.innerHTML=NETS.map(n=>{ const k=n[0],c=CtaCfg[k]||{};
    return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap"><span style="min-width:88px;font-size:13px;font-weight:600">'+n[1]+'</span>'
      +'<select class="txt ctaType" data-net="'+k+'" style="width:auto;padding:7px 9px;display:inline-block">'+CTA_TYPES.map(t=>'<option value="'+t[0]+'"'+((c.type||'link')===t[0]?' selected':'')+'>'+t[1]+'</option>').join('')+'</select>'
      +'<input class="txt ctaVal" data-net="'+k+'" placeholder="https://… / слово ГАЙД / дія" value="'+esc(c.value||'')+'" style="flex:1;min-width:180px;display:inline-block;padding:7px 9px">'
      +'</div>'; }).join(''); }
if($('ctaSave')) $('ctaSave').onclick=async()=>{ const cfg={};
  document.querySelectorAll('.ctaVal').forEach(i=>{ const k=i.dataset.net,v=i.value.trim(); if(v){ const t=document.querySelector('.ctaType[data-net="'+k+'"]'); cfg[k]={type:(t&&t.value)||'link',value:v}; } });
  CtaCfg=cfg; await saveSetting('cta_config',JSON.stringify(cfg)); const m=$('ctaMsg'); if(m){ m.style.color='var(--brand)'; m.textContent='збережено ✓'; setTimeout(()=>m.textContent='',2000); } };
// 📏 формат постів під мережу (channel_format): довжина + нотатка стилю → adaptForChannels
let FmtCfg={};
const FMT_LENS=[['','Стандарт (плейбук мережі)'],['short','Короткий (50-150 симв, 1-2 речення)'],['long','Довгий (ближче до ліміту)']];
function renderFmt(){ const box=$('fmtRows'); if(!box) return;
  box.innerHTML=NETS.map(n=>{ const k=n[0],c=FmtCfg[k]||{};
    return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap"><span style="min-width:88px;font-size:13px;font-weight:600">'+n[1]+'</span>'
      +'<select class="txt fmtLen" data-net="'+k+'" style="width:auto;padding:7px 9px;display:inline-block">'+FMT_LENS.map(t=>'<option value="'+t[0]+'"'+((c.len||'')===t[0]?' selected':'')+'>'+t[1]+'</option>').join('')+'</select>'
      +'<input class="txt fmtNote" data-net="'+k+'" placeholder="стиль для цієї мережі (напр.: одне речення, під тренд, питання в кінці)" value="'+esc(c.note||'')+'" style="flex:1;min-width:180px;display:inline-block;padding:7px 9px">'
      +'</div>'; }).join(''); }
if($('fmtSave')) $('fmtSave').onclick=async()=>{ const cfg={};
  document.querySelectorAll('.fmtLen').forEach(s=>{ const k=s.dataset.net; const noteEl=document.querySelector('.fmtNote[data-net="'+k+'"]'); const note=(noteEl&&noteEl.value.trim())||'';
    if(s.value||note) cfg[k]={len:s.value||'',note}; });
  FmtCfg=cfg; await saveSetting('channel_format',JSON.stringify(cfg)); const m=$('fmtMsg'); if(m){ m.style.color='var(--brand)'; m.textContent='збережено ✓'; setTimeout(()=>m.textContent='',2000); } };
async function loadGoalCta(){ try{ const st=await api('/settings');
    const g=st.find(r=>r.key==='primary_goal'); CurGoal=(g&&g.content)||'';
    const c=st.find(r=>r.key==='cta_config'); try{ CtaCfg=JSON.parse((c&&c.content)||'{}')||{}; }catch(e){ CtaCfg={}; }
    const f=st.find(r=>r.key==='channel_format'); try{ FmtCfg=JSON.parse((f&&f.content)||'{}')||{}; }catch(e){ FmtCfg={}; }
    const t=st.find(r=>r.key==='threads_strategy'); try{ ThStrat=JSON.parse((t&&t.content)||'{}')||{}; }catch(e){ ThStrat={}; }
  }catch(e){} renderGoal(); renderCta(); renderFmt(); renderThStrat(); }
// 🧵 стратегія Threads (threads_strategy JSON {thread:'auto'|'off',cta_min,takes}) - автозбереження
function renderThStrat(){ if($('thStThread')) $('thStThread').checked=ThStrat.thread==='auto';
  if($('thStCta')) $('thStCta').value=String(Number(ThStrat.cta_min)||0);
  if($('thStTakes')) $('thStTakes').value=String(Number(ThStrat.takes)||0); }
async function saveThStrat(){ try{ await saveSetting('threads_strategy',JSON.stringify(ThStrat)); const m=$('thStMsg'); if(m){ m.textContent='збережено ✓'; setTimeout(()=>m.textContent='',1800); } }catch(e){} }
if($('thStThread')) $('thStThread').onchange=(e)=>{ ThStrat.thread=e.target.checked?'auto':'off'; saveThStrat(); };
if($('thStCta')) $('thStCta').onchange=(e)=>{ ThStrat.cta_min=Number(e.target.value)||0; saveThStrat(); };
if($('thStTakes')) $('thStTakes').onchange=(e)=>{ ThStrat.takes=Number(e.target.value)||0; saveThStrat(); };
// 🚀 стартовий пакет Threads: біо-варіанти для копіювання + 2 готові чернетки
if($('thStarter')) $('thStarter').onclick=async()=>{ const b=$('thStarter'); b.disabled=true; aiBusy('🚀 Складаю стартовий пакет Threads…');
  try{ const r=await api('/threads/starter-pack',{method:'POST'});
    const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
    ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px;max-height:85vh;overflow:auto">'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🚀 Стартовий пакет Threads</b><button class="icon" id="spX" style="margin-left:auto">✕</button></div>'
      +'<div style="font-weight:700;font-size:13px;margin-bottom:6px">1. Біо (встав у threads.net → редагувати профіль)</div>'
      +(r.bio||[]).map((t,i)=>'<div class="card" style="margin-bottom:8px;padding:10px 12px;font-size:13px;display:flex;gap:8px;align-items:center"><span style="flex:1">'+esc(t)+'</span><button class="ghost spCopy" data-i="'+i+'" style="flex-shrink:0">⧉</button></div>').join('')
      +'<div style="font-weight:700;font-size:13px;margin:12px 0 6px">2. Пост-знайомство і закріп - уже в чернетках Студії</div>'
      +'<div class="hint">Опублікуй «знайомство» одразу (такі пости залітають і на 0 підписників). «Закріп» опублікуй і закріпи в застосунку Threads (⋯ на пості → «Закріпити в профілі») - у закріпі посилання безпечне.</div>'
      +'<div class="btnrow" style="margin-top:10px"><button class="primary" id="spIntro">✍ Відкрити «знайомство»</button><button class="ghost" id="spPin">📌 Відкрити «закріп»</button></div></div>';
    document.body.appendChild(ov); const close=()=>ov.remove();
    ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#spX').onclick=close;
    ov.querySelectorAll('.spCopy').forEach(c=>c.onclick=()=>{ navigator.clipboard.writeText(r.bio[+c.dataset.i]); c.textContent='✓'; setTimeout(()=>c.textContent='⧉',1500); });
    ov.querySelector('#spIntro').onclick=()=>{ close(); openComposer(r.introId); };
    ov.querySelector('#spPin').onclick=()=>{ close(); openComposer(r.pinnedId); };
    try{ await loadStudioPosts(); }catch(_){ }
  }catch(e){ flash('⚠ '+e.message); } finally{ b.disabled=false; aiDone(); } };
// 💬 реплай-коуч: свіжі коменти під нашими постами + AI-драфт відповіді (Мосері: «відповідай більше, ніж постиш»).
// Викликається з «Сьогодні» (тайл коментарів) і з панелі Threads в Аналітиці.
async function openThreadsComments(btn){ const b=btn||null; if(b) b.disabled=true; aiBusy('💬 Збираю коментарі і пишу драфти відповідей…');
  try{ const r=await api('/threads/comments');
    const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
    const items=r.items||[];
    ov.innerHTML='<div class="modal-card" style="max-width:620px;padding:20px;max-height:85vh;overflow:auto">'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="font-size:16px">💬 Коментарі під твоїми постами</b><button class="icon" id="tcmX" style="margin-left:auto">✕</button></div>'
      +'<div class="hint" style="margin-bottom:10px">Відповідь автора повертає людину в гілку і розганяє пост («відповідай більше, ніж постиш»). Драфт можна правити перед відправкою.</div>'
      +(items.length?items.map((it,i)=>'<div class="card" style="margin-bottom:10px;padding:12px 14px" data-ci="'+i+'">'
        +'<div style="font-size:11px;color:var(--faint);margin-bottom:4px">під постом: '+esc(it.postTitle||'')+'</div>'
        +'<div style="font-size:13px;line-height:1.5"><b>@'+esc(it.username)+':</b> '+esc(it.comment)+'</div>'
        +'<textarea class="txt tcmTxt" rows="2" style="margin-top:8px;font-size:13px">'+esc(it.draft||'')+'</textarea>'
        +'<div class="btnrow" style="margin-top:6px"><button class="primary tcmSend" style="padding:6px 12px;font-size:12.5px">↩ Відповісти</button><span class="tcmMsg" style="font-size:12px;color:var(--muted)"></span></div>'
        +'</div>').join(''):'<div class="empty">'+esc(r.hint||'Свіжих коментарів без відповіді нема. Зазирни після наступної публікації.')+'</div>')
      +'</div>';
    document.body.appendChild(ov); const close=()=>ov.remove();
    ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#tcmX').onclick=close;
    ov.querySelectorAll('[data-ci]').forEach(card=>{ const it=items[+card.dataset.ci];
      card.querySelector('.tcmSend').onclick=async(ev)=>{ const sb=ev.target, m=card.querySelector('.tcmMsg'); const text=card.querySelector('.tcmTxt').value.trim();
        if(!text){ m.textContent='порожньо'; return; } sb.disabled=true; m.textContent='надсилаю…';
        try{ await api('/threads/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commentId:it.commentId,text})});
          m.style.color='var(--brand)'; m.textContent='✓ відповідь у гілці'; card.style.opacity='.55'; }
        catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; sb.disabled=false; } }; });
  }catch(e){ flash('⚠ '+e.message); } finally{ if(b) b.disabled=false; aiDone(); } }
// 🔍 розбір ніші: формули з хітів топ-авторів → правила голосу + ідеї в Банк
if($('thNiche')) $('thNiche').onclick=async()=>{ const b=$('thNiche'); b.disabled=true; aiBusy('🔍 Аналізую хіти твоєї ніші в Threads…');
  try{ const r=await api('/threads/niche-review',{method:'POST'});
    const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
    ov.innerHTML='<div class="modal-card" style="max-width:600px;padding:20px;max-height:85vh;overflow:auto">'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🔍 Формули твоєї ніші</b><button class="icon" id="nrX" style="margin-left:auto">✕</button></div>'
      +(r.patterns||[]).map((p,i)=>'<div class="card" style="margin-bottom:10px;padding:12px 14px"><b style="font-size:13.5px">'+esc(p.name)+'</b>'
        +'<div style="font-size:13px;color:var(--ink2);margin:5px 0;line-height:1.5">'+esc(p.formula)+'</div>'
        +(p.example?'<div style="font-size:12px;color:var(--muted);line-height:1.5">💡 '+esc(p.example)+'</div>':'')
        +'<div class="btnrow" style="margin-top:8px"><button class="ghost nrRule" data-i="'+i+'" style="font-size:12px">💾 Запамʼятати як правило голосу</button></div></div>').join('')
      +(r.ideasAdded?'<div class="hint" style="margin-top:6px">💡 +'+r.ideasAdded+' ідей за цими формулами вже в Банку ідей (Матеріали → 💡 Банк ідей).</div>':'')+'</div>';
    document.body.appendChild(ov); const close=()=>ov.remove();
    ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#nrX').onclick=close;
    ov.querySelectorAll('.nrRule').forEach(c=>c.onclick=async()=>{ const p=r.patterns[+c.dataset.i]; c.disabled=true;
      try{ await api('/voice-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule:p.name+': '+p.formula})}); c.textContent='✓ враховано в генерації'; }
      catch(e){ c.textContent='⚠ '+e.message; } });
  }catch(e){ flash('⚠ '+e.message); } finally{ b.disabled=false; aiDone(); } };
// 🧲 лід-магніти («Магніт»): конкретика з досвіду + кодове слово → CTA Instagram
function renderMagnets(list){ const box=$('lmList'); if(!box) return;
  if(!list||!list.length){ box.innerHTML='<div class="empty">Натисни «Запропонувати» - AI складе 3 конкретні магніти з твого досвіду.</div>'; return; }
  box.innerHTML=list.map((m,i)=>'<div class="card" style="margin-top:8px'+(m.quick?';border-color:var(--brand)':'')+'">'
    +(m.quick?'<span class="ptag" style="color:var(--brand);border-color:var(--brand);font-weight:700;margin-bottom:6px;display:inline-block">⚡ швидкий виграш - зібрати першим</span>':'')
    +'<b style="display:block">'+esc(m.title)+'</b><div style="font-size:13px;color:var(--ink2);margin:5px 0;line-height:1.5">'+esc(m.what)+'</div>'
    +(m.attach?'<div style="font-size:12px;color:var(--muted)">📎 росте з: '+esc(m.attach)+'</div>':'')
    +(m.promo?'<div style="font-size:12px;color:var(--muted)">📣 як тизерити: '+esc(m.promo)+'</div>':'')
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="ptag">🧲 лідоген: '+esc(m.leadgen||'?')+'</span><span class="ptag">🔧 витрати: '+esc(m.effort||'?')+'</span>'
    +(m.keyword?'<span class="ptag">🔑 '+esc(m.keyword)+'</span>':'')
    +'<span style="margin-left:auto;display:flex;gap:6px"><button class="ghost lmBuild" data-i="'+i+'" style="padding:4px 10px;font-size:12px">✍ Зібрати</button>'
    +(m.keyword?'<button class="ghost lmKey" data-kw="'+esc(m.keyword)+'" style="padding:4px 10px;font-size:12px">→ CTA для Instagram</button>':'')+'</span></div></div>').join('');
  box.querySelectorAll('.lmKey').forEach(b=>b.onclick=async()=>{ CtaCfg.instagram={type:'keyword',value:b.dataset.kw}; await saveSetting('cta_config',JSON.stringify(CtaCfg)); renderCta(); flash('Кодове слово «'+b.dataset.kw+'» тепер CTA для Instagram ✓'); });
  box.querySelectorAll('.lmBuild').forEach(b=>b.onclick=async()=>{ const m=list[+b.dataset.i]; if(!confirm('✍ Зібрати «'+m.title+'» повністю? Готовий текст магніта зʼявиться чернеткою в Студії.')) return;
    b.disabled=true; aiBusy('🧲 Збираю лід-магніт повністю…');
    try{ await api('/lead-magnets/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:m.title,what:m.what,keyword:m.keyword})}); flash('Магніт зібрано - шукай 🧲-чернетку в Студії ✓'); try{await loadStudioPosts();}catch(_){} }
    catch(e){ flash('⚠ '+e.message); } finally{ b.disabled=false; aiDone(); } }); }
async function loadMagnets(){ try{ const r=await api('/lead-magnets'); renderMagnets(r.magnets||[]); }catch(e){} }
if($('lmGen')) $('lmGen').onclick=async()=>{ const m=$('lmMsg'); m.textContent='думаю…'; aiBusy('🧲 Складаю лід-магніти з твого досвіду…');
  try{ const r=await api('/lead-magnets',{method:'POST'}); renderMagnets(r.magnets||[]); m.textContent=''; }catch(e){ m.textContent='⚠ '+e.message; } finally{ aiDone(); } };
// 🎞 ПРОТОТИП: сценарій Reels → готове відео (озвучка Azure укр + сток + монтаж). Старт джоби + полінг.
// Вбудований плеєр (window.open блокується браузером після async-полінгу); ▶️ на картці лишається назавжди.
function openVideoModal(fn){ if(!fn) return; const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='95';
  ov.innerHTML='<div class="modal-card" style="max-width:400px;padding:14px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:15px">🎞 Твій рілс</b><a href="/media/'+esc(fn)+'" download style="margin-left:auto;font-size:12.5px">⬇ Завантажити</a><button class="icon" id="vmX">✕</button></div>'
    +'<video src="/media/'+esc(fn)+'" controls autoplay playsinline style="width:100%;max-height:72vh;border-radius:12px;background:#000"></video></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#vmX').onclick=close; }
async function reelVideoRun(id){ aiBusy('🎞 Збираю відео-рілс: озвучка → кліпи → монтаж… (1-3 хв, результат зʼявиться кнопкою ▶️ на картці)');
  try{ await api('/posts/'+id+'/reel-video',{method:'POST'});
    for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,5000));
      let s; try{ s=await api('/posts/'+id+'/reel-video'); }catch(_){ continue; }
      if(s.status==='done'){ try{ await loadStudioPosts(); }catch(_){} flash('Рілс готовий ✓'); openVideoModal(s.filename); return; }
      if(s.status==='error') throw new Error(s.error||'збірка не вдалася');
    }
    throw new Error('час вийшов (5 хв) - онови сторінку: якщо рілс дозбирався, на картці буде ▶️');
  }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }
// вибір довжини рілса перед генерацією сценарію (довжина = скільки бітів напише сценарист)
function askReelLen(title){ return new Promise(res=>{
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='95';
  ov.innerHTML='<div class="modal-card" style="max-width:380px;padding:18px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:15px">'+title+'</b><button class="icon" id="rlX" style="margin-left:auto">✕</button></div>'
    +'<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Яка довжина ролика потрібна?</div>'
    +'<div style="display:flex;flex-direction:column;gap:8px">'
    +[[15,'⚡ До 15 секунд','1 думка, максимум динаміки'],[30,'🎯 До 30 секунд','2-3 думки - найкращі охоплення'],[60,'🎬 45-60 секунд','повний сценарій, 4-5 думок']].map(o=>'<button class="ghost rlOpt" data-s="'+o[0]+'" style="text-align:left;padding:10px 12px"><b>'+o[1]+'</b><div style="font-size:12px;color:var(--muted)">'+o[2]+'</div></button>').join('')
    +'</div></div>';
  document.body.appendChild(ov); const done=(v)=>{ ov.remove(); res(v); };
  ov.addEventListener('click',e=>{ if(e.target===ov) done(0); }); ov.querySelector('#rlX').onclick=()=>done(0);
  ov.querySelectorAll('.rlOpt').forEach(b=>b.onclick=()=>done(+b.dataset.s));
}); }
// 📤 публікація готового рілса: IG Reels / FB відео / YouTube Shorts / TikTok (чернетка)
const REELNETS=[['instagram','Instagram Reels'],['facebook','Facebook'],['youtube','YouTube Shorts'],['tiktok','TikTok (чернетка в застосунку)']];
async function openReelPublish(postId){
  let st={},pub={sent:[]}; try{ st=await api('/channels/status'); }catch(e){} try{ pub=await api('/posts/'+postId+'/reel-publish'); }catch(e){}
  const sent=new Set(pub.sent||[]);
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='95';
  ov.innerHTML='<div class="modal-card" style="max-width:420px;padding:18px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:15px">📤 Опублікувати рілс</b><button class="icon" id="rpX" style="margin-left:auto">✕</button></div>'
    +'<div style="display:flex;flex-direction:column;gap:8px">'
    +REELNETS.map(n=>{ const on=!!st[n[0]], was=sent.has(n[0]);
      return '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;'+(!on||was?'opacity:.55':'')+'"><input type="checkbox" class="rpNet" value="'+n[0]+'"'+(on&&!was?' checked':'')+(!on||was?' disabled':'')+'><span>'+n[1]+'</span><span style="margin-left:auto;font-size:12px;color:var(--muted)">'+(was?'✓ опубліковано':(on?'':'не підключено'))+'</span></label>'; }).join('')
    +'</div>'
    +'<div id="rpMsg" style="font-size:12.5px;color:var(--muted);margin-top:10px;min-height:16px"></div>'
    +'<div class="btnrow" style="margin-top:8px"><button class="primary" id="rpGo" style="flex:1">📤 Опублікувати</button></div>'
    +'<div class="hint" style="margin-top:6px">Instagram обробляє відео до 3 хвилин - зачекай, поки статуси стануть ✓.</div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#rpX').onclick=close;
  ov.querySelector('#rpGo').onclick=async(e)=>{ const nets=[...ov.querySelectorAll('.rpNet:checked')].map(c=>c.value);
    const msg=ov.querySelector('#rpMsg');
    if(!nets.length){ msg.textContent='обери хоча б одну мережу'; return; }
    e.target.disabled=true; msg.textContent='публікую… (IG обробляє відео до 3 хв)';
    try{ await api('/posts/'+postId+'/reel-publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nets})});
      for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,5000));
        let s; try{ s=await api('/posts/'+postId+'/reel-publish'); }catch(_){ continue; }
        if(s.status==='done'){ const rs=s.results||[]; const ok=rs.filter(r=>r.status==='sent').map(r=>r.channel);
          const errs=rs.filter(r=>r.status==='error');
          msg.innerHTML=(ok.length?'✅ Опубліковано: '+ok.join(', ')+'<br>':'')+errs.map(r=>'⚠ '+r.channel+': '+esc(r.error||'помилка')).join('<br>');
          if(!errs.length){ flash('Рілс опубліковано ✓'); setTimeout(close,1800); } else e.target.disabled=false;
          return; }
        if(s.status==='error') throw new Error(s.error||'публікація не вдалася');
      }
      throw new Error('час вийшов - перевір мережі вручну');
    }catch(e2){ msg.textContent='⚠ '+e2.message; e.target.disabled=false; } };
}
// 🔥 «Продовження»: 5 кутів розвитку теми поста → Банк ідей
async function developPost(id){ aiBusy('🔥 Шукаю кути розвитку теми…');
  try{ const r=await api('/posts/'+id+'/develop',{method:'POST'}); const ideas=r.ideas||[];
    if(!ideas.length){ flash('не вийшло - спробуй ще раз'); return; }
    alert('🔥 Кути розвитку додано в Банк ідей:\n\n'+ideas.map((x,i)=>(i+1)+'. '+x.idea+(x.angle?' ('+x.angle+')':'')).join('\n')+'\n\nЗнайдеш їх: Створення → Матеріали → 💡 Банк ідей.');
    try{ await loadMaterials(); }catch(_){}
  }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }
// 🎯 вердикт Директора на чернетці: веде до цілі / частково / ні + правка в 1 клік
// 🧲 «Магніт під ТЕМУ»: магніти саме під цей пост + вплетення CTA в текст
async function postMagnet(id){ aiBusy('🧲 Складаю лід-магніти під тему поста…');
  let mags=[]; try{ const r=await api('/posts/'+id+'/lead-magnet',{method:'POST'}); mags=r.magnets||[]; }catch(e){ flash('⚠ '+e.message); aiDone(); return; } finally{ aiDone(); }
  if(!mags.length){ flash('Не вдалося скласти магніти'); return; }
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🧲 Магніти під цю тему</b><button class="icon" id="pmX" style="margin-left:auto">✕</button></div>'
    +mags.map((m,i)=>'<div class="card" style="margin-bottom:8px'+(m.quick?';border-color:var(--brand)':'')+'">'+(m.quick?'<span class="ptag" style="color:var(--brand);border-color:var(--brand);font-weight:700">⚡ швидкий виграш</span> ':'')+'<b>'+esc(m.title)+'</b>'
      +'<div style="font-size:12.5px;color:var(--ink2);margin:4px 0;line-height:1.45">'+esc(m.what)+'</div>'
      +'<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="ptag">🧲 '+esc(m.leadgen||'?')+'</span><span class="ptag">🔧 '+esc(m.effort||'?')+'</span>'+(m.keyword?'<span class="ptag">🔑 '+esc(m.keyword)+'</span>':'')
      +'<span style="margin-left:auto;display:flex;gap:6px"><button class="ghost pmBuild" data-i="'+i+'" style="padding:4px 10px;font-size:12px">✍ Зібрати</button>'+(m.keyword?'<button class="ghost pmCta" data-i="'+i+'" style="padding:4px 10px;font-size:12px">→ вплести CTA в пост</button>':'')+'</span></div></div>').join('')
    +'</div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#pmX').onclick=close;
  ov.querySelectorAll('.pmBuild').forEach(b=>b.onclick=async()=>{ const m=mags[+b.dataset.i]; b.disabled=true; aiBusy('🧲 Збираю магніт повністю…');
    try{ await api('/lead-magnets/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:m.title,what:m.what,keyword:m.keyword})}); close(); flash('Магніт зібрано - 🧲-чернетка в Студії ✓'); try{await loadStudioPosts();}catch(_){} }
    catch(e){ flash('⚠ '+e.message); b.disabled=false; } finally{ aiDone(); } });
  ov.querySelectorAll('.pmCta').forEach(b=>b.onclick=async()=>{ const m=mags[+b.dataset.i]; b.disabled=true; aiBusy('📮 Вплітаю CTA магніта в пост…');
    try{ await api('/posts/'+id+'/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruction:'Допиши наприкінці поста ОДИН органічний CTA: запропонуй безкоштовний матеріал «'+m.title+'» за кодове слово '+(m.keyword||'')+' у коментарях/дірект. Один заклик = одна дія. Решту поста не змінюй.'})}); close(); flash('CTA вплетено в пост ✓'); try{await loadStudioPosts();}catch(_){} }
    catch(e){ flash('⚠ '+e.message); b.disabled=false; } finally{ aiDone(); } });
}
async function directorCheck(id){ aiBusy('🎯 Директор перевіряє пост на відповідність цілі…');
  try{ const r=await api('/posts/'+id+'/director',{method:'POST'});
    const E={yes:'✅ ВЕДЕ ДО ЦІЛІ',partial:'⚠ ЧАСТКОВО ВЕДЕ',no:'✖ НЕ ВЕДЕ ДО ЦІЛІ'};
    const trustLine=r.trust?('\n'+(r.trust==='builds'?'🤝 Будує довіру':'💸 Витрачає довіру (просить, не давши цінності)')+(r.trustWhy?': '+r.trustWhy:'')):'';
    const msg=(E[r.verdict]||r.verdict)+trustLine+'\n\n'+(r.reason||'');
    if(r.verdict!=='yes'&&(r.fix||r.sharper)){ aiDone();
      // спершу пропонуємо ГОСТРІШУ версію (готовий переписаний початок), потім - правку-інструкцію
      if(r.sharper&&confirm(msg+'\n\n⚡ ВЕРСІЯ ГОСТРІША (новий початок поста):\n«'+r.sharper+'»\n\nЗамінити перший абзац цією версією?')){
        const full=await api('/posts/'+id+'/full'); const parts=(full.content||'').split('\n\n'); parts[0]=r.sharper;
        await api('/posts/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:parts.join('\n\n')})});
        await loadStudioPosts(); flash('Початок загострено під ціль ✓'); }
      else if(r.fix&&confirm('Правка Директора: '+r.fix+'\n\nЗастосувати (перепише пост)?')){
        aiBusy('⚡ Загострюю пост під ціль…');
        await api('/posts/'+id+'/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruction:r.fix})});
        await loadStudioPosts(); flash('Пост загострено під ціль ✓'); } }
    else alert(msg);
  }catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }
// 📖 Сторителлінг-редактор: оцінка поста як історії (12 прийомів) + до 5 правок «Було→Пропоную→Чому»
async function storytellingCheck(id){ aiBusy('📖 Оцінюю пост як історію…');
  let r; try{ r=await api('/posts/'+id+'/storytelling',{method:'POST'}); }catch(e){ flash('⚠ '+e.message); aiDone(); return; } finally{ aiDone(); }
  const fixes=r.fixes||[], checklist=r.checklist||[];
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  ov.innerHTML='<div class="modal-card" style="max-width:600px;max-height:80vh;overflow:auto;padding:20px">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="font-size:16px">📖 Сторителлінг</b>'
    +'<span class="ptag" style="margin-left:auto;font-weight:700">'+esc(String(r.score||'?'))+'/10</span><button class="icon" id="stX">✕</button></div>'
    +'<div style="font-size:13px;color:var(--ink2);line-height:1.5;margin-bottom:14px">'+esc(r.verdict||'')+'</div>'
    +(fixes.length?fixes.map(f=>'<div class="card" style="margin-bottom:8px"><b style="font-size:12.5px;color:var(--brand)">🔹 '+esc(f.technique||'')+'</b>'
      +'<div style="font-size:12.5px;color:var(--muted);margin-top:5px"><b>Було:</b> «'+esc(f.was||'')+'»</div>'
      +'<div style="font-size:12.5px;margin-top:4px"><b>Пропоную:</b> «'+esc(f.suggest||'')+'»</div>'
      +'<div style="font-size:11.5px;color:var(--faint);margin-top:4px">'+esc(f.why||'')+'</div></div>').join('')
      :'<div class="empty" style="padding:10px 0">Правок нема - текст уже сильний як історія.</div>')
    +(checklist.length?'<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;margin:12px 0;font-size:12px;color:var(--muted)">'
      +checklist.map(c=>'<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid var(--line)"><span>'+esc(c.name||'')+'</span><span>'+esc(c.status||'—')+'</span></div>').join('')
      +'</div>':'')
    +(fixes.length?'<button class="primary" id="stApply" style="width:100%;margin-top:8px">✍ Застосувати правки (перепише пост)</button>':'')
    +'</div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#stX').onclick=close;
  const apBtn=ov.querySelector('#stApply'); if(apBtn) apBtn.onclick=async()=>{ apBtn.disabled=true; close(); aiBusy('✍ Переписую пост із правками сторителлінгу…');
    const instruction='Застосуй ці правки сторителлінгу:\n'+fixes.map((f,i)=>(i+1)+'. '+f.technique+': '+f.suggest).join('\n');
    try{ await api('/posts/'+id+'/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruction})}); await loadStudioPosts(); flash('Історію підсилено ✓'); }
    catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }; }
async function loadChanStatus(){ try{ ChanStatus=await api('/channels/status'); }catch(e){ ChanStatus={}; } }
function chanDots(ch){ if(!ch) return ''; return NETS.filter(n=>ch[n[0]]&&ch[n[0]].on).map(n=>'<span class="cdot" title="'+n[1]+'" style="background:var('+NETVAR[n[0]]+')"><svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><path d="'+NETICON[n[0]]+'"></path></svg></span>').join(''); }
function chanIcons(ch){ if(!ch) return ''; const I={telegram:'✈️',instagram:'📸',facebook:'📘',threads:'🧵',linkedin:'💼'}; return Object.keys(I).filter(k=>ch[k]&&ch[k].on).map(k=>I[k]).join(''); }
// мережі, куди пост УЖЕ опубліковано: ті самі кольорові кружечки + ✓ (youtube/tiktok - для рілсів)
// іконки мереж, куди пост поїхав. links[мережа] (з /posts/studio) робить іконку ПОСИЛАННЯМ на
// живий пост - раніше побачити, «як воно там виглядає», можна було лише знайшовши пост руками
function sentDots(sent,links){ const EXTRA={youtube:['YouTube','#FF0000','M12 4c7 0 9 1 9 8s-2 8-9 8-9-1-9-8 2-8 9-8zm-2 4.5v7l6-3.5-6-3.5z'],tiktok:['TikTok','#010101','M16 3c.4 2.6 2 4.2 4.6 4.5v3c-1.8 0-3.4-.6-4.6-1.5v6.8c0 3.9-2.8 6.2-6.1 6.2A5.9 5.9 0 013 16.2c0-3.5 2.7-6 6.4-5.8v3.1c-1.8-.3-3.3.8-3.3 2.6 0 1.7 1.3 2.9 2.9 2.9 1.8 0 3-1.3 3-3.3V3h4z']};
  return (sent||[]).map(k=>{ const n=NETS.find(x=>x[0]===k); const name=n?n[1]:(EXTRA[k]?EXTRA[k][0]:k); const bg=n?('var('+NETVAR[k]+')'):(EXTRA[k]?EXTRA[k][1]:'var(--muted)'); const path=NETICON[k]||(EXTRA[k]&&EXTRA[k][2])||'';
    const url=links&&links[k];
    const inner='<svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><path d="'+path+'"></path></svg>';
    if(url) return '<a class="cdot" href="'+esc(url)+'" target="_blank" rel="noopener" title="Відкрити пост у '+esc(name)+'" style="background:'+bg+';text-decoration:none" onclick="event.stopPropagation()">'+inner+'</a>';
    return '<span class="cdot" title="Опубліковано: '+esc(name)+'" style="background:'+bg+'">'+inner+'</span>'; }).join('')
    +((sent||[]).length?'<span style="font-size:11px;color:var(--ok,#22a06b);font-weight:700;margin-left:2px">✓</span>':'');
}
function statusPill(rv){ if(rv==='approved') return ['Затверджено','sp-ok']; if(rv==='needs_work') return ['Доопрацювати','sp-warn']; return ['Готово до перегляду','sp-soft']; }

// ---------- фінальні пости: Конвеєр (компактно) / Студія / Інбокс ----------
function renderFinals(posts){
  const o=$('o6'); if(!o) return; const vis=(posts||[]).filter(p=>p.review!=='archived');
  if(!vis.length){ o.innerHTML='<div class="empty">Готові пости зʼявляться тут - повний перегляд у «Студії».</div>'; return; }
  o.innerHTML=vis.map(p=>'<div class="card post">'+esc((p.content||'').slice(0,200))+((p.content||'').length>200?'…':'')+'</div>').join('')+'<div class="hint" style="margin-top:8px">'+vis.length+' постів - відредагуй і затвердь у «Студії».</div>';
}
async function saveContent(id,v){ try{ await api('/posts/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:v})}); flashSaved(); }catch(e){} }
let StudioFilter='all', StudioRubric='', StudioOrigin='', StudioFormat='';
const INTENT_META={awareness:['🌱','знайомство','цінність новій аудиторії, без продажу'],nurture:['🤝','прогрів','будує довіру, мʼякий заклик'],sale:['💰','продаж','прямий оффер за сходами']};
const ORIGIN_LABEL={mcp:'🔌 з Claude',bot:'🤖 з бота',manual:'✍️ вручну',rss:'📡 RSS',fireflies:'🎙 транскрипт',grain:'🎙 транскрипт',meetgeek:'🎙 транскрипт',brand:'✨ з бренду',gdrive:'📁 Drive',plan:'📅 з плану',diary:'📔 щоденник',takes:'🧵 тейк',idea:'💡 з ідеї',meeting:'🎤 зустріч'};
const SelPosts=new Set(); // масові дії
// глобальний список усіх фінальних постів воркспейсу (НЕ привʼязаний до активного джерела/прогону)
async function loadStudioPosts(){ try{ Finals=(await api('/posts/studio'))||[]; }catch(e){} SelPosts.clear(); renderStudio(); renderInbox(); if(typeof updateCounts==='function') updateCounts(); }
function renderStudio(){
  const grid=$('studioGrid'); if(!grid) return;
  const all=Finals;
  // опубліковані АВТОМАТИЧНО ховаються з робочих вкладок (вони - історія, не робота):
  // живуть лише у вкладці «✈️ Опубліковані» (фідбек Олега: «висять, створюють шум»)
  const isSent=(p)=>!!(p.sent&&p.sent.length);
  const act=all.filter(p=>!isSent(p));
  const appr=act.filter(p=>p.review==='approved').length; const rev=act.length-appr;
  const pub=all.length-act.length;
  const tc=$('toCalendar'); if(tc){ tc.style.display=appr>0?'':'none'; tc.textContent='До календаря ('+appr+') →'; }
  const ft=$('studioFilters'); if(ft){ ft.innerHTML=[['all','Активні',act.length],['review','На перегляд',rev],['approved','Затверджені',appr],['published','✈️ Опубліковані',pub]].map(f=>'<div class="ftab'+(StudioFilter===f[0]?' on':'')+'" data-sf="'+f[0]+'">'+f[1]+' <span style="opacity:.6">'+f[2]+'</span></div>').join(''); ft.querySelectorAll('[data-sf]').forEach(t=>t.onclick=()=>{ StudioFilter=t.dataset.sf; renderStudio(); }); }
  // рубрика × джерело - компактні дропдауни (було: два ряди чіпів = візуальний шум)
  const tf=$('studioTagFilters');
  if(tf){
    const rubset=[...new Set(all.map(p=>p.rubric).filter(Boolean))];
    const orgset=[...new Set(all.map(p=>p.source_origin).filter(Boolean))];
    const fmtset=FMT_KEYS.filter(k=>all.some(p=>(p.format||'post')===k));
    tf.innerHTML=(rubset.length?'<select id="stRubSel" class="txt" style="width:auto;padding:6px 9px;display:inline-block;font-size:12.5px'+(StudioRubric?';border-color:var(--brand);color:var(--brand)':'')+'"><option value="">🏷 Всі рубрики</option>'+rubset.map(r=>'<option value="'+esc(r)+'"'+(StudioRubric===r?' selected':'')+'>🏷 '+esc(r)+'</option>').join('')+'</select>':'')
      // фільтр за форматом - лише коли форматів реально більше одного (не додаємо шум тим, хто робить тільки пости)
      +(fmtset.length>1?'<select id="stFmtSel" class="txt" style="width:auto;padding:6px 9px;display:inline-block;font-size:12.5px'+(StudioFormat?';border-color:var(--brand);color:var(--brand)':'')+'"><option value="">🎨 Всі формати</option>'+fmtset.map(k=>'<option value="'+k+'"'+(StudioFormat===k?' selected':'')+'>'+FMT_META[k][0]+' '+esc(FMT_META[k][1])+'</option>').join('')+'</select>':'')
      +(orgset.length>1?'<select id="stOrgSel" class="txt" style="width:auto;padding:6px 9px;display:inline-block;font-size:12.5px'+(StudioOrigin?';border-color:var(--brand);color:var(--brand)':'')+'"><option value="">📦 Всі джерела</option>'+orgset.map(o=>'<option value="'+esc(o)+'"'+(StudioOrigin===o?' selected':'')+'>'+(ORIGIN_LABEL[o]||esc(o))+'</option>').join('')+'</select>':'');
    const rs=$('stRubSel'); if(rs) rs.onchange=(e)=>{ StudioRubric=e.target.value; renderStudio(); };
    const fs=$('stFmtSel'); if(fs) fs.onchange=(e)=>{ StudioFormat=e.target.value; renderStudio(); };
    const os=$('stOrgSel'); if(os) os.onchange=(e)=>{ StudioOrigin=e.target.value; renderStudio(); };
  }
  let show=act; if(StudioFilter==='review') show=act.filter(p=>p.review!=='approved'); if(StudioFilter==='approved') show=act.filter(p=>p.review==='approved');
  if(StudioFilter==='published') show=all.filter(isSent);
  if(StudioRubric) show=show.filter(p=>p.rubric===StudioRubric);
  if(StudioFormat) show=show.filter(p=>(p.format||'post')===StudioFormat);
  if(StudioOrigin) show=show.filter(p=>p.source_origin===StudioOrigin);
  renderBulkBar();
  if(!show.length){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">Поки порожньо. Додай джерело у «Джерела» і натисни «Згенерувати».</div>'; return; }
  grid.innerHTML=show.map(p=>{ const isPub=!!(p.sent&&p.sent.length);
    const sp=isPub?['✈️ Опубліковано','sp-ok']:statusPill(p.review); const ap=p.review==='approved'; const sel=SelPosts.has(p.id);
    // шапка: опублікований пост показує мережі, КУДИ реально поїхав (✓); інші - обрані канали
    const dots=isPub?sentDots(p.sent,p.links):chanDots(p.channels);
    const im=INTENT_META[p.intent];
    // формат показуємо бейджем лише коли він НЕ звичайний пост (інакше бейдж на кожній картці = шум)
    const fm=FMT_META[p.format]; const fmTag=(p.format&&p.format!=='post'&&fm)?'<span class="ptag" style="color:var(--brand);border-color:var(--brand)" title="Формат: '+fm[2]+'">'+fm[0]+' '+fm[1].toLowerCase()+'</span>':'';
    const tags=fmTag+(im?'<span class="ptag" title="Намір поста: '+im[2]+'">'+im[0]+' '+im[1]+'</span>':'')+(p.rubric?'<span class="ptag">🏷 '+esc(p.rubric)+'</span>':'')+(p.source_origin&&p.source_origin!=='manual'?'<span class="ptag">'+(ORIGIN_LABEL[p.source_origin]||esc(p.source_origin))+'</span>':'');
    // 🛡 бейджі автоперевірок (settings_block.qa_gates) - показуються ЛИШЕ якщо перевірка знайшла слабке місце
    const qa=p.qa||{}; const qaBad=[];
    if(qa.director&&qa.director!=='yes') qaBad.push(['qad','🎯 '+(qa.director==='no'?'Директор: не веде до цілі':'Директор: частково веде до цілі')]);
    if(qa.aiaudit>0) qaBad.push(['qaa','🔍 AI-сліди: '+qa.aiaudit]);
    if(qa.storytelling!=null&&qa.storytelling<7) qaBad.push(['qas','📖 Сторителлінг: '+qa.storytelling+'/10']);
    const qaHtml=qaBad.length?'<div style="display:flex;gap:5px;flex-wrap:wrap;padding:0 14px 4px">'+qaBad.map(b=>'<span class="ptag qabadge" data-qa="'+b[0]+'" style="cursor:pointer;color:var(--amber);border-color:var(--amber)">'+b[1]+'</span>').join('')+'</div>':'';
    return '<div class="pcard'+(ap?' appr':'')+(sel?' selc':'')+'" data-post="'+p.id+'">'
      +'<div class="pcard-h"><input type="checkbox" class="psel" '+(sel?'checked':'')+' title="Обрати для масових дій">'+dots+'<span class="statuspill '+sp[1]+'" style="margin-left:auto">'+sp[0]+'</span></div>'
      +(p.media_filename?'<div class="pcard-img" data-a="image" style="cursor:pointer" title="Редагувати зображення"><img loading="lazy" src="/thumb/'+esc(p.media_filename)+'" onerror="this.onerror=null;this.src=\'/media/'+esc(p.media_filename)+'\'"></div>':'')
      +'<div class="pcard-text pcontent" contenteditable="true">'+esc(p.content)+'</div>'
      +(tags?'<div style="display:flex;gap:5px;flex-wrap:wrap;padding:0 14px 4px">'+tags+'</div>':'')
      +qaHtml
      +'<div class="pcard-f"><span class="chars">'+(p.content||'').replace(/\n/g,'').length+' симв.</span><span style="flex:1"></span>'
        +(PRO&&p.reel_video?'<button class="icon" data-a="reelplay" data-rv="'+esc(p.reel_video)+'" title="▶ Дивитися зібраний рілс">▶️</button>':'')
        +(!isPub?'<button class="icon" data-a="del" title="Видалити пост" style="color:var(--danger)">🗑</button>':'')
        +'<button class="icon" data-a="menu" title="Ще: AI-інструменти й дії">⋯</button>'
        +'<button class="ghost" data-a="composer" title="Редагувати, запланувати чи опублікувати" style="padding:7px 12px;font-size:12.5px;font-weight:700">✍ Редагувати</button>'
        +'<button class="approve'+(ap?' on':'')+'" data-a="approve"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>'+(ap?'Затверджено':'Затвердити')+'</button>'
      +'</div></div>';
  }).join('');
  grid.querySelectorAll('.pcard').forEach(card=>{ const id=card.dataset.post; const cont=card.querySelector('.pcontent');
    cont.addEventListener('blur',()=>saveContent(id,cont.textContent));
    const cb=card.querySelector('.psel'); if(cb) cb.onchange=()=>{ cb.checked?SelPosts.add(id):SelPosts.delete(id); card.classList.toggle('selc',cb.checked); renderBulkBar(); };
    card.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{ const a=b.dataset.a; if(a==='composer'){ openComposer(id); return; } if(a==='image'){ openImageEditor(id); return; } if(a==='atomize'){ openAtomize(id); return; } if(a==='director'){ directorCheck(id); return; } if(a==='develop'){ developPost(id); return; } if(a==='magnet'){ postMagnet(id); return; } if(a==='reelvideo'){ reelVideoRun(id); return; } if(a==='reelplay'){ openVideoModal(b.dataset.rv); return; } if(a==='reelpub'){ openReelPublish(id); return; }
      if(a==='menu'){ const p=Finals.find(x=>x.id===id); if(p) openCardMenu(p,b,card); return; }
      if(a==='del'){ deletePost(id); return; }
      postAction(card,id,a); });
    card.querySelectorAll('.qabadge').forEach(b=>b.onclick=()=>{ const qa=b.dataset.qa; if(qa==='qad') directorCheck(id); else if(qa==='qas') storytellingCheck(id); else openComposer(id); });
  });
}
// панель масових дій (зʼявляється коли є обрані пости)
function renderBulkBar(){
  let bar=$('bulkBar');
  if(!SelPosts.size){ if(bar) bar.remove(); return; }
  if(!bar){ bar=document.createElement('div'); bar.id='bulkBar';
    bar.style.cssText='position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:55;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:10px 14px;display:flex;gap:10px;align-items:center';
    document.body.appendChild(bar); }
  bar.innerHTML='<b style="font-size:13px">Обрано: '+SelPosts.size+'</b>'
    +'<button class="primary" id="bulkApprove" style="padding:7px 12px">✓ Затвердити всі</button>'
    +'<button class="ghost" id="bulkDelete" style="padding:7px 12px;color:var(--danger)">🗑 Видалити</button>'
    +'<button class="icon" id="bulkClear" title="Зняти вибір">✕</button>';
  $('bulkApprove').onclick=()=>bulkReview('approved');
  $('bulkDelete').onclick=bulkDelete;
  $('bulkClear').onclick=()=>{ SelPosts.clear(); renderStudio(); };
}
// масове видалення: опублікованим сервер відмовляє (409) - вони пропускаються з поясненням
async function bulkDelete(){
  const ids=[...SelPosts]; if(!ids.length) return;
  if(!confirm('Видалити '+ids.length+' постів назавжди? Опубліковані пропущу - вони лишаються як історія.')) return;
  aiBusy('🗑 Видаляю '+ids.length+' постів…');
  let ok=0, skipped=0;
  for(const id of ids){ try{ await api('/posts/'+id,{method:'DELETE'}); ok++; }catch(e){ skipped++; } }
  SelPosts.clear(); await loadStudioPosts(); aiDone();
  flash('Видалено: '+ok+(skipped?(' · пропущено опублікованих: '+skipped):''));
}
async function bulkReview(status){
  const ids=[...SelPosts]; if(!ids.length) return;
  aiBusy((status==='approved'?'✓ Затверджую':'🗄 Архівую')+' '+ids.length+' постів…');
  try{
    const res=await Promise.allSettled(ids.map(id=>api('/posts/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})})));
    const ok=res.filter(r=>r.status==='fulfilled').length;
    SelPosts.clear(); await loadStudioPosts(); try{loadGuide(true);}catch(e){} flash('Готово: '+ok+'/'+ids.length);
  }finally{ aiDone(); }
}
// редактор зображення поста = той самий двокроковий фото-інструмент, що і в композері
async function openImageEditor(postId, onDone){
  openPhotoTool(postId, '', (fn)=>{ if(onDone)onDone(fn); try{loadStudioPosts();}catch(e){} });
}
async function loadImageProvider(){ const sel=$('imgProv'); if(!sel) return; try{ const c=await api('/integrations/images'); const A=c.available||{}; const opts=[['openai','OpenAI gpt-image-1',A.openai],['fal','FLUX schnell (fal.ai)',A.fal],['gemini','Nano Banana (Gemini)',A.gemini]]; sel.innerHTML=opts.map(o=>'<option value="'+o[0]+'"'+(c.provider===o[0]?' selected':'')+(o[2]?'':' disabled')+'>'+o[1]+(o[2]?'':' - нема ключа')+'</option>').join(''); sel.onchange=async()=>{ try{ await api('/integrations/images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:sel.value})}); flashSaved(); }catch(e){ flash('⚠ '+e.message); } }; }catch(e){} }
// 🎙 Кому віддати перевагу в розшифровці голосових. «Авто» = Deepgram, якщо ключ є, інакше Whisper.
// Провайдер без ключа лишається видимим, але заблокованим - інакше незрозуміло, чому вибору немає.
async function loadSttProvider(){
  const sel=$('sttProv'); if(!sel) return;
  try{
    const c=await api('/integrations/stt'); const A=c.available||{};
    const best=A.deepgram?'Deepgram':(A.whisper?'Whisper':'нема ключів');
    const opts=[['auto','Авто ('+best+' першим)',true],['deepgram','Deepgram',A.deepgram],['whisper','Whisper (OpenAI)',A.whisper]];
    sel.innerHTML=opts.map(o=>'<option value="'+o[0]+'"'+(c.provider===o[0]?' selected':'')+(o[2]?'':' disabled')+'>'+o[1]+(o[2]?'':' - нема ключа')+'</option>').join('');
    sel.onchange=async()=>{ try{ await api('/integrations/stt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:sel.value})}); flashSaved(); }catch(e){ flash('⚠ '+e.message); } };
  }catch(e){}
}
let InboxSel=null;
function renderInbox(){
  const list=$('inboxList'), det=$('inboxDetail'); if(!list||!det) return;
  const posts=Finals;
  if(!posts.length){ list.innerHTML='<div class="empty">Порожньо.</div>'; det.innerHTML='<div class="empty" style="margin:auto">Згенеруй пости.</div>'; return; }
  if(!InboxSel||!posts.some(p=>p.id===InboxSel)) InboxSel=posts[0].id;
  list.innerHTML=posts.map(p=>{ const on=p.id===InboxSel; const sp=statusPill(p.review);
    return '<div class="inrow'+(on?' on':'')+'" data-id="'+p.id+'"><div>'+chanDots(p.channels)+'</div><div class="inrow-t">'+esc((p.content||'').split('\n')[0].slice(0,90))+'</div><div class="statuspill '+sp[1]+'" style="margin-top:6px;display:inline-block">'+sp[0]+'</div></div>';
  }).join('');
  list.querySelectorAll('[data-id]').forEach(r=>r.onclick=()=>{ InboxSel=r.dataset.id; renderInbox(); });
  const p=posts.find(x=>x.id===InboxSel); const sp=statusPill(p.review); const ap=p.review==='approved';
  det.innerHTML='<div class="indet-h">'+chanDots(p.channels)+'<span class="statuspill '+sp[1]+'" style="margin-left:auto">'+sp[0]+'</span></div>'
    +'<div class="indet-text pcontent" contenteditable="true">'+esc(p.content)+'</div>'
    +'<div class="indet-f"><span class="chars">'+(p.content||'').replace(/\n/g,'').length+' символів</span><button data-a="regen">↻ Переробити</button><button class="primary" data-a="composer">📣 Опублікувати</button><button class="approve'+(ap?' on':'')+'" data-a="approve">✓ '+(ap?'Затверджено':'Затвердити')+'</button></div>';
  const cont=det.querySelector('.pcontent'); cont.addEventListener('blur',()=>saveContent(p.id,cont.textContent));
  det.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{ const a=b.dataset.a; if(a==='composer'){ openComposer(p.id); return; } postAction(det,p.id,a); });
}
const STEPNAMES={1:'Витяг ідей',3:'Чорнові пости',4:'Tone of Voice',5:'Формат під канали',6:'Де-AI',7:'Контент-план'};
function renderStudioSteps(byKey){
  const o=$('studioSteps'); if(!o) return;
  o.innerHTML=ORDER.map((n,i)=>{ const s=byKey[STEP[n]]; const done=s&&s.status==='fresh'; const run=s&&s.status==='running';
    return '<div class="hstep"><span class="hdot'+(done?' done':'')+(run?' run':'')+'">'+(i+1)+'</span><div class="hstep-t">'+STEPNAMES[n]+'</div><button class="icon" data-rerun="'+n+'" title="Перезапустити">↻</button></div>';
  }).join('');
  o.querySelectorAll('[data-rerun]').forEach(b=>b.onclick=()=>run(+b.dataset.rerun));
}
function renderSourceCard(src){
  const o=$('srcCard'); if(!o) return;
  if(!src){ o.innerHTML='<div class="empty">Немає активного джерела. Додай у «Джерела».</div>'; return; }
  o.innerHTML='<div style="font-weight:600;font-size:14px;margin-bottom:5px">'+esc(src.title||'(вставлений текст)')+'</div>'
    +'<div style="font-size:13px;color:var(--muted);line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">'+esc(src.snippet||'')+'…</div>'
    +'<div style="margin-top:9px;font-size:12px;color:var(--faint)">'+(src.len||0)+' симв.</div>'
    +'<button id="srcChange" style="width:100%;margin-top:11px">Змінити джерело</button>';
  o.querySelector('#srcChange').onclick=()=>go('sources');
}
function renderCountChips(){ const o=$('countChips'); if(!o) return; const cur=+($('ideaCount').value)||6;
  o.innerHTML=[3,6,9,12].map(n=>'<div class="cchip'+(n===cur?' on':'')+'" data-n="'+n+'">'+n+'</div>').join('');
  o.querySelectorAll('[data-n]').forEach(c=>c.onclick=()=>{ $('ideaCount').value=c.dataset.n; renderCountChips(); });
}
// видалення поста (замінило архів): опублікованим сервер відмовить - вони історія й аналітика
async function deletePost(id, after){ if(!confirm('Видалити пост назавжди? Це не архів - повернути буде неможливо.')) return;
  try{ await api('/posts/'+id,{method:'DELETE'}); flash('Пост видалено'); if(after)after(); await loadStudioPosts(); try{await loadPublish();}catch(e){} }
  catch(e){ alert('⚠ '+e.message); } }
// ⋯-меню картки: 4 часті дії одразу, решта AI-інструментів - за «🧰 Більше інструментів»; на мобільному - шторка знизу
function openCardMenu(p, btn, card){
  document.querySelectorAll('.cardmenu,.cardmenu-bg').forEach(x=>x.remove());
  const id=p.id, isReelScript=String(p.content||'').startsWith('🎬');
  // часті дії - одразу видимі
  const freq=[
    ['↻','Переробити…','вкажи, що саме змінити - голос збережеться',()=>postAction(card,id,'regen')],
    ['🎨','Зображення до поста','згенерувати чи замінити фото',()=>openImageEditor(id)],
    ['🔥','5 кутів продовження','ідеї-продовження теми → Банк ідей',()=>developPost(id)],
    ['⧉','Копіювати текст','',()=>postAction(card,id,'copy')],
  ];
  // розширені - у складеному блоці
  const G=[];
  G.push(['Покращити',[['🎯','Перевірка Директора','чи веде пост до твоєї цілі',()=>directorCheck(id)],['📖','Сторителлінг','12 прийомів - чи чіпляє і тримає до кінця',()=>storytellingCheck(id)]]]);
  const dev=[['🧲','Лід-магніт під тему','що віддати аудиторії за контакт',()=>postMagnet(id)]];
  if((p.sent||[]).includes('threads')){
    dev.push(['🔁','Повторити хіт (через 48 год)','дубль зі свіжим гачком - покажеться іншій аудиторії',()=>repeatHit(id)]);
    dev.push(['🧵','Розгорнути в гілку','тейк → повний пост, поїде гілкою в Threads',()=>expandToThread(id)]);
  }
  if(PRO) dev.push(['♻️','Розтиражувати під канали','варіанти під кожну мережу (COPE)',()=>openAtomize(id)]);
  G.push(['Розвинути',dev]);
  if(PRO&&(isReelScript||p.reel_video)){ const reel=[];
    if(isReelScript) reel.push(['🎞','Зібрати відео','озвучка + кліпи + монтаж, 1-3 хв',()=>reelVideoRun(id)]);
    if(p.reel_video) reel.push(['▶️','Дивитися рілс','',()=>openVideoModal(p.reel_video)],['📤','Опублікувати рілс','Instagram / Facebook / YouTube / TikTok',()=>openReelPublish(id)]);
    G.push(['Рілс',reel]); }
  const item=(it,attrs)=>'<button class="cm-i" '+attrs+'><span style="width:22px;text-align:center">'+it[0]+'</span><span style="flex:1"><span style="display:block">'+it[1]+'</span>'+(it[2]?'<span style="display:block;font-size:11px;color:var(--faint)">'+it[2]+'</span>':'')+'</span></button>';
  const bg=document.createElement('div'); bg.className='cardmenu-bg';
  const m=document.createElement('div'); m.className='cardmenu';
  m.innerHTML=freq.map((it,i)=>item(it,'data-f="'+i+'"')).join('')
    +'<button class="cm-i" id="cmMore"><span style="width:22px;text-align:center">🧰</span><span style="flex:1">Більше інструментів</span><span id="cmMoreArr" style="color:var(--faint)">▸</span></button>'
    +'<div id="cmAdv" style="display:none">'+G.map(g=>'<div class="cm-h">'+g[0]+'</div>'+g[1].map((it,i)=>item(it,'data-g="'+esc(g[0])+'" data-i="'+i+'"')).join('')).join('')+'</div>';
  document.body.appendChild(bg); document.body.appendChild(m);
  // позиція: під кнопкою на десктопі (мобільний перекриє CSS-шторкою)
  const place=()=>{
    const r=btn.getBoundingClientRect();
    m.style.top=Math.min(window.innerHeight-Math.min(m.offsetHeight,window.innerHeight*0.7)-12, r.bottom+6)+'px';
    m.style.left=Math.max(10, Math.min(window.innerWidth-m.offsetWidth-10, r.right-m.offsetWidth))+'px';
  };
  place();
  const close=()=>{ m.remove(); bg.remove(); };
  bg.onclick=close;
  const adv=m.querySelector('#cmAdv');
  m.querySelector('#cmMore').onclick=()=>{ const on=adv.style.display==='none'; adv.style.display=on?'':'none'; m.querySelector('#cmMoreArr').textContent=on?'▾':'▸'; place(); };
  m.querySelectorAll('.cm-i[data-f]').forEach(b=>b.onclick=()=>{ close(); freq[+b.dataset.f][3](); });
  m.querySelectorAll('.cm-i[data-g]').forEach(b=>b.onclick=()=>{ const g=G.find(x=>x[0]===b.dataset.g); close(); if(g) g[1][+b.dataset.i][3](); });
}
// 🔁 «тест → масштаб»: повтор хіта зі свіжим гачком через 48 год (тільки Threads)
async function repeatHit(id){ if(!confirm('🔁 Створити копію зі свіжим гачком і запланувати в Threads через 48 годин?\n\nПрактика: вдалий пост через 2 доби показується вже іншій аудиторії.')) return;
  aiBusy('🔁 Переписую гачок і планую повтор…');
  try{ const r=await api('/posts/'+id+'/repeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hours:48})});
    flash('🔁 Повтор заплановано на '+new Date(r.scheduledAt).toLocaleString('uk')); try{ await loadStudioPosts(); }catch(_){ } }
  catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }
// 🧵 тейк-хіт → повний пост-чернетка з увімкненою гілкою (відкривається в композері на рев'ю)
async function expandToThread(id){ aiBusy('🧵 Розгортаю тейк у повний пост під гілку…');
  try{ const r=await api('/posts/'+id+'/expand-thread',{method:'POST'}); try{ await loadStudioPosts(); }catch(_){ } openComposer(r.id); }
  catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } }
async function postAction(card,id,a){
  const cont=card.querySelector('.pcontent');
  if(a==='copy'){ navigator.clipboard.writeText(cont?cont.textContent:''); flash('Скопійовано'); return; }
  if(a==='regen'){ openRegenModal(id, cont); return; }
  const map={approve:'approved',needs:'needs_work',archive:'archived'};
  if(map[a]){ try{ await api('/posts/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:map[a]})}); await loadStudioPosts(); flashSaved(); }catch(e){ flash('⚠ '+e.message); } }
}
// ---------- Переробити пост: з полем «що саме змінити» (правка поверх повного контексту) ----------
function openRegenModal(postId, cont){
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  ov.innerHTML='<div class="modal-card" style="max-width:480px;padding:20px">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">↻ Переробити пост</b><button class="icon" id="rgX" style="margin-left:auto">✕</button></div>'
    +'<div class="hint">Напиши, що саме змінити (або залиш порожнім - перепишемо іншими словами). Голос бренду і стратегія зберігаються.</div>'
    +'<textarea class="txt" id="rgInstr" rows="3" style="margin-top:8px" placeholder="Напр.: зроби коротшим і без смайлів; додай приклад із практики; зроби гачок різкішим…"></textarea>'
    +'<div class="btnrow" style="margin-top:12px"><button class="primary" id="rgGo">↻ Переробити</button></div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#rgX').onclick=close;
  const ta=ov.querySelector('#rgInstr'); ta.focus();
  ov.querySelector('#rgGo').onclick=async()=>{
    const instruction=ta.value.trim(); close();
    if(cont) cont.innerHTML='<span class="spin"></span> перегенерація…';
    aiBusy('↻ Переробляю пост'+(instruction?' за твоєю правкою':'')+'…');
    try{ await api('/posts/'+postId+'/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(instruction?{instruction}:{})}); await loadStudioPosts(); flashSaved(); rememberVoiceRule(instruction); }
    catch(e){ flash('⚠ '+e.message); await loadStudioPosts(); }
    finally{ aiDone(); }
  };
}
// «Коваль» (самонавчання голосу): правка юзера може стати постійним правилом tone_of_voice
function rememberVoiceRule(instruction){
  const t=String(instruction||'').trim();
  if(!t || t.length<8) return; // разові дрібниці не пропонуємо
  setTimeout(()=>{ if(confirm('Запамʼятати цю правку як ПОСТІЙНЕ правило голосу бренду?\n\n«'+t+'»\n\nAI застосовуватиме її до всіх наступних постів.'))
    api('/voice-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule:t})}).then(()=>flash('Правило голосу збережено ✓')).catch(e=>flash('⚠ '+e.message)); }, 300);
}
// ---------- Атомізація: 1 пост → варіанти під усі канали (v2) ----------
async function openAtomize(postId){
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  ov.innerHTML='<div class="modal-card" style="max-width:760px;max-height:86vh;overflow:auto;padding:20px">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">♻️ Розтиражувати пост</b><button class="icon" id="atX" style="margin-left:auto">✕</button></div>'
    +'<div class="hint">Витягаємо «атоми» з поста й робимо нативні варіанти для кожного каналу (свій гачок під кожен).</div>'
    +'<div class="btnrow" style="margin:10px 0;flex-wrap:wrap">'+['telegram','instagram','threads','facebook'].map(c=>'<label class="rchip"><input type="checkbox" class="atCh" value="'+c+'" checked> '+(CP_LABEL[c]||c)+'</label>').join('')+'</div>'
    +'<div class="btnrow"><button class="primary" id="atGen">♻️ Згенерувати</button><span id="atMsg" style="font-size:12px;color:var(--muted)"></span></div>'
    +'<div id="atView" class="out" style="margin-top:12px"></div>'
    +'</div>';
  document.body.appendChild(ov);
  const close=()=>ov.remove(); ov.querySelector('#atX').onclick=close; ov.onclick=e=>{ if(e.target===ov) close(); };
  ov.querySelector('#atGen').onclick=async()=>{ const m=ov.querySelector('#atMsg'); const chans=[...ov.querySelectorAll('.atCh:checked')].map(c=>c.value); m.style.color='var(--muted)'; m.textContent='атомізую…'; aiBusy('♻️ Розтиражовую пост під канали…');
    try{ const r=await api('/posts/'+postId+'/atomize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels:chans})});
      const mat=(r.matrix||[]); const v=ov.querySelector('#atView');
      v.innerHTML=(r.atoms&&r.atoms.length?'<div class="card" style="margin-bottom:10px"><b>Атоми ('+r.atoms.length+'):</b><div style="color:var(--muted);font-size:13px;margin-top:4px">'+r.atoms.map(esc).join(' · ')+'</div></div>':'')
        +(mat.length?'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--muted)"><th style="padding:6px 8px">Канал</th><th>Формат</th><th>Гачок / Атом</th><th>CTA</th></tr></thead><tbody>'
          +mat.map(x=>'<tr style="border-top:1px solid var(--line)'+(x.best?';background:var(--surface2)':'')+'"><td style="padding:6px 8px">'+(x.best?'⭐ ':'')+esc(CP_LABEL[x.channel]||x.channel||'')+'</td><td>'+esc(x.format||'')+'</td><td><b>'+esc(x.hook||'')+'</b><div style="color:var(--muted)">'+esc(x.atom||'')+'</div></td><td>'+esc(x.cta||'')+'</td></tr>').join('')
          +'</tbody></table></div>':'<div class="empty">Порожньо.</div>');
      m.style.color='var(--brand)'; m.textContent='готово ✓'; }
    catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }finally{ aiDone(); } };
}
// ---------- вибір фото ----------
function chooseMedia(){ return new Promise(async resolve=>{
  let media=[]; try{ media=await api('/media'); }catch(e){ flash('Не вдалося завантажити бібліотеку'); resolve(undefined); return; }
  const imgs=media.filter(m=>m.kind==='image');
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='96'; // понад фото-редактором (90) і композером (80)
  const grid=imgs.length?imgs.map(m=>'<img loading="lazy" src="/thumb/'+esc(m.filename)+'" data-id="'+m.id+'" data-fn="'+esc(m.filename)+'" onerror="this.style.opacity=.3" style="height:84px;border-radius:8px;cursor:pointer;background:var(--surface2)">').join(''):'<div class="empty">Бібліотека порожня - завантаж фото у «Джерела».</div>';
  ov.innerHTML='<div class="modal-card" style="max-width:620px;padding:20px"><b>Обери фото</b><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">'+grid+'</div><div class="btnrow"><button class="ghost" id="cmClose">Скасувати</button><button id="cmDetach">Без фото</button></div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov){ close(); resolve(undefined); } });
  ov.querySelector('#cmClose').onclick=()=>{ close(); resolve(undefined); };
  ov.querySelector('#cmDetach').onclick=()=>{ close(); resolve({id:null,filename:null}); };
  ov.querySelectorAll('img[data-id]').forEach(im=>im.onclick=()=>{ close(); resolve({id:im.dataset.id, filename:im.dataset.fn}); });
}); }
// ---------- композер: опублікувати / запланувати ----------
// ---------- КОМПОЗЕР: повноекранна панель (ліворуч редактор, праворуч мобільне прев'ю) ----------
const NETLIM={telegram:1024,threads:500,instagram:2200,facebook:2000,linkedin:3000};
// скільки символів мережа показує ДО «… ще»/«показати повністю» (візуальний згин, як у застосунках); telegram - без згину
const NETFOLD={instagram:125,facebook:280,threads:320,linkedin:210};
const NETMORE={instagram:'… ще',facebook:'… ще',threads:'Показати повністю',linkedin:'…more'};
// 📣 Публікація тепер ФОНОВА: сервер одразу вертає «почав», а ми полимо статус.
// Раніше запит висів на весь час відправки (Instagram і Threads обробляють медіа асинхронно, до 40с
// кожен, плюс ретраї й паузи між частинами гілки) - nginx рвав зʼєднання на 60с і людина бачила
// «⚠ 504» на пості, який НАСПРАВДІ публікувався далі й зазвичай успішно виходив.
// Перечитати фактичний стан публікації і ДОЧЕКАТИСЬ посилань. Permalink для Threads та Instagram
// не збирається з id детерміновано (він містить окремий короткий код) - його доводиться дозапитувати,
// і робиться це вже ПІСЛЯ успішної відправки, щоб збій запиту не завалив саму публікацію. Через це на
// момент першого читання лінка ще може не бути, і людина бачила пост без посилання аж до F5.
async function refreshSentState(postId, sentSet, onState){
  for(let i=0;i<3;i++){
    let st=null; try{ st=await api('/posts/'+postId+'/publish-state'); }catch(e){ return; }
    (st.sent||[]).forEach(k=>sentSet.add(k));
    const links=st.links||{};
    if(onState) onState(links);
    // усі надіслані мережі вже мають лінк - чекати більше нема чого
    if(![...sentSet].some(k=>!links[k])) return;
    await new Promise(r=>setTimeout(r,2000));
  }
}
// ⏳ Спільний клієнт фонових AI-джоб. Довгі виклики моделі не вкладаються в 60-секундне вікно nginx,
// тож сервер вертає jobId, а ми полимо результат. Маршрут, який ще відповідає синхронно, працює як
// раніше - тут це видно з відсутності jobId.
async function runAiJob(path, body, onTick){
  const r=await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  if(!r||!r.jobId) return r;
  const t0=Date.now();
  for(;;){
    await new Promise(x=>setTimeout(x,1500));
    let j=null; try{ j=await api('/jobs/'+r.jobId); }catch(e){ /* мережа моргнула - пробуємо далі */ }
    if(j&&j.status==='done') return j.result;
    if(j&&j.status==='error') throw new Error(j.error||'не вдалося');
    // 'idle' = процес перезапустився посеред роботи: висіти вічно не можна
    if(j&&j.status==='idle'&&Date.now()-t0>4000) throw new Error('стан втрачено - спробуй ще раз');
    if(Date.now()-t0>5*60*1000) throw new Error('надто довго - спробуй пізніше або скороти поля');
    if(onTick) onTick(Math.round((Date.now()-t0)/1000));
  }
}
async function runPublish(postId, setMsg){
  await api('/posts/'+postId+'/publish-all',{method:'POST'});
  const t0=Date.now();
  for(;;){
    await new Promise(r=>setTimeout(r,1500));
    let j; try{ j=await api('/posts/'+postId+'/publish-job'); }catch(e){ j=null; }
    if(j&&j.status==='done') return j.results||[];
    if(j&&j.status==='error') throw new Error(j.error||'публікація не вдалась');
    // 'idle' = процес перезапустився посеред публікації: висіти вічно не можна, але й брехати
    // «не опублікувалось» теж - справжній стан читаємо з поста нижче, у виклику
    if(j&&j.status==='idle'&&Date.now()-t0>4000) throw new Error('стан публікації втрачено - перевір мережі на картці');
    if(Date.now()-t0>5*60*1000) throw new Error('публікація триває надто довго - перевір мережі на картці');
    if(setMsg) setMsg('📣 публікую… '+Math.round((Date.now()-t0)/1000)+'с');
  }
}
async function openComposer(postId, opts){
  opts=opts||{};
  // адреса, з якої прийшли: закриття композера має вернути ТУДИ, інакше оновлення сторінки
  // знову відкрило б композер (хеш лишився б #/post/<id>)
  const _routeBack=(location.hash&&!/^#\/post\//.test(location.hash))?location.hash:'#/create/posts';
  let full; try{ full=await api('/posts/'+postId+'/full'); }catch(e){ flash('Не вдалося відкрити: '+e.message); if(/^#\/post\//.test(location.hash)) location.hash=_routeBack; return; }
  let ps={sent:[],links:{}}; try{ ps=await api('/posts/'+postId+'/publish-state'); }catch(e){}
  let sentLinks=ps.links||{}; // 🔗 мережа → URL живого поста (щоб одразу перескочити й глянути)
  const sentSet=new Set(ps.sent||[]);
  const C=JSON.parse(JSON.stringify(full.channels||{}));
  // якщо жодна мережа не обрана - вмикаємо всі підключені й ще не надіслані
  if(!Object.keys(C).some(k=>C[k]&&C[k].on)) NETS.forEach(n=>{ if(ChanStatus[n[0]]&&!sentSet.has(n[0])){ C[n[0]]=C[n[0]]||{text:''}; C[n[0]].on=true; } });
  // надіслані мережі завжди позначені як обрані (щоб було видно в прев'ю)
  sentSet.forEach(k=>{ C[k]=C[k]||{text:''}; C[k].on=true; });
  let master=full.content||''; let mediaFilename=full.media_filename||null; let rubric=full.rubric||'';
  let thSnap=null; // мережі, вимкнені режимом «🧵 Гілкою» (відновлюються при вимкненні режиму)
  const initDate=opts.scheduledAt?locDate(opts.scheduledAt):''; const initTime=opts.scheduledAt?locHM(opts.scheduledAt):'11:00';
  const textOf=(k)=> (C[k]&&typeof C[k].text==='string'&&C[k].text) ? C[k].text : master;
  const ov=document.createElement('div'); ov.className='cmp-ov';
  const rubOpts='<option value="">без рубрики</option>'+(Rubrics||[]).map(r=>'<option value="'+esc(r.name)+'"'+(r.name===rubric?' selected':'')+'>'+(r.emoji||'')+' '+esc(r.name)+'</option>').join('');
  ov.innerHTML=
    '<div class="cmp-top"><button class="ghost" id="cmpBack" style="padding:6px 12px;font-size:13px">← Назад</button><b style="font-size:16px;margin-left:4px">✍ Композер</b><span id="cmpSub" style="font-size:12px;color:var(--muted)"></span><span style="flex:1"></span><button class="icon" id="cmpX" title="Закрити">✕</button></div>'
    +'<div class="cmp-body">'
      +'<div class="cmp-left">'
        +'<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Канали</div><div id="cmpChips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>'
        +'<div id="cmpThreadWrap" style="display:none;margin:0 0 12px;padding:9px 11px;border:1px dashed var(--line);border-radius:10px">'
          +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            +'<button class="netchip" id="cmpThread" title="Опублікувати серією повʼязаних постів: перший = гачок, далі відповіді автора">🧵 Гілкою</button>'
            +'<button class="netchip" id="cmpThreadNum" style="display:none" title="Нумерувати частини серії: 2/ 3/ 4/…">#⃣ Нумерація</button>'
            +'<span id="cmpThreadHint" style="font-size:11.5px;color:var(--muted)">серія повʼязаних постів у Threads</span>'
          +'</div>'
        +'</div>'
        +'<label style="font-size:12px;color:var(--muted);display:inline-block;margin-bottom:12px">Рубрика <select id="cmpRubric" class="txt" style="width:auto;padding:6px 9px;display:inline-block;margin-left:4px">'+rubOpts+'</select></label>'
    +'<label style="font-size:12px;color:var(--muted);display:inline-block;margin:0 0 12px 10px" title="Намір керує закликом: знайомство - без продажу, прогрів - мʼякий, продаж - повний CTA">Намір <select id="cmpIntent" class="txt" style="width:auto;padding:6px 9px;display:inline-block;margin-left:4px"><option value="">-</option>'+Object.keys(INTENT_META).map(k=>'<option value="'+k+'"'+((full.intent||'')===k?' selected':'')+'>'+INTENT_META[k][0]+' '+INTENT_META[k][1]+'</option>').join('')+'</select></label>'
    +'<label style="font-size:12px;color:var(--muted);display:inline-block;margin:0 0 12px 10px" title="Формат = як упаковано контент. Впливає на структуру тексту при перегенерації.">Формат <select id="cmpFormat" class="txt" style="width:auto;padding:6px 9px;display:inline-block;margin-left:4px">'+FMT_KEYS.map(k=>'<option value="'+k+'"'+((full.format||'post')===k?' selected':'')+'>'+FMT_META[k][0]+' '+FMT_META[k][1]+'</option>').join('')+'</select></label>'
        +'<textarea id="cmpText" class="txt" style="min-height:240px;font-size:14px;line-height:1.55;resize:vertical"></textarea>'
        +'<div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;color:var(--faint);margin-top:12px">🤖 ПОМІЧНИКИ ТЕКСТУ</div>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="dashbtn" id="cmpRewrite" title="Перепише текст; можна вказати, що саме змінити">✍ Переписати</button><button class="dashbtn" id="cmpHook" title="3 варіанти сильнішого відкриття з кульмінації">🪝 Гачок</button><button class="dashbtn" id="cmpAudit" title="Знайти і точково прибрати сліди AI">🔍 AI-сліди</button><button class="dashbtn" id="cmpHash" title="5-8 релевантних хештегів у кінець тексту"># Хештеги</button></div>'
        +'<div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;color:var(--faint);margin-top:14px">🖼 МЕДІА</div>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="dashbtn" id="cmpPhoto" title="Фото: з галереї, з компʼютера, зі стоку чи AI-генерація">🎨 Зображення</button></div>'
        +'<div id="cmpMediaWrap" style="margin-top:10px"></div>'
        +'<div id="cmpMsg" style="font-size:12.5px;margin-top:10px;min-height:18px"></div>'
      +'</div>'
      +'<div class="cmp-right"><div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:14px;text-align:center">Прев\'ю · мобільний</div><div id="cmpPrev"></div></div>'
    +'</div>'
    +'<div class="cmp-foot"><button class="icon" id="cmpDel" title="Видалити пост назавжди" style="color:var(--danger);display:none">🗑</button><span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;color:var(--faint)">ЧЕРНЕТКА</span><button class="ghost" id="cmpSave">💾 Зберегти</button><button class="ghost" id="cmpApprove">✅ Затвердити</button><span style="flex:1"></span><span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;color:var(--faint);border-left:1px solid var(--line);padding-left:12px">ПУБЛІКАЦІЯ</span>'
      +'<label style="font-size:12px;color:var(--muted)">Дата <input type="date" id="cmpDate" class="txt" value="'+initDate+'" style="width:auto;padding:6px 8px;display:inline-block"></label>'
      +'<label style="font-size:12px;color:var(--muted)">Час <input type="time" id="cmpTime" class="txt" value="'+initTime+'" style="width:auto;padding:6px 8px;display:inline-block"></label>'
      +'<button class="ok" id="cmpSched">🗓 Запланувати</button><button class="primary" id="cmpNow">📣 Опублікувати зараз</button></div>';
  document.body.appendChild(ov);
  _cmpOpenId=postId; writeRoute('post',postId); // 🔗 тепер на цей пост можна дати пряме посилання
  const escH=(e)=>{ if(e.key==='Escape') close(); };
  function close(){ ov.remove(); document.removeEventListener('keydown',escH); _cmpOpenId=null;
    if(/^#\/post\//.test(location.hash)) location.hash=_routeBack; } // function-декларація: хойститься, безпечна для колбеків вище
  document.addEventListener('keydown',escH);
  const msg=ov.querySelector('#cmpMsg'); const txt=ov.querySelector('#cmpText'); txt.value=master;
  const setMsg=(t,c)=>{ msg.textContent=t; msg.style.color=c||'var(--muted)'; };
  ov.querySelector('#cmpX').onclick=close;
  const backBtn=ov.querySelector('#cmpBack'); if(backBtn) backBtn.onclick=close;
  // 🗑 видалення доступне лише НЕопублікованим (опубліковані - історія й аналітика)
  const delBtn=ov.querySelector('#cmpDel');
  if(delBtn){ delBtn.style.display=sentSet.size?'none':''; delBtn.onclick=()=>deletePost(postId, close); }
  // ✅ затвердження прямо з композера (не вертаючись до картки)
  const apBtn=ov.querySelector('#cmpApprove');
  if(apBtn){ const cur=(Finals||[]).find(x=>x.id===postId);
    const setAp=(on)=>{ apBtn.textContent=on?'✅ Затверджено':'✅ Затвердити'; apBtn.style.color=on?'var(--brand)':''; };
    setAp(cur&&cur.review==='approved');
    apBtn.onclick=async()=>{ apBtn.disabled=true; try{ await saveDraft(); await api('/posts/'+postId+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'approved'})}); setAp(true); try{ await loadStudioPosts(); }catch(_){ } try{loadGuide(true);}catch(e){} flash('✅ Затверджено - пост готовий до календаря'); close(); }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); apBtn.disabled=false; } }; }
  // ----- канали (надіслані = заблоковані з ✓) + пер-канальна адаптація -----
  const hasOwn=(k)=>!!(C[k]&&typeof C[k].text==='string'&&C[k].text.trim());
  const netName=(k)=>{ const n=NETS.find(x=>x[0]===k); return n?n[1]:k; };
  // Підлаштувати ОДНУ мережу. Раніше єдина кнопка внизу переписувала текст під ВСІ обрані канали
  // одним рухом - і вернути свій варіант було нічим (фідбек Олега). Тепер кожна мережа окремо, а
  // C.manual_adapt=true означає «адаптацією керує людина» → сервер більше не перепаковує сам
  // (інакше мережі, які юзер свідомо лишив зі своїм текстом, все одно переписувались при публікації).
  async function adaptOne(k,btn){
    if(sentSet.has(k)) return;
    if(btn) btn.disabled=true; setMsg('✨ підлаштовую під '+netName(k)+'…'); aiBusy('✨ Підлаштовую під '+netName(k)+'…');
    try{
      master=txt.value; // адаптація завжди з АКТУАЛЬНОГО майстер-тексту, а не з того, що було при відкритті
      await api('/posts/'+postId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:master})});
      const r=await api('/posts/'+postId+'/adapt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels:[k]})});
      const v=(r.channels||{})[k];
      if(v&&typeof v.text==='string'&&v.text.trim()){ C[k]={...(C[k]||{}),...v,on:true}; C.manual_adapt=true; setMsg(netName(k)+': текст підлаштовано ✓ (↺ вернути мій)','var(--brand)'); }
      else setMsg('⚠ модель не дала варіанту для '+netName(k),'var(--danger)');
      renderChips(); renderPrev();
    }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); }
    finally{ if(btn) btn.disabled=false; aiDone(); }
  }
  function renderChips(){ const box=ov.querySelector('#cmpChips'); const thOn=!!(C.threads&&C.threads.on&&C.threads.thread);
    box.innerHTML=NETS.map(n=>{ const k=n[0]; const on=C[k]&&C[k].on; const conn=ChanStatus[k]; const sent=sentSet.has(k);
      const dimmed=thOn&&k!=='threads'; // режим гілки: серія їде ЛИШЕ в Threads, решта мереж затінені
      const own=hasOwn(k);             // у мережі вже є СВОЯ версія тексту
      const segOff=!conn||sent||dimmed||!on;
      // ✨ = підлаштувати САМЕ цю мережу; ↺ (лише коли є своя версія) = вернути мій текст.
      // Коли ↺ показано, ✨ втрачає скруглення справа - вони виглядають однією складеною кнопкою.
      const seg='<button class="netseg'+(own?' has':'')+'" data-adapt="'+k+'"'+(segOff?' disabled':'')
        +(own?' style="border-radius:0"':'')
        +' title="'+(own?'Своя версія тексту для цієї мережі. Клік - підлаштувати заново':'Підлаштувати текст саме під цю мережу (решта мереж не зміняться)')+'">'+(own?'✨✓':'✨')+'</button>';
      const rev=own?'<button class="netseg" data-revert="'+k+'" title="Вернути мій текст (прибрати окрему версію для цієї мережі)">↺</button>':'';
      // Мережа УВІМКНЕНА, але не підключена (пост із бота/плану чи канал відключили): чіп мусить лишатись
      // клікабельним, щоб її можна було ЗНЯТИ - інакше «не можу зняти Telegram» (фідбек тестера).
      const lockOff=sent||dimmed||(!conn&&!on);
      const chip='<button class="netchip'+(on&&!dimmed?' on':'')+(on&&!conn?' warn':'')+'" data-net="'+k+'"'+(lockOff?' disabled':'')+' style="'+(dimmed?'opacity:.35':'')+'" title="'+(sent?'вже опубліковано':(dimmed?'у режимі гілки пост їде лише в Threads (вимкни 🧵, щоб обрати інші мережі)':(conn?'':(on?'мережа не підключена - клік, щоб зняти її з поста':'не підключено'))))+'">'+(sent?'✓ ':'')+(on&&!conn?'⚠ ':'')+n[1]+'</button>';
      return '<span class="netgrp">'+chip+seg+rev+'</span>'; }).join('');
    box.querySelectorAll('.netchip').forEach(b=>{ if(b.disabled) return; b.onclick=()=>{ const k=b.dataset.net; C[k]=C[k]||{text:''}; C[k].on=!C[k].on; renderChips(); renderPrev(); }; });
    box.querySelectorAll('[data-adapt]').forEach(b=>{ if(b.disabled) return; b.onclick=()=>adaptOne(b.dataset.adapt,b); });
    box.querySelectorAll('[data-revert]').forEach(b=>{ b.onclick=()=>{ const k=b.dataset.revert; if(C[k]) C[k].text=''; C.manual_adapt=true; renderChips(); renderPrev(); setMsg('вернув твій текст для '+netName(k)+' ✓','var(--brand)'); }; });
    // 🧵 режим «Гілкою»: серія повʼязаних постів (root-гачок + відповіді) з ПОВНОГО тексту
    const tw=ov.querySelector('#cmpThreadWrap');
    if(tw){ const showTh=C.threads&&C.threads.on&&!sentSet.has('threads'); tw.style.display=showTh?'':'none';
      const tb=ov.querySelector('#cmpThread'), nb=ov.querySelector('#cmpThreadNum'), hint=ov.querySelector('#cmpThreadHint');
      tb.classList.toggle('on',thOn);
      nb.style.display=thOn?'':'none'; nb.classList.toggle('on',thOn&&C.threads.number!==false);
      if(hint) hint.textContent=thOn?'порожній рядок у тексті = нова частина серії; фото їде в першому пості':'серія повʼязаних постів у Threads';
      tb.onclick=()=>{ C.threads=C.threads||{}; C.threads.thread=!C.threads.thread;
        if(C.threads.thread){ thSnap=NETS.map(n=>n[0]).filter(k=>k!=='threads'&&C[k]&&C[k].on); thSnap.forEach(k=>{ C[k].on=false; }); }
        else if(thSnap){ thSnap.forEach(k=>{ if(C[k]&&!sentSet.has(k)) C[k].on=true; }); thSnap=null; }
        renderChips(); renderPrev(); };
      nb.onclick=()=>{ C.threads.number=C.threads.number===false?true:false; renderChips(); renderPrev(); }; } }
  // ----- медіа (ліва панель) -----
  function renderMedia(){ ov.querySelector('#cmpMediaWrap').innerHTML=(mediaFilename
      ?'<img src="/media/'+esc(mediaFilename)+'" style="max-height:120px;border-radius:10px;border:1px solid var(--line)">'
      :'<div style="font-size:12px;color:var(--muted)">Фото ще нема - додай через «⚡ AI фото».</div>'); }
  // ----- прев'ю мобільне по кожній обраній мережі -----
  const _pvExp=new Set(); // мережі, де натиснуто «… ще» → показуємо повністю
  const pvCap=(k,t)=>{ const fold=NETFOLD[k];
    if(_pvExp.has(k)||!fold||t.length<=fold) return esc(t);
    let cut=t.slice(0,fold); const sp=cut.lastIndexOf(' '); if(sp>fold*0.6) cut=cut.slice(0,sp);
    return esc(cut).replace(/\s+$/,'')+'… <span class="pv-more" data-more="'+k+'">'+NETMORE[k]+'</span>'; };
  function renderPrev(){ const box=ov.querySelector('#cmpPrev'); const sel=NETS.filter(n=>C[n[0]]&&C[n[0]].on);
    if(!sel.length){ box.innerHTML='<div style="font-size:12px;color:var(--muted);text-align:center">Обери канал ліворуч.</div>'; return; }
    const av=(($('avatar')&&$('avatar').textContent)||'В').slice(0,2);
    box.innerHTML=sel.map(n=>{ const k=n[0]; const t=textOf(k); const lim=NETLIM[k]||2200; const over=t.length>lim; const sent=sentSet.has(k);
      const img=mediaFilename?'<img src="/media/'+esc(mediaFilename)+'" style="width:100%;display:block">':'';
      const cnt=sent?'<span style="margin-left:auto;font-size:11px;font-weight:800;color:var(--brand)">✓</span>':'<span class="cmp-cnt" style="margin-left:auto;color:'+(over?'var(--danger)':'var(--faint)')+'">'+t.length+'/'+lim+'</span>';
      const head='<div class="phone-h"><span class="phone-av">'+esc(av)+'</span><span class="phone-user">ваш_профіль</span>'+cnt+'</div>';
      const empty='<span style="color:var(--muted)">порожньо</span>';
      let body;
      if(k==='instagram') body=head+img+'<div class="ig-acts">♡ 💬 ↗<span class="sp"></span>🔖</div><div class="phone-b"><span class="phone-user">ваш_профіль</span> <span class="phone-txt" style="display:inline">'+(t?pvCap(k,t):empty)+'</span></div>';
      else if(k==='telegram') body=head+img+'<div class="phone-b"><div class="phone-txt">'+(t?esc(t):empty)+'</div></div>'+((over&&mediaFilename)?'<div class="pv-note">довгий підпис Telegram надішле окремим повідомленням під фото</div>':'');
      else if(k==='threads'&&C.threads&&C.threads.thread){
        // 🧵 прев'ю гілки як у Threads: аватар + вертикальна лінія + частини-відповіді
        // (тут детермінована розбивка по абзацах; при публікації AI переріже точніше, з гачком у root)
        const parts=clientThreadSplit(master); const num=C.threads.number!==false;
        body=head+'<div style="padding:10px 12px">'+parts.map((p,i)=>
          '<div style="display:flex;gap:8px">'
            +'<div style="display:flex;flex-direction:column;align-items:center;flex:none"><span class="phone-av" style="width:22px;height:22px;font-size:10px">'+esc(av)+'</span>'+(i<parts.length-1?'<span style="flex:1;width:2px;background:var(--line);margin:3px 0;border-radius:2px"></span>':'')+'</div>'
            +'<div style="flex:1;min-width:0;padding-bottom:'+(i<parts.length-1?'12px':'0')+'"><div style="font-size:10.5px;color:var(--faint);font-weight:700">ваш_профіль'+(i?' · відповідь':'')+'</div><div class="phone-txt" style="margin-top:2px">'+(num&&i?('<b>'+(i+1)+'/</b> '):'')+esc(p)+'</div>'+(i===0&&mediaFilename?'<img src="/media/'+esc(mediaFilename)+'" style="width:100%;display:block;border-radius:8px;margin-top:6px">':'')+'</div>'
          +'</div>').join('')+'</div>'
          +'<div class="pv-note">🧵 гілка: '+parts.length+' частин(и)'+(num?' з нумерацією 2/ 3/…':' без нумерації')+' - root-гачок + відповіді</div>';
      }
      else body=head+'<div class="phone-b"><div class="phone-txt">'+(t?pvCap(k,t):empty)+'</div></div>'+img;
      // Честь прев'ю: поки адаптацією не керує людина, мережа без своєї версії буде спакована
      // сервером ПРИ публікації - тобто вийде НЕ те, що показано тут. Кажемо це прямо.
      const auto=!sent&&!C.manual_adapt&&!hasOwn(k)
        ? '<div class="pv-note">✨ при публікації текст спакується під цю мережу автоматично. Хочеш керувати сам - тисни ✨ на каналі</div>' : '';
      const ownMark=hasOwn(k)?'<div class="pv-note" style="color:var(--brand)">✨ своя версія для цієї мережі (↺ на каналі - вернути твій текст)</div>':'';
      // 🔗 щойно мережа опублікована - поруч із її плашкою зʼявляється лінк на живий пост
      const open=sentLinks[k]?'<a href="'+esc(sentLinks[k])+'" target="_blank" rel="noopener" class="pv-open" title="Відкрити пост у '+esc(n[1])+'">↗ Відкрити пост</a>':'';
      return '<div class="pv-label" style="background:var('+NETVAR[k]+')">'+n[1]+'</div>'+open+'<div class="phone">'+body+'</div>'+auto+ownMark; }).join('');
    box.querySelectorAll('[data-more]').forEach(el=>el.onclick=()=>{ _pvExp.add(el.dataset.more); renderPrev(); }); }
  txt.addEventListener('input',()=>{ master=txt.value; renderPrev(); });
  ov.querySelector('#cmpRubric').onchange=(e)=>{ rubric=e.target.value; };
  renderChips(); renderMedia(); renderPrev();
  // ----- дії: хештеги / фото / переписати -----
  ov.querySelector('#cmpHash').onclick=async(e)=>{ const b=e.target; b.disabled=true; setMsg('# добираю хештеги…'); aiBusy('# Добираю хештеги…'); try{ const r=await api('/posts/'+postId+'/hashtags',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:master})}); const tags=(r.hashtags||[]).join(' '); if(tags){ master=(master.trimEnd()+'\n\n'+tags); txt.value=master; renderPrev(); setMsg('готово ✓','var(--brand)'); } else setMsg('не знайшлося тегів'); }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); } finally{ b.disabled=false; aiDone(); } };
  ov.querySelector('#cmpRewrite').onclick=async(e)=>{ const instruction=prompt('Що змінити? (порожньо = переписати іншими словами, голос збережеться)'); if(instruction===null) return; const b=e.target; b.disabled=true; setMsg('✍ переписую…'); aiBusy('✍ Переписую пост…'); try{ await api('/posts/'+postId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:master})}); const r=await api('/posts/'+postId+'/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruction})}); master=r.content||master; txt.value=master; renderPrev(); setMsg('готово ✓','var(--brand)'); rememberVoiceRule(instruction); }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); } finally{ b.disabled=false; aiDone(); } };
  ov.querySelector('#cmpHook').onclick=async(e)=>{ const b=e.target; b.disabled=true; setMsg('🪝 шукаю кульмінацію…'); aiBusy('🪝 Складаю 3 варіанти відкриття з кульмінації…');
    try{ const r=await api('/posts/'+postId+'/hooks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:master})});
      const hooks=[...(r.hooks||[])]; if(r.soft) hooks.push(r.soft);
      if(!hooks.length){ setMsg('не вдалося скласти варіанти','var(--danger)'); return; }
      const hv=document.createElement('div'); hv.className='modal'; hv.style.zIndex='90'; // понад композером (.cmp-ov z-index:80)
      hv.innerHTML='<div class="modal-card" style="max-width:540px;padding:20px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🪝 Обери відкриття</b><button class="icon" id="hkX" style="margin-left:auto">✕</button></div>'
        +(r.culmination?'<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">💎 Кульмінація матеріалу: <b style="color:var(--ink2)">'+esc(r.culmination)+'</b></div>':'')
        +hooks.map((h,i)=>'<div class="card" data-h="'+i+'" style="cursor:pointer;margin-bottom:8px;padding:12px 14px;font-size:13.5px;line-height:1.5">'+(r.soft&&i===hooks.length-1?'<span class="ptag" style="margin-right:6px">🕊 м\'який місток</span>':'')+esc(h)+'</div>').join('')
        +((r.remove&&r.remove.length)?'<div style="font-size:12px;color:var(--danger);margin-top:8px">✂ Видалити з тексту (хук-артефакти): '+r.remove.map(x=>'«'+esc(x)+'»').join(', ')+'</div>':'')
        +'<div class="hint">Клік замінює перший абзац поста. Поточний перший рядок зникне.</div></div>';
      document.body.appendChild(hv); const hclose=()=>hv.remove();
      hv.addEventListener('click',ev=>{ if(ev.target===hv) hclose(); }); hv.querySelector('#hkX').onclick=hclose;
      hv.querySelectorAll('[data-h]').forEach(c=>c.onclick=()=>{ const h=hooks[+c.dataset.h]; const parts=master.split('\n\n'); parts[0]=h; master=parts.join('\n\n'); txt.value=master; renderPrev(); hclose(); setMsg('гачок замінено ✓ (не забудь зберегти)','var(--brand)'); });
      setMsg('');
    }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); } finally{ b.disabled=false; aiDone(); } };
  ov.querySelector('#cmpAudit').onclick=async(e)=>{ const b=e.target; b.disabled=true; setMsg('🔍 шукаю AI-сліди…'); aiBusy('🔍 Шукаю сліди AI у тексті…');
    try{ const r=await api('/posts/'+postId+'/ai-audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:master})}); const f=r.findings||[];
      if(!f.length){ setMsg('чисто - слідів AI не знайдено ✓','var(--brand)'); return; }
      aiDone();
      const doFix=confirm('🔍 Знайдено AI-слідів: '+f.length+'\n\n'+f.map(x=>'• '+x.pattern+': «'+x.quote+'»').join('\n')+'\n\n🧹 Виправити точково? (замінюються ЛИШЕ знайдені фрагменти, решта тексту не рухається)');
      if(!doFix){ setMsg('знайдено слідів: '+f.length+' (не виправлено)','var(--danger)'); return; }
      setMsg('🧹 точкова правка (до 2 проходів)…'); aiBusy('🧹 Точково прибираю AI-сліди…');
      const rr=await api('/posts/'+postId+'/deai-fix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:master})});
      master=rr.content||master; txt.value=master; renderPrev();
      setMsg((rr.remaining&&rr.remaining.length)?('прибрано; лишилось слідів: '+rr.remaining.length+' (запусти ще раз)'):'сліди прибрано, текст чистий ✓','var(--brand)');
    }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); } finally{ b.disabled=false; aiDone(); } };
  ov.querySelector('#cmpPhoto').onclick=()=>openPhotoTool(postId, full.image_prompt||'', (f)=>{ mediaFilename=f; renderMedia(); renderPrev(); });
  // ----- зберегти / адаптувати / публікувати / планувати -----
  async function saveDraft(){ const iv=ov.querySelector('#cmpIntent'), fv=ov.querySelector('#cmpFormat');
    await api('/posts/'+postId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:master,rubric,intent:iv?iv.value:'',...(fv?{format:fv.value}:{})})});
    await api('/posts/'+postId+'/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels:C})}); }
  ov.querySelector('#cmpSave').onclick=async(e)=>{ const b=e.target; b.disabled=true; setMsg('💾 зберігаю…'); try{ await saveDraft(); setMsg('чернетку збережено ✓','var(--brand)'); try{await loadStudioPosts();}catch(_){} }catch(err){ setMsg('⚠ '+err.message,'var(--danger)'); } finally{ b.disabled=false; } };
  ov.querySelector('#cmpNow').onclick=async(e)=>{ const todo=NETS.map(n=>n[0]).filter(k=>C[k]&&C[k].on&&!sentSet.has(k)); if(!todo.length){ setMsg('усі обрані канали вже опубліковано','var(--danger)'); return; } const b=e.target; b.disabled=true;
    try{
      // Авто-перепаковка мереж без власної версії - АЛЕ лише поки адаптацією не почала керувати
      // людина. Щойно юзер підлаштував (чи вернув ↺) хоч одну мережу вручну, прев'ю = істина:
      // мережі, які він лишив зі своїм текстом, їдуть саме зі своїм текстом.
      const missing=C.manual_adapt?[]:todo.filter(k=>!hasOwn(k));
      if(missing.length){ setMsg('✨ пакую під канали…'); aiBusy('✨ Пакую пост під кожну мережу…');
        // ⚠️ aiBusy/aiDone - ЛІЧИЛЬНИК: без парного aiDone саме тут банер «Публікую в канали…»
        // лишався висіти назавжди, бо _aiN ніколи не падав до нуля (finally нижче гасить лише СВІЙ виклик)
        try{
          await api('/posts/'+postId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:master})});
          const ra=await api('/posts/'+postId+'/adapt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels:missing})});
          Object.keys(ra.channels||{}).forEach(k=>{ if(!sentSet.has(k)) C[k]=ra.channels[k]; }); renderPrev();
        } finally { aiDone(); } }
    }catch(_){ /* адаптація не критична - публікуємо майстер-текстом */ }
    setMsg('📣 публікую…'); aiBusy('📣 Публікую в канали…'); try{ await saveDraft(); const res=await runPublish(postId,setMsg); const ok=res.filter(x=>x.status==='sent').map(x=>x.channel); const err=res.filter(x=>x.status==='error'); ok.forEach(k=>sentSet.add(k)); await refreshSentState(postId,sentSet,(l)=>{ sentLinks=l; renderChips(); renderPrev(); }); renderChips(); renderPrev(); setMsg((ok.length?'✓ '+ok.join(', '):'')+(err.length?' ⚠ '+err.map(x=>x.channel+': '+x.error).join('; '):''), err.length?'var(--danger)':'var(--brand)'); if(ok.length&&!err.length) flash('Опубліковано ✓ Якщо пост залетить - 🔥 на картці дасть 5 кутів продовження'); try{await loadStudioPosts();}catch(_){} }catch(e2){ setMsg('⚠ '+e2.message,'var(--danger)');
      // навіть при збої частина мереж могла пройти - перечитуємо ФАКТИЧНИЙ стан, щоб інтерфейс
      // не показував «не опубліковано» на пості, який уже вийшов
      try{ await refreshSentState(postId,sentSet,(l)=>{ sentLinks=l; renderChips(); renderPrev(); }); }catch(_){ }
    } finally{ b.disabled=false; aiDone(); } };
  ov.querySelector('#cmpSched').onclick=async(e)=>{ const d=ov.querySelector('#cmpDate').value, t=ov.querySelector('#cmpTime').value; if(!d||!t){ setMsg('вкажи дату й час','var(--danger)'); return; } const todo=NETS.map(n=>n[0]).filter(k=>C[k]&&C[k].on&&!sentSet.has(k)); if(!todo.length){ setMsg('немає каналів для планування (усі вже опубліковано)','var(--danger)'); return; } const b=e.target; b.disabled=true; setMsg('🗓 зберігаю…'); const at=zonedToUTCISO(d,t); try{ await saveDraft(); if(opts.slotId){ await api('/schedule/'+opts.slotId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduledAt:at})}); } else { await api('/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postId,scheduledAt:at})}); } setMsg('заплановано ✓ ('+todo.join(', ')+')','var(--brand)'); try{await loadPublish();}catch(_){} try{await loadStudioPosts();}catch(_){} setTimeout(close,1000); }catch(e2){ setMsg('⚠ '+e2.message,'var(--danger)'); b.disabled=false; } };
}
// двокроковий редактор фото поста: крок 1 - джерело (галерея/завантаження/генерація) + формат (кроп),
// крок 2 - текст на фото (шрифт/місце/фон, безкоштовне перенакладання) + перегенерація з коментарем
async function openPhotoTool(postId, initPrompt, onDone){
  let full={}; try{ full=await api('/posts/'+postId+'/full'); }catch(e){}
  let aspect='4:5', fn=full.media_filename||null, hasBase=!!full.has_base, headline=full.headline||'';
  let lastPrompt=(initPrompt||full.image_prompt||'').trim();
  let canRegen=!!(fn&&hasBase&&lastPrompt); // «перегенерувати» має сенс лише коли є промт
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='90';
  ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px" id="ptCard"></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  const card=ov.querySelector('#ptCard');
  const header=(t)=>'<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><b style="font-size:16px">'+t+'</b><button class="icon" id="ptX" style="margin-left:auto">✕</button></div>';
  const prevHtml=()=>fn?'<img src="/media/'+esc(fn)+'" style="width:100%;max-height:320px;object-fit:contain;border-radius:10px;border:1px solid var(--line);background:var(--surface2)">':'';

  function step1(){
    card.innerHTML=header('🖼 Фото · крок 1: джерело')
      +'<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Формат зображення <span class="qh" title="Один формат працює в усіх мережах - різні розміри вручну не потрібні. 4:5 рекомендуємо: він займає найбільше місця в стрічці Instagram/Facebook і коректно виглядає всюди.">?</span></div>'
      +'<div style="display:flex;gap:6px" id="ptAsp">'+[['4:5','📱 Для стрічки','вертикальне, займає найбільше місця (рекоменд.)'],['1:1','⬛ Квадрат','універсальне, компактне'],['16:9','🖥 Широке','для обкладинок/десктопу']].map(a=>'<button class="aspchip'+(a[0]===aspect?' on':'')+'" data-a="'+a[0]+'" title="'+a[2]+'" style="flex:1;min-width:96px;display:flex;flex-direction:column;gap:1px;padding:8px 6px;line-height:1.2"><span>'+a[1]+'</span><span style="font-size:10px;opacity:.6">'+a[0]+'</span></button>').join('')+'</div>'
      +'<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="ghost" id="ptGallery" style="flex:1;min-width:110px">📎 З галереї</button><button class="ghost" id="ptUpload" style="flex:1;min-width:110px">⬆ Завантажити</button><button class="ghost" id="ptStock" style="flex:1;min-width:110px" title="Безкоштовні фото Pexels під тему поста">🖼 Зі стоку</button><button class="primary" id="ptGenBtn" style="flex:1;min-width:110px">🎨 Згенерувати</button></div>'
      +'<input type="file" id="ptFile" accept="image/*" style="display:none">'
      +'<div id="ptGenBox" style="display:none;margin-top:12px"><label class="fl">Опис зображення (промт)</label><textarea id="ptPrompt" class="txt" rows="3" placeholder="Що на зображенні…">'+esc(lastPrompt)+'</textarea><div class="btnrow" style="margin-top:10px"><button class="primary" id="ptGen">🎨 Малювати (коштує)</button></div></div>'
      +(fn?'<div class="btnrow" style="margin-top:12px"><button class="ghost" id="ptToText">✍ Поточне фото → додати текст</button></div>':'')
      +'<div id="ptMsg" style="font-size:12px;color:var(--muted);margin-top:8px;min-height:16px"></div>'
      +'<div class="hint" style="margin-top:6px">Фото з галереї чи з комп\'ютера буде обітнуто під обраний формат. Генерація малює нову картинку (коштує).</div>';
    card.querySelector('#ptX').onclick=close;
    const msg=card.querySelector('#ptMsg');
    const err=(e)=>{ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; };
    card.querySelectorAll('#ptAsp .aspchip').forEach(c=>c.onclick=()=>{ aspect=c.dataset.a; card.querySelectorAll('#ptAsp .aspchip').forEach(x=>x.classList.toggle('on',x===c)); });
    card.querySelector('#ptGallery').onclick=async()=>{ const sel=await chooseMedia(); if(!sel||!sel.id){ if(sel&&sel.id===null){ try{ await api('/posts/'+postId+'/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mediaId:null})}); fn=null; hasBase=false; if(onDone)onDone(null); close(); }catch(e){ err(e); } } return; }
      cropStep(sel.id, sel.filename); };
    card.querySelector('#ptUpload').onclick=()=>card.querySelector('#ptFile').click();
    card.querySelector('#ptFile').onchange=async(e)=>{ const file=e.target.files&&e.target.files[0]; if(!file) return; msg.style.color='var(--muted)'; msg.textContent='завантаження…';
      try{ const fd=new FormData(); fd.append('file',file); const r=await fetch('/api/media',{method:'POST',body:fd,credentials:'same-origin'}); const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status)); const up=(j.saved||[])[0]; if(!up) throw new Error('файл не збережено');
        cropStep(up.id, up.url.replace('/media/','')); }catch(e2){ err(e2); } };
    card.querySelector('#ptStock').onclick=()=>stockStep();
    card.querySelector('#ptGenBtn').onclick=()=>{ const b=card.querySelector('#ptGenBox'); b.style.display=b.style.display==='none'?'block':'none'; if(b.style.display==='block') card.querySelector('#ptPrompt').focus(); };
    card.querySelector('#ptGen').onclick=async(e)=>{ const b=e.target; b.disabled=true; lastPrompt=card.querySelector('#ptPrompt').value.trim(); msg.style.color='var(--muted)'; msg.textContent='малюю зображення… (10-30с)'; aiBusy('🎨 Малюю зображення… (10-30с)');
      try{ const r=await api('/posts/'+postId+'/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:lastPrompt,aspect})}); fn=r.filename; hasBase=true; canRegen=true; headline=''; if(onDone)onDone(fn); step2(); }catch(e2){ err(e2); b.disabled=false; } finally{ aiDone(); } };
    const tt=card.querySelector('#ptToText'); if(tt) tt.onclick=()=>step2();
  }

  // СТОК Pexels: AI підбирає запит під тему поста → 3 безкоштовні фото на вибір → кроп під формат
  function stockStep(){
    card.innerHTML=header('🖼 Фото · зі стоку')+'<div id="stBody" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">🖼 Підбираю фото під тему поста…</div>'
      +'<div class="btnrow" style="margin-top:12px"><button class="ghost" id="stBack">← Інше джерело</button><button class="ghost" id="stMore" style="display:none">🔄 Інші варіанти</button></div>'
      +'<div class="hint" style="margin-top:6px">Безкоштовні фото з фотостоку Pexels. Обране буде обітнуто під формат '+aspect+'.</div>';
    card.querySelector('#ptX').onclick=close;
    card.querySelector('#stBack').onclick=()=>step1();
    const body=card.querySelector('#stBody');
    const load=async()=>{
      body.style.display='flex'; body.innerHTML='🖼 Підбираю фото під тему поста…';
      try{
        const r=await api('/posts/'+postId+'/stock-photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aspect})});
        const ph=r.photos||[];
        if(!ph.length){ body.innerHTML='нічого не знайшлося - спробуй «🎨 Згенерувати»'; return; }
        body.style.display='grid'; body.style.gridTemplateColumns='repeat(3,1fr)'; body.style.gap='8px';
        body.innerHTML=ph.map((p,i)=>'<div class="stPick" data-i="'+i+'" style="cursor:pointer;border-radius:9px;overflow:hidden;border:1px solid var(--line)"><img src="'+esc(p.thumb)+'" style="width:100%;height:150px;object-fit:cover;display:block" title="'+esc(p.alt||'')+'"><div style="font-size:10.5px;color:var(--faint);padding:3px 6px">📷 '+esc(p.photographer||'Pexels')+'</div></div>').join('');
        card.querySelector('#stMore').style.display='inline-flex';
        body.querySelectorAll('.stPick').forEach(el=>el.onclick=async()=>{ const p=ph[+el.dataset.i];
          body.style.display='flex'; body.innerHTML='✂ обтинаю під формат…';
          try{ const rr=await api('/posts/'+postId+'/stock-photo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:p.url,aspect})});
            fn=rr.filename; hasBase=true; canRegen=false; headline=''; if(onDone)onDone(fn); step2(); }
          catch(e){ body.innerHTML='⚠ '+esc(e.message); } });
      }catch(e){ body.innerHTML='⚠ '+esc(e.message); }
    };
    card.querySelector('#stMore').onclick=load;
    load();
  }

  // РУЧНИЙ КРОП: рамка з пропорцією формату - тягнеш мишкою/пальцем, розмір повзунком.
  // «⚡ Авто» = розумний центр-кроп, як раніше. Що в рамці - те і буде фото поста.
  function cropStep(mediaId, srcFn){
    card.innerHTML=header('🖼 Фото · кадрування '+aspect)
      +'<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Пересунь рамку на потрібне місце. Що в рамці - те лишиться.</div>'
      +'<div id="cwrap" style="position:relative;user-select:none;touch-action:none;display:flex;justify-content:center;background:var(--surface2);border-radius:10px;overflow:hidden">'
        +'<img id="cimg" src="/media/'+esc(srcFn)+'" style="max-width:100%;max-height:380px;display:block" draggable="false">'
        +'<div id="cframe" style="position:absolute;border:2px solid var(--brand);box-shadow:0 0 0 9999px rgba(0,0,0,.45);cursor:move;border-radius:4px"></div>'
      +'</div>'
      +'<div style="display:flex;gap:10px;align-items:center;margin-top:10px"><span style="font-size:12px;color:var(--muted)">Розмір рамки</span><input type="range" id="csize" min="30" max="100" value="100" style="flex:1"></div>'
      +'<div class="btnrow" style="margin-top:12px"><button class="ghost" id="cBack">← Інше фото</button><button class="ghost" id="cAuto" title="Розумний автоматичний кроп по центру уваги">⚡ Авто</button><button class="primary" id="cSave">✂ Обрізати так</button></div>'
      +'<div id="cMsg" style="font-size:12px;color:var(--muted);margin-top:6px;min-height:16px"></div>';
    card.querySelector('#ptX').onclick=close;
    const img=card.querySelector('#cimg'), frame=card.querySelector('#cframe');
    const dims={'1:1':[1,1],'4:5':[4,5],'16:9':[16,9]}; const d=dims[aspect]||[1,1]; const ratio=d[0]/d[1]; // ширина/висота рамки
    let fx=0,fy=0,fw=0;
    const layout=()=>{ const iw=img.clientWidth, ih=img.clientHeight; const fh=fw/ratio;
      fx=Math.max(0,Math.min(iw-fw,fx)); fy=Math.max(0,Math.min(ih-fh,fy));
      frame.style.left=(img.offsetLeft+fx)+'px'; frame.style.top=(img.offsetTop+fy)+'px'; frame.style.width=fw+'px'; frame.style.height=fh+'px'; };
    const initFrame=()=>{ const iw=img.clientWidth, ih=img.clientHeight; if(!iw||!ih) return;
      fw=Math.min(iw, ih*ratio); fx=(iw-fw)/2; fy=(ih-fw/ratio)/2; layout(); };
    img.onload=initFrame; if(img.complete) setTimeout(initFrame,0);
    card.querySelector('#csize').oninput=(e)=>{ const iw=img.clientWidth, ih=img.clientHeight; const maxW=Math.min(iw, ih*ratio);
      const cx=fx+fw/2, cy=fy+(fw/ratio)/2; fw=Math.max(40,maxW*(+e.target.value/100)); fx=cx-fw/2; fy=cy-(fw/ratio)/2; layout(); };
    let drag=null;
    frame.addEventListener('pointerdown',e=>{ drag={sx:e.clientX,sy:e.clientY,fx,fy}; frame.setPointerCapture(e.pointerId); e.preventDefault(); });
    frame.addEventListener('pointermove',e=>{ if(!drag) return; fx=drag.fx+(e.clientX-drag.sx); fy=drag.fy+(e.clientY-drag.sy); layout(); });
    frame.addEventListener('pointerup',()=>{ drag=null; });
    const doAttach=async(crop)=>{ const m=card.querySelector('#cMsg'); m.style.color='var(--muted)'; m.textContent='обтинаю…';
      try{ const body={mediaId,aspect}; if(crop) body.crop=crop;
        const r=await api('/posts/'+postId+'/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        fn=r.filename; hasBase=true; canRegen=false; headline=''; if(onDone)onDone(fn); step2(); }
      catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } };
    card.querySelector('#cAuto').onclick=()=>doAttach(null);
    card.querySelector('#cSave').onclick=()=>{ const iw=img.clientWidth, ih=img.clientHeight; if(!iw||!ih||!fw){ doAttach(null); return; }
      doAttach({x:fx/iw, y:fy/ih, w:fw/iw, h:(fw/ratio)/ih}); };
    card.querySelector('#cBack').onclick=()=>step1();
  }

  function step2(){
    const firstLine=(full.content||'').split('\n').map(s=>s.trim()).find(Boolean)||'';
    card.innerHTML=header('🖼 Фото · крок 2: текст')
      +'<div id="ptPrev">'+prevHtml()+'</div>'
      +(canRegen?'<div style="display:flex;gap:8px;margin-top:10px"><input class="txt" id="ptRegenNote" placeholder="Що змінити? (напр.: світліше, без людей)" style="flex:1"><button class="ghost" id="ptRegen">🔁 Перегенерувати</button></div>':'')
      +'<label class="fl" style="margin-top:12px">Текст на фото <span style="font-weight:400;color:var(--faint)">(ключове слово можна виділити *зірочками* - воно стане акцентним)</span></label>'
      +'<div style="display:flex;gap:8px"><input class="txt" id="ptHead" placeholder="Короткий заголовок" value="'+esc(headline||firstLine.slice(0,48))+'" style="flex:1"><button class="ghost" id="ptSuggest" title="Заголовок, що ДОПОВНЮЄ пост, а не повторює його">✨ Підказати</button></div>'
      +'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:flex-end">'
        +'<label style="font-size:12px;color:var(--muted)">Стиль<br><select id="ptPreset" class="txt" style="width:auto;padding:6px 9px;margin-top:2px">'+[['minimal','Мінімал (низ + градієнт)'],['quote','Цитата (центр, великими)'],['cover','Обкладинка (затемнення + акцент)'],['plate','Плашка']].map(o=>'<option value="'+o[0]+'">'+o[1]+'</option>').join('')+'</select></label>'
        +'<label style="font-size:12px;color:var(--muted)">Шрифт<br><select id="ptFont" class="txt" style="width:auto;padding:6px 9px;margin-top:2px">'+[['sans','Звичайний'],['serif','Із засічками'],['mono','Моно']].map(o=>'<option value="'+o[0]+'">'+o[1]+'</option>').join('')+'</select></label>'
        +'<label style="font-size:12px;color:var(--muted)">Місце<br><select id="ptPos" class="txt" style="width:auto;padding:6px 9px;margin-top:2px">'+[['bottom','Внизу'],['center','По центру'],['top','Вгорі']].map(o=>'<option value="'+o[0]+'">'+o[1]+'</option>').join('')+'</select></label>'
        +'<label style="font-size:12px;color:var(--muted)">Акцент<br><select id="ptAccent" class="txt" style="width:auto;padding:6px 9px;margin-top:2px">'+[['','без акценту'],['#F6C444','🟡 жовтий'],['#7FD1FF','🔵 блакитний'],['#FF8FA3','🩷 рожевий'],['#9BE58B','🟢 зелений']].map(o=>'<option value="'+o[0]+'">'+o[1]+'</option>').join('')+'</select></label>'
      +'</div>'
      +'<div id="ptCoverExtra" style="display:none;gap:8px;margin-top:8px;flex-wrap:wrap">'
        +'<input class="txt" id="ptKick" placeholder="надзаголовок (напр.: ЕСЕ · 5 ХВИЛИН)" style="flex:1;min-width:150px">'
        +'<input class="txt" id="ptSub" placeholder="підзаголовок одним реченням" style="flex:2;min-width:200px">'
      +'</div>'
      +'<div id="ptMsg2" style="font-size:12px;color:var(--muted);margin-top:8px;min-height:16px"></div>'
      +'<div class="btnrow" style="margin-top:12px;flex-wrap:wrap"><button class="ghost" id="ptBack">← Інше фото</button><button id="ptApply">✍ Накласти текст</button><button class="ghost" id="ptClear"'+(headline?'':' style="display:none"')+'>Прибрати текст</button><button class="primary" id="ptDone">Готово</button></div>'
      +'<div class="hint" style="margin-top:6px">Текст накладається без нової генерації - безкоштовно, пробуй стилі скільки завгодно.</div>';
    card.querySelector('#ptX').onclick=close;
    const msg=card.querySelector('#ptMsg2');
    const setPrev=()=>{ card.querySelector('#ptPrev').innerHTML=prevHtml(); };
    const err=(e)=>{ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; };
    card.querySelector('#ptBack').onclick=()=>step1();
    card.querySelector('#ptDone').onclick=()=>{ if(onDone)onDone(fn); close(); try{loadGuide(true);}catch(e){} };
    card.querySelector('#ptSuggest').onclick=async(e)=>{ const b=e.target; b.disabled=true; msg.style.color='var(--muted)'; msg.textContent='✨ добираю заголовок…';
      try{ const r=await api('/posts/'+postId+'/headline',{method:'POST'}); if(r.headline){ card.querySelector('#ptHead').value=r.headline; msg.style.color='var(--brand)'; msg.textContent='заголовок доповнює пост, не дублює ✓'; } else msg.textContent=''; }
      catch(e2){ err(e2); } finally{ b.disabled=false; } };
    // пресети стилю: обираєш «як має виглядати» - решта параметрів підлаштовується (можна докрутити вручну)
    const PRESETS={minimal:{pos:'bottom',bg:'gradient',align:'left',upper:false,size:'md',extra:false},
      quote:{pos:'center',bg:'none',align:'center',upper:true,size:'lg',extra:false},
      cover:{pos:'top',bg:'tint',align:'left',upper:true,size:'lg',extra:true,defAccent:'#F6C444'},
      plate:{pos:'bottom',bg:'plate',align:'left',upper:false,size:'md',extra:false}};
    let preset='minimal';
    card.querySelector('#ptPreset').onchange=(e)=>{ preset=e.target.value; const p=PRESETS[preset];
      card.querySelector('#ptPos').value=p.pos;
      card.querySelector('#ptCoverExtra').style.display=p.extra?'flex':'none';
      if(p.defAccent&&!card.querySelector('#ptAccent').value) card.querySelector('#ptAccent').value=p.defAccent; };
    card.querySelector('#ptApply').onclick=async(e)=>{ const b=e.target; b.disabled=true; msg.style.color='var(--muted)'; msg.textContent='накладаю текст…'; aiBusy('✍ Накладаю текст на фото…');
      try{ const p=PRESETS[preset]||PRESETS.minimal;
        const body={headline:card.querySelector('#ptHead').value,overlay:true,
          position:card.querySelector('#ptPos').value,font:card.querySelector('#ptFont').value,
          bg:p.bg,align:p.align,upper:p.upper,size:p.size,
          accent:card.querySelector('#ptAccent').value||'',
          kicker:p.extra?(card.querySelector('#ptKick').value||''):'',
          subtitle:p.extra?(card.querySelector('#ptSub').value||''):''};
        const r=await api('/posts/'+postId+'/image-text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        fn=r.filename; headline=body.headline; setPrev(); card.querySelector('#ptClear').style.display=''; if(onDone)onDone(fn); msg.style.color='var(--brand)'; msg.textContent='готово ✓ (спробуй інший стиль - це безкоштовно)'; }
      catch(e2){ err(e2); } finally{ b.disabled=false; aiDone(); } };
    card.querySelector('#ptClear').onclick=async(e)=>{ const b=e.target; b.disabled=true; msg.style.color='var(--muted)'; msg.textContent='прибираю текст…';
      try{ const r=await api('/posts/'+postId+'/image-text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({headline:'',overlay:false})}); fn=r.filename; headline=''; setPrev(); b.style.display='none'; if(onDone)onDone(fn); msg.style.color='var(--brand)'; msg.textContent='текст прибрано ✓'; }
      catch(e2){ err(e2); } finally{ b.disabled=false; } };
    const rg=card.querySelector('#ptRegen'); if(rg) rg.onclick=async(e)=>{ const b=e.target; b.disabled=true; const note=(card.querySelector('#ptRegenNote').value||'').trim();
      msg.style.color='var(--muted)'; msg.textContent='перемальовую… (10-30с)'; aiBusy('🔁 Перемальовую зображення… (10-30с)');
      try{ const p=lastPrompt+(note?('. Зміни: '+note):''); const r=await api('/posts/'+postId+'/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p,aspect})});
        fn=r.filename; lastPrompt=p; headline=''; setPrev(); card.querySelector('#ptClear').style.display='none'; if(onDone)onDone(fn); msg.style.color='var(--brand)'; msg.textContent='готово ✓ (текст наклади заново)'; card.querySelector('#ptRegenNote').value=''; }
      catch(e2){ err(e2); } finally{ b.disabled=false; aiDone(); } };
  }

  if(fn&&hasBase) step2(); else step1();
}
function openDayScheduler(iso){
  const posts=(Pub&&Pub.bank)?Pub.bank:[];
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='62';
  const list=posts.length?posts.map(p=>'<div class="card" data-id="'+p.id+'" style="cursor:pointer;margin-bottom:8px">'+esc((p.content||'').replace(/\n+/g,' ').slice(0,90))+'…</div>').join(''):'<div class="empty">Немає затверджених постів. Затвердь пост у «Студії».</div>';
  ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px"><b>Що запланувати на '+iso+'?</b><div style="margin-top:12px">'+list+'</div><div class="btnrow"><button class="ghost" id="dsClose">Закрити</button></div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
  ov.querySelector('#dsClose').onclick=close;
  ov.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=()=>{ close(); openComposer(c.dataset.id,{scheduledAt:zonedToUTCISO(iso,'11:00')}); });
}

// ---------- прогін ----------
function updRunLabel(){ const rl=$('runLabel'); if(rl) rl.textContent = runId ? ('Прогін '+runId.slice(0,8)) : 'Новий прогін'; const lh=$('lockHint'); if(lh) lh.textContent = runId ? 'Прогін створено з цього транскрипту. «Новий прогін», щоб почати з іншого тексту.' : ''; }
async function refresh(){ if(!runId) return; const d=await api('/runs/'+runId); applyState(d); }
async function ensureRun(){
  const transcript=$('transcript').value.trim();
  if(transcript){ const r=await api('/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript})}); if(r.error) throw new Error(r.error); runId=r.runId; localStorage.setItem('kg_run',runId); $('transcript').value=''; updRunLabel(); return runId; }
  if(runId) return runId;
  throw new Error('Спершу вставте транскрипт у вкладці «Джерела».');
}
function setBusy(b){ busy=b; document.querySelectorAll('#pipe button, #runAll, #genPostsBtn, #studioMore').forEach(x=>x.disabled=b); const sb=$('stopBtn'); if(sb){ sb.style.display=b?'block':'none'; if(!b) sb.textContent='⛔ Зупинити'; } }
function ideaOpts(){ return { count: Math.max(1,Math.min(12,(+($('ideaCount')&&$('ideaCount').value))||6)), rubrics: [...document.querySelectorAll('.ideaRub:checked')].map(c=>c.value) }; }
function renderIdeaRubrics(){ const o=$('ideaRubrics'); if(!o) return; o.innerHTML = Rubrics.length ? Rubrics.map(r=>'<label class="rchip"><input type="checkbox" class="ideaRub" value="'+esc(r.name)+'" checked> '+(r.emoji||'')+' '+esc(r.name)+'</label>').join('') : '<div class="empty">нема рубрик</div>'; o.querySelectorAll('.rchip').forEach(l=>{ const cb=l.querySelector('input'); const upd=()=>l.classList.toggle('on',cb.checked); upd(); cb.addEventListener('change',upd); }); }
async function run(n){
  if(busy) return; setBusy(true); aiBusy('⚙️ Виконую крок конвеєра…');
  try{ await ensureRun(); badge(n,'run','<span class="spin"></span> генерую'); stepEl(n).classList.remove('stale');
    const body=n===1?JSON.stringify(ideaOpts()):null;
    await api('/runs/'+runId+'/steps/'+STEP[n]+'/run', body?{method:'POST',headers:{'Content-Type':'application/json'},body}:{method:'POST'}); await refresh();
  }catch(e){ badge(n,'stale','помилка'); const o=$('o'+n); if(o) o.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
  finally{ setBusy(false); aiDone(); }
}
async function runFrom(startN){
  if(busy) return; setBusy(true); aiBusy('⚙️ Проганяю конвеєр (кілька кроків, зачекай)…');
  try{ await ensureRun(); for(const k of ORDER.slice(ORDER.indexOf(startN))) badge(k,'run','<span class="spin"></span> у черзі');
    const body=startN===1?JSON.stringify(ideaOpts()):null;
    await api('/runs/'+runId+'/run-from/'+STEP[startN], body?{method:'POST',headers:{'Content-Type':'application/json'},body}:{method:'POST'});
  }catch(e){ flash('⚠ '+e.message); }
  finally{ try{ await refresh(); }catch(_){} setBusy(false); aiDone(); }
}
async function genPosts(){
  if(busy) return;
  let rid; try{ rid=await ensureRun(); }catch(e){ try{ const r=await api('/generate/from-brand',{method:'POST'}); rid=r.runId; runId=rid; localStorage.setItem('kg_run',rid); updRunLabel(); }catch(e2){ go('brand'); flash('Спершу заповни Базу бренду (ніша й аудиторія).'); return; } }
  setBusy(true); setLayout('studio');
  const cnt=Number(($('ideaCount')||{}).value)||6;
  aiBusy('✨ Генерую '+cnt+' чорновиків у твоєму голосі…');
  try{ const r=await api('/runs/'+rid+'/generate-lite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:cnt})}); await refresh(); flash('Готово - '+(r.count||0)+' чорновиків на перегляд. Відкрий чорновик, підлаштуй під канали й заплануй.'); loadTasks(); }
  catch(e){ flash('⚠ '+e.message); try{await refresh();}catch(_){} }
  finally{ setBusy(false); aiDone(); }
}
$('genPostsBtn').onclick=openAddMaterial; // топбар: завжди «＋ Додати матеріал» (генерація живе в діях матеріалів/ідей)
async function genIdeas(){
  if(busy) return;
  let rid; try{ rid=await ensureRun(); }catch(e){ try{ const r=await api('/generate/from-brand',{method:'POST'}); rid=r.runId; runId=rid; localStorage.setItem('kg_run',rid); updRunLabel(); }catch(e2){ go('brand'); flash('Спершу заповни Базу бренду (ніша й аудиторія).'); return; } }
  const m=$('ideasMsg'); if(m){ m.style.color='var(--muted)'; m.innerHTML='<span class="spin"></span> думаю…'; } setBusy(true); aiBusy('💡 Шукаю контент-ідеї…');
  const cnt=Number(($('ideaCount')||{}).value)||6;
  try{ const r=await api('/runs/'+rid+'/ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:cnt})}); renderIdeaList(r.ideas||[]); if(m)m.textContent=''; }
  catch(e){ if(m){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } }
  finally{ setBusy(false); aiDone(); }
}
function renderIdeaList(ideas){
  const el=$('ideaList'); if(!el) return;
  if(!ideas.length){ el.innerHTML='<div class="empty">Ідей нема - спробуй ще.</div>'; $('ideasToPosts').style.display='none'; return; }
  el.innerHTML=ideas.map(it=>'<label class="rchip on ideaChip" style="display:flex;gap:8px;align-items:flex-start;text-align:left;width:100%;padding:9px 12px;font-weight:500;line-height:1.4;margin-bottom:5px"><input type="checkbox" class="ideaCb" data-idea="'+esc(it.idea)+'" checked><span class="ideaCk" style="font-weight:800">✓</span><span style="flex:1">'+esc(it.idea)+'</span></label>').join('');
  el.querySelectorAll('.ideaChip').forEach(l=>{ const cb=l.querySelector('input'); const upd=()=>{ l.classList.toggle('on',cb.checked); const ck=l.querySelector('.ideaCk'); if(ck) ck.style.visibility=cb.checked?'visible':'hidden'; }; upd(); cb.addEventListener('change',upd); });
  $('ideasToPosts').style.display='block';
}
if($('genIdeas')) $('genIdeas').onclick=genIdeas;
// 🧵 тейки для Threads: N коротких чернеток з Банку ідей/щоденника (падають у глобальний пул Студії)
if($('takesCfg')) $('takesCfg').onclick=()=>{ selectView('settings'); setSTab('channels'); };
if($('genTakes')) $('genTakes').onclick=async()=>{ const b=$('genTakes'), m=$('takesMsg'); b.disabled=true; m.style.color='var(--muted)'; m.textContent='пишу тейки…'; aiBusy('🧵 Пишу тейки для Threads…');
  try{ const r=await api('/posts/threads-takes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:5})});
    m.style.color='var(--brand)'; m.textContent='+'+r.created+' чернеток ✓'; try{ await loadStudioPosts(); }catch(_){ } }
  catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }
  finally{ b.disabled=false; aiDone(); setTimeout(()=>{ m.textContent=''; },5000); } };
if($('ideasToPosts')) $('ideasToPosts').onclick=async()=>{
  const picked=Array.from(document.querySelectorAll('#ideaList .ideaCb:checked')).map(c=>c.dataset.idea).filter(Boolean);
  if(!picked.length){ flash('Обери хоча б одну ідею'); return; }
  if(busy||!runId) return; setBusy(true); setLayout('studio'); aiBusy('✨ Створюю пости з обраних ідей…');
  try{ const r=await api('/runs/'+runId+'/generate-lite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ideas:picked})}); await refresh(); flash('Готово - '+(r.count||0)+' постів на перегляд.'); loadTasks(); }
  catch(e){ flash('⚠ '+e.message); }
  finally{ setBusy(false); aiDone(); }
};
if($('viewPrompt')) $('viewPrompt').onclick=async()=>{ try{ const cnt=Number(($('ideaCount')||{}).value)||6; const r=await api('/generate/prompt-preview?count='+cnt); const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70'; ov.innerHTML='<div class="modal-card" style="max-width:680px;padding:20px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b>Спільний промт генерації · '+esc(r.model||'')+'</b><button class="icon" id="vpX" style="margin-left:auto">✕</button></div><pre style="white-space:pre-wrap;font-size:12.5px;line-height:1.5;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:60vh;overflow:auto;margin:0">'+esc(r.system||'')+'</pre></div>'; document.body.appendChild(ov); const close=()=>ov.remove(); ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#vpX').onclick=close; }catch(e){ flash('⚠ '+e.message); } };
function renderLegacyPlan(){ // СТАРИЙ конвеєрний план (#o7/S.plan) - не плутати з renderPlan() скелета вкладки «План»
  const o=$('o7'); if(!o) return;
  if(!S.plan.length){ o.innerHTML='<div class="empty">План з\'явиться тут. Затверджені пости підуть у Банк (вкладка Публікація).</div>'; return; }
  o.innerHTML=S.plan.map(p=>{ const prev=((p.content||p.title||'')).replace(/\n+/g,' ').slice(0,140); return '<div class="card"><div>'+esc(prev)+'…</div><small style="color:var(--muted)">'+esc(p.type||'пост')+'</small></div>'; }).join('');
}

// ---------- Публікація ----------
async function loadPublish(){ try{ const [bank,slots]=await Promise.all([api('/bank'),api('/schedule')]); Pub.bank=bank||[]; Pub.slots=slots||[]; renderBank(); renderCal(); }catch(e){} }
// 🏦 Банк: 3 перемикачі замість тьмяніння (раніше «вже в календарі» й «опубліковані» виглядали
// однаково приглушеними, і розділити їх було ніяк). Нові = затверджені, ще не в календарі й не в мережі.
let BankTab='new';
function renderBank(){
  const o=$('bank'); if(!o) return; const sch=new Set(Pub.slots.map(s=>s.post_id));
  const isPub=(p)=>!!p.sent, inCal=(p)=>sch.has(p.id)&&!p.sent;
  const groups={ new:Pub.bank.filter(p=>!isPub(p)&&!inCal(p)), cal:Pub.bank.filter(inCal), pub:Pub.bank.filter(isPub) };
  if($('btNew')) $('btNew').textContent=groups.new.length;
  if($('btCal')) $('btCal').textContent=groups.cal.length;
  if($('btPub')) $('btPub').textContent=groups.pub.length;
  document.querySelectorAll('#bankTabs .tab').forEach(x=>x.classList.toggle('on',x.dataset.bt===BankTab));
  const HINT={ new:'Перетягни картку на день у календарі (час за замовч. 09:00) або «AI-розподіл».',
    cal:'Ці пости вже стоять у календарі й вийдуть автоматично у свій час.',
    pub:'Уже опубліковані - лишаються як історія публікацій і аналітика.' };
  if($('bankHint')) $('bankHint').textContent=HINT[BankTab]||'';
  const show=groups[BankTab]||[];
  if(!show.length){ o.innerHTML='<div class="empty">'+(BankTab==='new'?'Порожньо. Затвердь пости в Чорновиках - вони зʼявляться тут.':'Тут поки нічого.')+'</div>'; return; }
  o.innerHTML='';
  show.forEach(p=>{ const placed=BankTab!=='new';
    const c=document.createElement('div'); c.className='chip'+(placed?' placed':'');
    c.draggable=BankTab==='new'; c.dataset.post=p.id;   // тягнути в календар має сенс лише для «нових»
    c.innerHTML='<b>'+esc((p.content||'').replace(/\n+/g,' ').slice(0,46))+'</b><small>'+(p.source_title?esc(p.source_title):'джерело')+(BankTab==='cal'?' · у календарі':(BankTab==='pub'?' · ✈️ опубліковано':''))+'</small>';
    if(BankTab==='new') c.addEventListener('dragstart',ev=>ev.dataTransfer.setData('text/plain','post:'+p.id));
    o.appendChild(c);
  });
}
document.querySelectorAll('#bankTabs .tab').forEach(x=>x.onclick=()=>{ BankTab=x.dataset.bt; renderBank(); });
function calMonday(){ // «сьогодні» за поясом воркспейсу (TZ), якір - полудень UTC, щоб DST не зсував дату
  const [Y,M,D]=locDate(new Date()).split('-').map(Number);
  const d=new Date(Date.UTC(Y,M-1,D,12,0,0));
  const day=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-day); return d;
}
// режими календаря: «тиждень» (7 високих колонок, повний контент дня) і «місяць» (класична сітка); CalOff - зсув ‹›
let CalMode=localStorage.getItem('kg_calmode')||'week', CalOff=0;
const MONTHS_UK=['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
function addDaysISO(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function isoOf(d){ return d.toISOString().slice(0,10); }
function renderCal(){
  const wrap=$('cal'); if(!wrap) return; wrap.innerHTML='';
  const byDay={}; Pub.slots.forEach(s=>{ if(!s.scheduled_at) return; const iso=locDate(s.scheduled_at); (byDay[iso]=byDay[iso]||[]).push(s); });
  const todayIso=locDate(new Date());
  // діапазон днів за режимом
  let days=[], label='', dims=new Set();
  if(CalMode==='month'){
    const [Y,M]=locDate(new Date()).split('-').map(Number);
    const first=new Date(Date.UTC(Y, M-1+CalOff, 1, 12));
    label=MONTHS_UK[first.getUTCMonth()]+' '+first.getUTCFullYear();
    const start=addDaysISO(first, -((first.getUTCDay()+6)%7)); // понеділок тижня з 1-м числом
    const last=new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth()+1, 0, 12));
    const end=addDaysISO(last, 6-((last.getUTCDay()+6)%7));    // неділя тижня з останнім числом
    for(let d=new Date(start); d<=end; d=addDaysISO(d,1)){ const iso=isoOf(d); days.push(iso); if(d.getUTCMonth()!==first.getUTCMonth()) dims.add(iso); }
  } else {
    const start=addDaysISO(calMonday(), CalOff*7);
    for(let i=0;i<7;i++) days.push(isoOf(addDaysISO(start,i)));
    const f=days[0].split('-'), l=days[6].split('-');
    label=(+f[2])+'.'+(+f[1])+' – '+(+l[2])+'.'+(+l[1])+'.'+l[0];
  }
  // панель навігації
  const head=document.createElement('div'); head.className='calhead';
  head.innerHTML='<button class="ghost" id="calPrev" style="padding:5px 12px">‹</button><b>'+esc(label)+'</b><button class="ghost" id="calNext" style="padding:5px 12px">›</button>'
    +'<button class="ghost" id="calToday" style="padding:5px 12px">Сьогодні</button><span style="flex:1"></span>'
    +'<div style="display:flex;gap:4px"><button class="'+(CalMode==='week'?'primary':'ghost')+'" id="calWeekB" style="padding:5px 12px">Тиждень</button><button class="'+(CalMode==='month'?'primary':'ghost')+'" id="calMonthB" style="padding:5px 12px">Місяць</button></div>';
  wrap.appendChild(head);
  head.querySelector('#calPrev').onclick=()=>{ CalOff--; renderCal(); };
  head.querySelector('#calNext').onclick=()=>{ CalOff++; renderCal(); };
  head.querySelector('#calToday').onclick=()=>{ CalOff=0; renderCal(); };
  head.querySelector('#calWeekB').onclick=()=>{ CalMode='week'; CalOff=0; localStorage.setItem('kg_calmode','week'); renderCal(); };
  head.querySelector('#calMonthB').onclick=()=>{ CalMode='month'; CalOff=0; localStorage.setItem('kg_calmode','month'); renderCal(); };
  // тиждень = погодинна сітка з вертикальним скролом (пости стоять на своєму часі)
  if(CalMode==='week'){ renderWeekGrid(wrap, days, byDay, todayIso); return; }
  // сітка (місяць)
  const cal=document.createElement('div'); cal.className='cal'+(CalMode==='week'?' week':''); wrap.appendChild(cal);
  ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].forEach(d=>{const h=document.createElement('div');h.className='dow';h.textContent=d;cal.appendChild(h);});
  const maxTxt=CalMode==='week'?70:18; // тиждень показує повний контент дня, місяць - компактні чіпи
  for(const iso of days){
    const cell=document.createElement('div'); cell.className='day'+(dims.has(iso)?' dim':''); cell.dataset.iso=iso;
    if(iso===todayIso){ cell.style.borderColor='var(--brand)'; cell.style.boxShadow='inset 0 0 0 1px var(--brand)'; }
    const [,mmI,ddI]=iso.split('-'); cell.innerHTML='<div class="dn">'+(+ddI)+'.'+(+mmI)+(iso===todayIso?' <span style="color:var(--brand);font-weight:700">сьогодні</span>':'')+'</div>';
    (byDay[iso]||[]).sort((a,b)=>String(a.scheduled_at).localeCompare(String(b.scheduled_at))).forEach(s=>{
      const time=locHM(s.scheduled_at); const st=s.status;
      const icon=st==='posted'?' ✅':(st==='failed'?' ⚠️':(st==='posting'?' ⏳':''));
      const movable=(st==='planned'||st==='failed');
      const ch=document.createElement('div'); ch.className='pchip'+(st==='failed'?' failed':'')+(st==='posted'?' posted':'');
      ch.title=(s.result||(st==='planned'?'заплановано':st))+(movable?' · тягни на інший день':'');
      ch.innerHTML='<b>'+time+icon+'</b> '+chanIcons(s.channels)+' '+esc((s.content||'').replace(/\n+/g,' ').slice(0,maxTxt))
        +(st!=='posted'?'<span class="pchip-x" data-del="'+s.id+'" title="Прибрати з календаря" style="float:right;margin-left:4px;padding:0 4px;border-radius:4px;color:var(--faint);cursor:pointer">✕</span>':'');
      // перетягування запланованого чіпа на інший день (час зберігається)
      if(movable){ ch.draggable=true; ch.addEventListener('dragstart',ev=>{ ev.dataTransfer.setData('text/plain','slot:'+s.id+':'+time); }); }
      ch.onclick=(ev)=>{ ev.stopPropagation();
        if(ev.target.dataset&&ev.target.dataset.del){ if(!confirm('Прибрати пост з календаря? (сам пост лишиться в Студії)')) return;
          api('/schedule/'+ev.target.dataset.del,{method:'DELETE'}).then(()=>loadPublish()).catch(e=>flash('⚠ '+e.message)); return; }
        openComposer(s.post_id,{scheduledAt:s.scheduled_at,slotId:s.id}); };
      cell.appendChild(ch);
    });
    // 📋 привиди-теми з ПЛАНУ: пунктирні картки (це ще НЕ пости) - клік генерує пост із теми
    (PlanAll||[]).filter(p=>String(p.slot_date||'').slice(0,10)===iso&&['empty','matched','drafted'].includes(p.status)).forEach(p=>{
      const g=document.createElement('div'); g.className='pchip ghost';
      const drafted=p.status==='drafted';
      g.title=drafted?'Чернетка готова - відкрити в композері':'Тема з плану (пост ще не створено). Клік = згенерувати пост'+(p.status==='matched'?' зі зметченого матеріалу':'');
      g.innerHTML='<b>'+(drafted?'✍️ чернетка':'📋 тема')+'</b> '+((p.format&&p.format!=='post'&&FMT_META[p.format])?FMT_META[p.format][0]+' ':'')+((p.channel&&p.channel!=='all')?(CP_ICON[p.channel]||'')+' ':'')+esc(String(p.theme||p.rubric||'').replace(/\n+/g,' ').slice(0,maxTxt));
      g.onclick=async(ev)=>{ ev.stopPropagation();
        if(drafted&&p.post_id){ openComposer(p.post_id); return; }
        const from=p.match_source_id?'material':'theme';
        if(!confirm('Згенерувати пост із теми «'+String(p.theme||'').slice(0,80)+'»'+(from==='material'?' (є підібраний матеріал)':'')+'?')) return;
        aiBusy('✨ Генерую пост із теми плану…');
        try{ await api('/plan/slots/'+p.id+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from})}); await loadPlan(); renderCal(); flash('Чернетка готова - у Чорновиках і на цій даті ✓'); }
        catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } };
      cell.appendChild(g);
    });
    cell.addEventListener('dragover',ev=>{ev.preventDefault();cell.classList.add('over');});
    cell.addEventListener('dragleave',()=>cell.classList.remove('over'));
    cell.addEventListener('drop',async ev=>{ev.preventDefault();cell.classList.remove('over');const d=ev.dataTransfer.getData('text/plain');
      try{
        if(d.indexOf('post:')===0){ await api('/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postId:d.slice(5),scheduledAt:zonedToUTCISO(iso,'09:00')})}); await loadPublish(); return; }
        if(d.indexOf('slot:')===0){ const rest=d.slice(5); const sep=rest.indexOf(':'); const slotId=sep>0?rest.slice(0,sep):rest; const time=sep>0?rest.slice(sep+1):'09:00';
          await api('/schedule/'+slotId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduledAt:zonedToUTCISO(iso,time||'09:00')})}); await loadPublish(); return; }
      }catch(e){ flash('⚠ '+e.message); } });
    cell.addEventListener('click',ev=>{ if(ev.target.closest('.pchip')) return; openDayScheduler(iso); });
    cal.appendChild(cell);
  }
}
// Тижнева ПОГОДИННА сітка: колонка годин + 7 днів, чіпи стоять на своєму часі, скрол по вертикалі.
// Дроп чіпа/поста на колонку ставить і ДЕНЬ, і ЧАС (з кроком 15 хв). Теми з плану (без часу) - у смузі зверху.
function renderWeekGrid(wrap, days, byDay, todayIso){
  const HPX=52, DOWS=['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];
  const twk=document.createElement('div'); twk.className='twk'; wrap.appendChild(twk);
  // шапка: дні
  const head=document.createElement('div'); head.className='twk-head';
  head.innerHTML='<div></div>'+days.map((iso,i)=>{ const [,mm,dd]=iso.split('-');
    return '<div class="dh'+(iso===todayIso?' today':'')+'">'+DOWS[i]+' '+(+dd)+'.'+(+mm)+'</div>'; }).join('');
  twk.appendChild(head);
  // смуга «без часу»: привиди-теми з плану (пост ще не створено / чернетка без слота в календарі)
  const ghosts={}; let anyGhost=false;
  days.forEach(iso=>{ ghosts[iso]=(PlanAll||[]).filter(p=>String(p.slot_date||'').slice(0,10)===iso&&['empty','matched','drafted'].includes(p.status)); if(ghosts[iso].length) anyGhost=true; });
  if(anyGhost){
    const ad=document.createElement('div'); ad.className='twk-allday';
    ad.innerHTML='<div style="font-size:9.5px;color:var(--faint);display:flex;align-items:center;justify-content:center">план</div>';
    days.forEach(iso=>{ const c=document.createElement('div'); c.className='ad';
      ghosts[iso].forEach(p=>{ const drafted=p.status==='drafted';
        const g=document.createElement('div'); g.className='pchip ghost'; g.style.position='static';
        g.title=drafted?'Чернетка готова - відкрити в композері':'Тема з плану (пост ще не створено). Клік = згенерувати пост'+(p.status==='matched'?' зі зметченого матеріалу':'');
        g.innerHTML='<b>'+(drafted?'✍️':'📋')+'</b> '+((p.channel&&p.channel!=='all')?(CP_ICON[p.channel]||'')+' ':'')+esc(String(p.theme||p.rubric||'').replace(/\n+/g,' ').slice(0,26));
        g.onclick=async(ev)=>{ ev.stopPropagation();
          if(drafted&&p.post_id){ openComposer(p.post_id); return; }
          const from=p.match_source_id?'material':'theme';
          if(!confirm('Згенерувати пост із теми «'+String(p.theme||'').slice(0,80)+'»'+(from==='material'?' (є підібраний матеріал)':'')+'?')) return;
          aiBusy('✨ Генерую пост із теми плану…');
          try{ await api('/plan/slots/'+p.id+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from})}); await loadPlan(); renderCal(); flash('Чернетка готова - у Чорновиках і на цій даті ✓'); }
          catch(e){ flash('⚠ '+e.message); } finally{ aiDone(); } };
        c.appendChild(g); });
      ad.appendChild(c); });
    twk.appendChild(ad);
  }
  // скрол-зона з годинами
  const sc=document.createElement('div'); sc.className='twk-scroll'; twk.appendChild(sc);
  const grid=document.createElement('div'); grid.className='twk-grid'; sc.appendChild(grid);
  const hoursCol=document.createElement('div'); hoursCol.className='twk-hours';
  for(let h=0;h<24;h++){ const l=document.createElement('div'); l.className='hl'; l.textContent=(h<10?'0':'')+h+':00'; hoursCol.appendChild(l); }
  grid.appendChild(hoursCol);
  const yToTime=(y)=>{ const mins=Math.max(0,Math.min(23*60+45, Math.round(y/HPX*60/15)*15)); const h=Math.floor(mins/60), m=mins%60; return (h<10?'0':'')+h+':'+(m<10?'0':'')+m; };
  days.forEach(iso=>{
    const col=document.createElement('div'); col.className='twk-col'+(iso===todayIso?' today':''); col.style.height=(24*HPX)+'px'; col.dataset.iso=iso;
    let lastBottom=-9;
    (byDay[iso]||[]).sort((a,b)=>String(a.scheduled_at).localeCompare(String(b.scheduled_at))).forEach(s=>{
      const time=locHM(s.scheduled_at); const st=s.status;
      const icon=st==='posted'?' ✅':(st==='failed'?' ⚠️':(st==='posting'?' ⏳':''));
      const movable=(st==='planned'||st==='failed');
      const ch=document.createElement('div'); ch.className='pchip'+(st==='failed'?' failed':'')+(st==='posted'?' posted':'');
      ch.title=(s.result||(st==='planned'?'заплановано':st))+(movable?' · тягни на інший день/час':'');
      ch.innerHTML='<b>'+time+icon+'</b> '+chanIcons(s.channels)+' '+esc((s.content||'').replace(/\n+/g,' ').slice(0,60))
        +(st!=='posted'?'<span class="pchip-x" data-del="'+s.id+'" title="Прибрати з календаря" style="float:right;margin-left:4px;padding:0 4px;border-radius:4px;color:var(--faint);cursor:pointer">✕</span>':'');
      const [hh,mm]=time.split(':').map(Number);
      let top=(hh*60+mm)/60*HPX;
      if(top<lastBottom+2) top=lastBottom+2; // чіпи на близький час не накладаються
      ch.style.top=top+'px';
      if(movable){ ch.draggable=true; ch.addEventListener('dragstart',ev=>{ ev.dataTransfer.setData('text/plain','slot:'+s.id+':'+time); }); }
      ch.onclick=(ev)=>{ ev.stopPropagation();
        if(ev.target.dataset&&ev.target.dataset.del){ if(!confirm('Прибрати пост з календаря? (сам пост лишиться в Студії)')) return;
          api('/schedule/'+ev.target.dataset.del,{method:'DELETE'}).then(()=>loadPublish()).catch(e=>flash('⚠ '+e.message)); return; }
        openComposer(s.post_id,{scheduledAt:s.scheduled_at,slotId:s.id}); };
      col.appendChild(ch);
      lastBottom=top+(ch.offsetHeight||42);
    });
    col.addEventListener('dragover',ev=>{ev.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',()=>col.classList.remove('over'));
    col.addEventListener('drop',async ev=>{ ev.preventDefault(); col.classList.remove('over');
      const d=ev.dataTransfer.getData('text/plain');
      const time=yToTime(ev.clientY-col.getBoundingClientRect().top); // час = точка дропу (крок 15 хв)
      try{
        if(d.indexOf('post:')===0){ await api('/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postId:d.slice(5),scheduledAt:zonedToUTCISO(iso,time)})}); await loadPublish(); return; }
        if(d.indexOf('slot:')===0){ const rest=d.slice(5); const sep=rest.indexOf(':'); const slotId=sep>0?rest.slice(0,sep):rest;
          await api('/schedule/'+slotId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scheduledAt:zonedToUTCISO(iso,time)})}); await loadPublish(); return; }
      }catch(e){ flash('⚠ '+e.message); } });
    col.addEventListener('click',ev=>{ if(ev.target.closest('.pchip')) return; openDayScheduler(iso); });
    grid.appendChild(col);
  });
  // лінія «зараз» у сьогоднішньому дні
  if(days.includes(todayIso)){
    const nowHM=locHM(new Date()); const [nh,nm]=nowHM.split(':').map(Number);
    const line=document.createElement('div'); line.className='twk-now'; line.style.top=((nh*60+nm)/60*HPX)+'px';
    grid.appendChild(line);
    sc.scrollTop=Math.max(0,(nh-2)*HPX); // відкриваємось біля поточного часу
  } else { sc.scrollTop=7.5*HPX; } // інший тиждень - від ~7:30 ранку
}
// ---------- wiring ----------
document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>run(+b.dataset.run));
document.querySelectorAll('[data-from]').forEach(b=>b.onclick=()=>runFrom(+b.dataset.from));
$('runAll').onclick=async()=>{ await runFrom(1); setLayout('studio'); flash('Готово - переглянь і затвердь пости.'); };
$('stopBtn').onclick=async()=>{ if(!runId) return; $('stopBtn').textContent='⛔ зупиняю…'; try{ await api('/runs/'+runId+'/cancel',{method:'POST'}); }catch(e){} };
$('sampleBtn').onclick=()=>{ $('transcript').value=SAMPLE; };
$('toCreate').onclick=async()=>{
  const transcript=$('transcript').value.trim();
  if(!transcript){ flash('Спершу вставте транскрипт або імпортуйте джерело.'); return; }
  try{ const r=await api('/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript})}); if(r.error) throw new Error(r.error);
    runId=r.runId; localStorage.setItem('kg_run',runId);
    ['o1','o3','o4','o5','o6','o7'].forEach(id=>{const e=$(id); if(e) e.innerHTML='<div class="empty">-</div>';});
    ORDER.forEach(n=>{badge(n,'','очікує');stepEl(n).classList.remove('done','stale');});
    $('transcript').value=''; updRunLabel(); go('create'); setLayout('pipeline'); refresh().catch(()=>{});
  }catch(e){ flash('Помилка: '+e.message); }
};
$('autopilotBtn').onclick=async()=>{
  const transcript=$('transcript').value.trim();
  if(!transcript){ flash('Спершу вставте транскрипт або імпортуйте джерело.'); return; }
  if(!confirm('Автопілот прожене ВСЮ кишку (кілька AI-викликів, ~1-2 хв) і покладе пости на підтвердження. Продовжити?')) return;
  const btn=$('autopilotBtn'); const old=btn.textContent; btn.disabled=true; btn.textContent='🟢 працюю…';
  try{ const r=await api('/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript})}); if(r.error) throw new Error(r.error);
    runId=r.runId; localStorage.setItem('kg_run',runId); $('transcript').value=''; updRunLabel();
    go('create'); setLayout('studio'); ORDER.forEach(n=>badge(n,'run','<span class="spin"></span> у черзі'));
    await api('/runs/'+runId+'/autopilot',{method:'POST'}); await refresh(); flash('Готово! Перегляньте й затвердьте пости у «Студії».');
  }catch(e){ flash('Помилка: '+e.message); try{ await refresh(); }catch(_){} }
  finally{ btn.disabled=false; btn.textContent=old; }
};
$('aiDistribute').onclick=async()=>{ if(!confirm('Перерозподілити всі незапощені пости за розкладом зі Стратегії? Раніше заплановані (але не опубліковані) слоти буде перекладено.')) return; const m=$('pubMsg'); m.style.color='var(--muted)'; m.textContent='розподіляю…'; aiBusy('🗓 Розподіляю пости по календарю за стратегією…'); try{ const r=await api('/schedule/auto',{method:'POST'}); m.style.color='var(--brand)'; m.textContent='розподілено: '+r.count; await loadPublish(); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }finally{ aiDone(); } };
$('reloadPub').onclick=()=>loadPublish();
$('newRun').onclick=()=>{
  if(busy) return;
  if(runId && !confirm('Почати новий прогін? Поточні результати лишаться на сервері, але зникнуть з екрана.')) return;
  runId=null; localStorage.removeItem('kg_run'); S={plan:[],schedule:{}};
  ['o1','o3','o4','o5','o6','o7'].forEach(id=>{const e=$(id); if(e) e.innerHTML='<div class="empty">-</div>';});
  $('transcript').value='';
  ORDER.forEach(n=>{badge(n,'','очікує');stepEl(n).classList.remove('done','stale');});
  renderStudio(); renderInbox(); renderStudioSteps({}); renderSourceCard(null);
  updRunLabel();
};
$('logoutBtn').onclick=async()=>{ try{ await api('/auth/logout',{method:'POST'}); }catch(e){} location.href='/login'; };

// ---------- Telegram / Threads / Meta ----------
async function loadTelegram(){ try{ const c=await api('/integrations/telegram'); $('tgChannel').value=c.channelChatId||''; $('tgGroup').value=c.groupChatId||''; if(c.hasToken) $('tgToken').placeholder='•••••••• (токен збережено - лиши порожнім, щоб не міняти)'; if($('tgSharedBox')) $('tgSharedBox').style.display=c.sharedBot?'block':'none';
  // спільний бот є, але його DM мертві на цьому інстансі (бета) - кажемо це ДО кліку, а кнопку
  // підключення глушимо: інакше вона видає посилання, яке нікуди не веде
  const off=c.sharedBot&&c.sharedDm===false; if($('tgSharedOff')) $('tgSharedOff').style.display=off?'block':'none';
  if($('tgConnectBot')){ $('tgConnectBot').disabled=!!off; $('tgConnectBot').title=off?'У цьому середовищі спільний бот не приймає повідомлень - підключи власного бота нижче':''; } if($('tgConnMsg')&&c.channelTitle) $('tgConnMsg').innerHTML='✅ підключено: <b>'+esc(c.channelTitle)+'</b>'; }catch(e){} }
if($('tgConnectBot')) $('tgConnectBot').onclick=async()=>{ const m=$('tgConnMsg'); m.style.color='var(--muted)'; m.textContent='…'; try{ const r=await api('/integrations/telegram/connect-link',{method:'POST'}); const steps=$('tgBotSteps'); if(steps){ steps.style.display='block'; steps.innerHTML='1) Відкрий <a href="'+r.link+'" target="_blank"><b>@'+esc(r.bot)+'</b></a> → натисни <b>Start</b>.<br>2) Додай бота <b>адміном</b> у свій канал.<br>3) Перешли боту будь-який пост із каналу.<br>Потім онови цю сторінку - канал зʼявиться тут.'; } m.textContent=''; window.open(r.link,'_blank'); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } };
async function loadThreads(){
  try{ const c=await api('/integrations/threads'); const st=$('thStatus'), conn=$('thConnect'), dis=$('thDisconnect'); if(!st) return;
    if(!c.configured){ st.textContent='🕓 Підключення Threads тимчасово недоступне.'; if(conn)conn.style.display='none'; if(dis)dis.style.display='none'; return; }
    if(c.hasToken){ st.innerHTML='✅ Підключено'+(c.username?(' як <b>@'+esc(c.username)+'</b>'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; if($('thStratBox'))$('thStratBox').style.display=''; }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; if($('thStratBox'))$('thStratBox').style.display='none'; }
  }catch(e){}
}
$('thDisconnect').onclick=async()=>{ if(!confirm('Відключити Threads?')) return; try{ await api('/integrations/threads/disconnect',{method:'POST'}); await loadThreads(); }catch(e){} };
// Threads не віддає списку акаунтів (на відміну від FB-сторінок): підключається той профіль,
// під яким ти залогінений у threads.net. Тому перед OAuth - крок «який акаунт підключаємо».
function openThreadsConnect(){
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='70';
  ov.innerHTML='<div class="modal-card" style="max-width:480px;padding:20px">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:16px">🧵 Який Threads підключаємо?</b><button class="icon" id="tcX" style="margin-left:auto">✕</button></div>'
    +'<div style="font-size:13px;color:var(--ink2);line-height:1.6">Підключиться акаунт, під яким ти <b>зараз залогінений у Threads</b> у цьому браузері. Якщо акаунтів кілька - спершу перемкнись на потрібний.</div>'
    +'<div class="btnrow" style="margin-top:14px;flex-wrap:wrap">'
    +'<a class="btn ghost" href="https://www.threads.net/settings" target="_blank" rel="noopener">🔄 Перемкнути акаунт у Threads</a>'
    +'<button class="primary" id="tcGo" style="margin-left:auto">✓ Так, підключити цей</button></div>'
    +'<div class="hint" style="margin-top:8px">Перемкнув? Повернись сюди і натисни «Підключити цей». У вікні авторизації Threads теж можна змінити акаунт.</div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#tcX').onclick=close;
  ov.querySelector('#tcGo').onclick=()=>{ close(); connectPopup('/api/integrations/threads/connect'); };
  return false;
}
async function loadLinkedin(){
  try{ const c=await api('/integrations/linkedin'); const st=$('liStatus'), conn=$('liConnect'), dis=$('liDisconnect'); if(!st) return;
    if(!c.configured){ st.textContent='🕓 Скоро: чекаємо схвалення застосунку від LinkedIn.'; if(conn)conn.style.display='none'; if(dis)dis.style.display='none'; return; }
    if(c.hasToken&&c.expired){ st.innerHTML='⚠ Токен протух (60 днів) - перепідключи.'; if(conn){conn.style.display='inline-flex'; conn.textContent='🔄 Перепідключити';} if(dis)dis.style.display='inline-flex'; }
    else if(c.hasToken){ st.innerHTML='✅ Підключено'+(c.name?(' як <b>'+esc(c.name)+'</b>'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; }
  }catch(e){}
}
if($('liDisconnect')) $('liDisconnect').onclick=async()=>{ if(!confirm('Відключити LinkedIn?')) return; try{ await api('/integrations/linkedin/disconnect',{method:'POST'}); await loadLinkedin(); }catch(e){} };
async function loadYoutube(){
  try{ const c=await api('/integrations/youtube'); const st=$('ytStatus'), conn=$('ytConnect'), dis=$('ytDisconnect'); if(!st) return;
    if(!c.configured){ st.textContent='🕓 Підключення YouTube тимчасово недоступне.'; if(conn)conn.style.display='none'; if(dis)dis.style.display='none'; return; }
    if(c.hasToken){ st.innerHTML='✅ Підключено'+(c.name?(' канал <b>'+esc(c.name)+'</b>'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; }
  }catch(e){}
}
if($('ytDisconnect')) $('ytDisconnect').onclick=async()=>{ if(!confirm('Відключити YouTube?')) return; try{ await api('/integrations/youtube/disconnect',{method:'POST'}); await loadYoutube(); }catch(e){} };
async function loadTiktok(){
  try{ const c=await api('/integrations/tiktok'); const st=$('ttStatus'), conn=$('ttConnect'), dis=$('ttDisconnect'); if(!st) return;
    if(!c.configured){ st.textContent='🕓 Скоро: чекаємо схвалення застосунку від TikTok.'; if(conn)conn.style.display='none'; if(dis)dis.style.display='none'; return; }
    if(c.hasToken){ st.innerHTML='✅ Підключено'+(c.name?(' як <b>'+esc(c.name)+'</b>'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; }
  }catch(e){}
}
if($('ttDisconnect')) $('ttDisconnect').onclick=async()=>{ if(!confirm('Відключити TikTok?')) return; try{ await api('/integrations/tiktok/disconnect',{method:'POST'}); await loadTiktok(); }catch(e){} };
// 🎥 персональна b-roll бібліотека (вставки з автором у рілсах)
async function loadBroll(){
  const list=$('brollList'); if(!list) return;
  try{ const rows=await api('/media'); const br=(rows||[]).filter(m=>m.source==='broll');
    list.innerHTML=br.length?br.map(m=>'<div style="position:relative;border:1px solid var(--line);border-radius:9px;overflow:hidden;width:110px"><video src="/media/'+esc(m.filename)+'" style="width:110px;height:150px;object-fit:cover;display:block" muted preload="metadata"></video><button class="icon brDel" data-id="'+m.id+'" title="Видалити" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.55);color:#fff;border-radius:6px">✕</button></div>').join('')
      :'<div style="font-size:12.5px;color:var(--faint)">Поки порожньо - завантаж перші відео з собою в кадрі.</div>';
    list.querySelectorAll('.brDel').forEach(b=>b.onclick=async()=>{ if(!confirm('Видалити це відео з бібліотеки?')) return; try{ await api('/media/'+b.dataset.id,{method:'DELETE'}); loadBroll(); }catch(e){ flash('⚠ '+e.message); } });
  }catch(e){}
}
if($('brollUpload')) $('brollUpload').onclick=async()=>{ const inp=$('brollFile'), msg=$('brollMsg'); const files=inp&&inp.files; if(!files||!files.length){ msg.textContent='обери відео-файли'; return; }
  msg.textContent='завантаження…';
  try{ const fd=new FormData(); for(const f of files) fd.append('file',f);
    const r=await fetch('/api/media?source=broll',{method:'POST',body:fd,credentials:'same-origin'}); const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
    msg.textContent='✓ додано '+(j.saved||[]).length; inp.value=''; loadBroll();
  }catch(e){ msg.textContent='⚠ '+e.message; } };
async function loadMeta(){
  try{ const c=await api('/integrations/meta'); const st=$('mtStatus'), conn=$('mtConnect'), dis=$('mtDisconnect'), stats=$('mtStats'); if(!st) return;
    if(!c.configured){ st.textContent='🕓 Підключення Facebook/Instagram тимчасово недоступне.'; [conn,dis,stats].forEach(b=>b&&(b.style.display='none')); return; }
    const row=$('mtPageRow');
    if(c.hasToken){ st.innerHTML='✅ Підключено'+(c.pageName?(' · FB: <b>'+esc(c.pageName)+'</b>'):'')+(c.igUsername?(' · IG: <b>@'+esc(c.igUsername)+'</b>'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; if(stats)stats.style.display='inline-flex'; if($('mtVoice'))$('mtVoice').style.display=c.igUsername?'inline-flex':'none'; if(row)row.style.display='flex'; loadMetaPages(); }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; if(stats)stats.style.display='none'; if($('mtVoice'))$('mtVoice').style.display='none'; if(row)row.style.display='none'; }
  }catch(e){}
}
$('mtDisconnect').onclick=async()=>{ if(!confirm('Відключити Facebook/Instagram?')) return; try{ await api('/integrations/meta/disconnect',{method:'POST'}); await loadMeta(); }catch(e){} };
$('mtVoice').onclick=async()=>{ const b=$('mtVoice'); const o=b.textContent; b.disabled=true; b.textContent='…читаю пости'; aiBusy('📸 Читаю пости Instagram і виводжу голос бренду…'); try{ const r=await api('/integrations/meta/import-voice',{method:'POST'}); flash('✨ Голос, нішу й мову виведено з '+r.count+' постів IG'); if(r.derived&&typeof renderDerived==='function') renderDerived(r.derived); await loadSettings(); }catch(e){ flash('⚠ '+e.message); } finally{ b.disabled=false; b.textContent=o; aiDone(); } };
async function loadMetaPages(){ const sel=$('mtPage'); if(!sel) return; try{ const pages=await api('/integrations/meta/pages'); if(!Array.isArray(pages)||!pages.length){ sel.innerHTML='<option>-</option>'; return; } sel.innerHTML=pages.map(p=>'<option value="'+p.id+'"'+(p.current?' selected':'')+'>'+esc(p.name)+(p.ig?(' · IG @'+esc(p.ig)):'')+'</option>').join(''); }catch(e){ sel.innerHTML='<option>-</option>'; } }
$('mtPage').onchange=async(e)=>{ try{ await api('/integrations/meta/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId:e.target.value})}); await loadMeta(); flashSaved(); }catch(err){ flash('Не вдалося змінити акаунт: '+err.message); } };
$('mtStats').onclick=async()=>{ const o=$('mtStatsOut'); o.innerHTML='<div class="empty"><span class="spin"></span> завантаження…</div>';
  try{ const s=await api('/integrations/meta/stats'); o.innerHTML=(s.facebook?('<div class="card">📘 <b>'+esc(s.facebook.name||'FB')+'</b>: '+(s.facebook.followers_count||s.facebook.fan_count||0)+' підписників</div>'):'')+(s.instagram?('<div class="card">📸 <b>@'+esc(s.instagram.username||'')+'</b>: '+(s.instagram.followers_count||0)+' підписників · '+(s.instagram.media_count||0)+' постів</div>'):'')+(!s.facebook&&!s.instagram?'<div class="empty">Немає даних.</div>':''); }catch(e){ o.innerHTML='<div class="card" style="color:var(--danger)">⚠ '+esc(e.message)+'</div>'; } };
$('tgSave').onclick=async()=>{ try{ const r=await api('/integrations/telegram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({botToken:$('tgToken').value,channelChatId:$('tgChannel').value,groupChatId:$('tgGroup').value})}); $('tgToken').value=''; $('tgToken').placeholder='•••••••• (токен збережено)';
  $('tgResult').innerHTML=r.dmReady?('<div class="card" style="color:var(--brand)">✅ Власний бот <b>@'+esc(r.ownBot)+'</b> підключено повністю: публікація + асистент у DM (щоденник, дайджест, ідеї). Напиши боту /start із посилання «Підключити бот».</div>')
    :(r.warn?('<div class="card" style="color:var(--amber)">⚠ '+esc(r.warn)+'</div>'):'<div class="card" style="color:var(--brand)">Збережено ✓</div>'); }
  catch(e){ $('tgResult').innerHTML='<div class="card" style="color:var(--danger)">⚠ '+esc(e.message)+'</div>'; } };
$('tgTest').onclick=async()=>{ $('tgResult').innerHTML='<div class="empty"><span class="spin"></span> перевіряю…</div>';
  try{ const r=await api('/integrations/telegram/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botToken:$('tgToken').value,channelChatId:$('tgChannel').value,groupChatId:$('tgGroup').value})});
    const line=(label,c)=>{ if(!c) return '<div class="card"><b>'+label+':</b> <span style="color:var(--muted)">не вказано</span></div>'; if(!c.ok) return '<div class="card"><b>'+label+':</b> <span style="color:var(--danger)">⚠ '+esc(c.error||'недоступно')+'</span></div>'; return '<div class="card"><b>'+label+':</b> <span style="color:var(--brand)">✓ '+esc(c.title)+'</span> '+(c.isAdmin?'<span style="color:var(--brand)">· бот адмін</span>':'<span style="color:var(--amber)">· бот НЕ адмін</span>')+'</div>'; };
    $('tgResult').innerHTML='<div class="card" style="color:var(--brand)">Бот: @'+esc(r.bot.username||'?')+' ✓</div>'+line('Канал',r.channel)+line('Група',r.group);
  }catch(e){ $('tgResult').innerHTML='<div class="card" style="color:var(--danger)">⚠ '+esc(e.message)+'</div>'; }
};

// ---------- модель + промпт на кожен крок (Конвеєр) ----------
const STEP_BY_SEC = {s1:'extract_ideas', s3:'drafts', s4:'tone', s5:'format', s6:'deai', s7:'strategy'};
const MODELS = [['anthropic/claude-sonnet-4.5','Claude Sonnet 4.5 (якість)'],['anthropic/claude-sonnet-4.6','Claude Sonnet 4.6'],['anthropic/claude-haiku-4.5','Claude Haiku 4.5 (швидко)'],['openai/gpt-4o-mini','GPT-4o mini (дешево)'],['anthropic/claude-opus-4.5','Claude Opus 4.5 (макс)']];
async function loadPrompts(){
  let cfg=[]; try{ cfg=await api('/prompts'); }catch(e){ return; }
  const byStep=Object.fromEntries(cfg.map(c=>[c.step_key,c]));
  for(const sec in STEP_BY_SEC){
    const step=STEP_BY_SEC[sec]; const ctl=document.querySelector('#'+sec+' .btnrow'); const body=document.querySelector('#'+sec+' .stepbody');
    if(!ctl || !body || ctl.querySelector('.stepModel')) continue;
    const cur=byStep[step]||{model:'',content:''};
    const sel=document.createElement('select'); sel.className='stepModel'; sel.dataset.step=step; sel.style.cssText='width:auto;min-width:150px;font-size:12px;padding:6px 8px';
    let opts=MODELS.slice(); if(cur.model && !opts.some(m=>m[0]===cur.model)) opts.unshift([cur.model,cur.model]);
    sel.innerHTML=opts.map(m=>'<option value="'+m[0]+'"'+(m[0]===cur.model?' selected':'')+'>'+m[1]+'</option>').join('');
    sel.onchange=()=>savePrompt(step); ctl.appendChild(sel);
    const det=document.createElement('details'); det.style.cssText='margin:10px 0 0;border:1px dashed var(--line2);border-radius:9px';
    det.innerHTML='<summary style="cursor:pointer;padding:8px 12px;font-size:12px;color:var(--muted)">✎ Промпт кроку</summary><div style="padding:0 12px 12px"><textarea class="stepPrompt" data-step="'+step+'" style="min-height:90px"></textarea><div class="btnrow"><button class="savePrompt" data-step="'+step+'">Зберегти промпт</button><button class="resetPrompt ghost" data-step="'+step+'">↺ Стандартний</button></div></div>';
    det.querySelector('textarea').value=cur.content||'';
    det.querySelector('.savePrompt').onclick=()=>savePrompt(step);
    det.querySelector('.resetPrompt').onclick=()=>resetPrompt(step);
    const out=body.querySelector('.out'); body.insertBefore(det, out);
  }
}
async function savePrompt(step){ const sel=document.querySelector('.stepModel[data-step="'+step+'"]'); const ta=document.querySelector('.stepPrompt[data-step="'+step+'"]'); if(!sel||!ta) return; try{ await api('/prompts/'+step,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:sel.value,content:ta.value})}); flashSaved(); }catch(e){ flash('Не вдалося зберегти промпт: '+e.message); } }
async function resetPrompt(step){ if(!confirm('Повернути стандартний промпт цього кроку? Твої правки тут зітруться.')) return; try{ await api('/prompts/'+step,{method:'DELETE'}); const cfg=await api('/prompts'); const c=cfg.find(x=>x.step_key===step)||{model:'',content:''}; const sel=document.querySelector('.stepModel[data-step="'+step+'"]'); const ta=document.querySelector('.stepPrompt[data-step="'+step+'"]'); if(ta) ta.value=c.content||''; if(sel){ if(c.model && !Array.from(sel.options).some(o=>o.value===c.model)){ const op=document.createElement('option'); op.value=c.model; op.textContent=c.model; sel.appendChild(op); } sel.value=c.model; } flashSaved(); }catch(e){ flash('Не вдалося скинути: '+e.message); } }
// ---------- RSS ----------
// людський підпис джерела замість внутрішнього URL (rsshub-адреси й instagram:маркер)
// ---------- 🧪 порівняння моделей (Інструменти) ----------
// Питання Олега: «яка модель дасть кращий контент - чи це взагалі промт?». Єдиний спосіб відповісти -
// прогнати ОДИН матеріал через ОДИН промт кількома моделями і прочитати результати поруч. Тому:
// • промт будує сервер звичайним buildLitePrompt і віддає моделям дослівно (єдина змінна - модель);
// • назви моделей сховані до оцінки (гучне імʼя інакше вирішує за тебе);
// • порядок колонок перемішується (позиція теж впливає на оцінку);
// • біля кожної - токени, час і ціна, бо «краще» без ціни не є рішенням.
let _abReady=false, _abCat=[], _abReveal=false;
function abPriceLabel(m){ return (m.in||m.out)?(' - $'+m.in+'/$'+m.out):' - ціна невідома'; }
function abModelOptions(sel){
  const byVendor={};
  _abCat.forEach(m=>{ const v=m.id.split('/')[0]; (byVendor[v]=byVendor[v]||[]).push(m); });
  return '<option value="">- не використовувати</option>'
    +Object.keys(byVendor).sort().map(v=>'<optgroup label="'+esc(v)+'">'
      +byVendor[v].map(m=>'<option value="'+esc(m.id)+'"'+(m.id===sel?' selected':'')+'>'+esc(m.id)+esc(abPriceLabel(m))+'</option>').join('')
      +'</optgroup>').join('');
}
async function loadAbTest(){
  if(_abReady) return; _abReady=true;
  const box=$('abModels'), src=$('abSource'); if(!box||!src) return;
  // матеріали: беремо вже завантажену стрічку, щоб не робити зайвий запит
  const mats=(Mats||[]).slice(0,40);
  src.innerHTML=(mats.length?mats.map(m=>'<option value="'+esc(m.id)+'">'+esc((matType(m)||'')+' · '+String(m.title||'без назви').slice(0,70))+'</option>').join('')
    :'<option value="">- нема матеріалів: додай хоч один у «Створення → Матеріали»</option>');
  let cat={models:[],live:false,current:'',spend:{calls:0,cost:0}};
  try{ cat=await api('/models/catalog'); }catch(e){}
  _abCat=cat.models||[];
  const msg=$('abCatMsg');
  if(msg) msg.textContent=(cat.live?('каталог OpenRouter · '+_abCat.length+' моделей'):'каталог недоступний - показую лише ті, що вже вживаються')
    +(cat.spend&&cat.spend.calls?(' · на експерименти витрачено $'+(cat.spend.cost||0).toFixed(4)+' за '+cat.spend.calls+' викл.'):'');
  // 4 слоти: перший - те, на чому працюєш зараз (база порівняння), решту обираєш сам
  box.innerHTML=[0,1,2,3].map(i=>'<select class="abModel txt" data-i="'+i+'" style="font-size:12.5px">'+abModelOptions(i===0?cat.current:'')+'</select>').join('');
  const main=$('abMain');
  if(main){ main.innerHTML=abModelOptions(cat.current);
    main.onchange=async()=>{ const mm=$('abMainMsg');
      if(!main.value){ mm.textContent='порожньо = дефолт '+(cat.defaultModel||''); }
      try{ await api('/settings/main_model',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:main.value})});
        mm.style.color='var(--brand)'; mm.textContent='збережено ✓ вся генерація постів іде на '+(main.value||cat.defaultModel);
      }catch(e){ mm.style.color='var(--danger)'; mm.textContent='⚠ '+e.message; } }; }
}
function abRenderOut(r){
  const box=$('abOut'); if(!box) return;
  const NAMES=['А','Б','В','Г'];
  const cols=r.variants.map((v,i)=>{
    const label=_abReveal?esc(v.model):('Варіант '+NAMES[i]);
    const tok=v.prompt_tokens+v.completion_tokens
      ? (v.prompt_tokens+' → '+v.completion_tokens+' токенів · '+(v.ms/1000).toFixed(1)+'с'
         +(v.costKnown?(' · $'+v.cost.toFixed(5)):' · ціна невідома'))
      : ((v.ms/1000).toFixed(1)+'с');
    const body=v.ok
      ? v.posts.map(p=>'<div class="post" style="margin-bottom:8px;white-space:pre-wrap">'+esc(p.text)+'</div>'
          +(p.rubric?'<div style="font-size:11px;color:var(--faint);margin:-4px 0 10px">🏷 '+esc(p.rubric)+' · '+esc(p.intent)+' · '+p.text.replace(/\n/g,'').length+' симв.</div>':'')).join('')
      : '<div style="font-size:12.5px;color:var(--danger)">⚠ '+esc(v.error||'без результату')+'</div>';
    return '<div style="flex:1;min-width:280px;border:1px solid var(--line);border-radius:var(--r);padding:12px">'
      +'<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px"><b style="font-size:13.5px">'+label+'</b>'
      +'<span style="font-size:11px;color:var(--muted)">'+esc(tok)+'</span></div>'+body+'</div>';
  }).join('');
  box.innerHTML='<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Матеріал: <b>'+esc(r.material.title)+'</b> ('+r.material.chars+' симв.) · промт '+r.prompt.chars+' симв. - однаковий для всіх</div>'
    +'<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">'+cols+'</div>'
    +'<div class="btnrow" style="margin-top:10px;flex-wrap:wrap"><button class="ghost" id="abReveal">'+(_abReveal?'🙈 Сховати назви':'👁 Показати, які це моделі')+'</button>'
    +'<button class="ghost" id="abPrompt">📄 Показати промт</button></div>'
    +'<div style="font-size:11.5px;color:var(--faint);margin-top:8px">⚠ Один прогін - це один зразок, не вирок: моделі відповідають по-різному щоразу. Якщо різниця невелика, прожени ще раз (можна вказати ОДНУ Й ТУ САМУ модель у двох слотах - побачиш, наскільки вона розходиться сама з собою; якщо цей розкид схожий на розкид між моделями, справа не в моделі).</div>';
  $('abReveal').onclick=()=>{ _abReveal=!_abReveal; abRenderOut(r); };
  $('abPrompt').onclick=()=>{
    const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='90';
    ov.innerHTML='<div class="modal-card" style="max-width:820px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b>📄 Промт, який отримали ВСІ моделі</b><button class="icon" id="apX" style="margin-left:auto">✕</button></div>'
      +'<pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;max-height:66vh;overflow:auto;margin:0;color:var(--ink2)">'+esc(r.prompt.system)+'</pre></div>';
    document.body.appendChild(ov);
    ov.querySelector('#apX').onclick=()=>ov.remove();
    ov.addEventListener('click',e=>{ if(e.target===ov) ov.remove(); });
  };
}
if($('abRun')) $('abRun').onclick=async()=>{
  const models=[...document.querySelectorAll('#abModels .abModel')].map(s=>s.value).filter(Boolean);
  const uniq=[...new Set(models)];
  const msg=$('abMsg'), btn=$('abRun');
  if(models.length<2){ msg.style.color='var(--danger)'; msg.textContent='обери щонайменше дві моделі'; return; }
  const sourceId=$('abSource').value;
  if(!sourceId){ msg.style.color='var(--danger)'; msg.textContent='нема матеріалу для прогону'; return; }
  const cnt=+$('abCount').value||1;
  if(!confirm('Прогнати '+models.length+' модел(і) × '+cnt+' пост(и)? Це РЕАЛЬНІ виклики - вони коштують грошей'+(uniq.length<models.length?' (одна модель обрана двічі - це навмисно можна, щоб побачити її власний розкид)':'')+'.')) return;
  btn.disabled=true; msg.style.color='var(--muted)'; msg.textContent='генерую паралельно…'; aiBusy('🧪 Проганяю той самий матеріал '+models.length+' моделями…');
  try{
    const r=await runAiJob('/ab/generate',{sourceId,models,count:cnt},(sec)=>{ msg.textContent='генерую паралельно… '+sec+'с'; });
    // перемішуємо колонки: позиція теж впливає на оцінку, а ми хочемо оцінку ТЕКСТУ
    for(let i=r.variants.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=r.variants[i]; r.variants[i]=r.variants[j]; r.variants[j]=t; }
    _abReveal=false; abRenderOut(r);
    const okN=r.variants.filter(v=>v.ok).length;
    msg.style.color=okN===r.variants.length?'var(--brand)':'var(--amber)';
    msg.textContent='готово: '+okN+' з '+r.variants.length+' моделей дали результат';
  }catch(e){ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; }
  finally{ btn.disabled=false; aiDone(); }
};

function rssNiceUrl(f){
  let m=f.url.match(/\/telegram\/channel\/([A-Za-z0-9_]+)/); if(m) return '✈️ t.me/'+m[1];
  m=f.url.match(/\/threads\/([A-Za-z0-9_.]+)/); if(m) return '🧵 @'+m[1];
  m=f.url.match(/^instagram:([A-Za-z0-9_.]+)/); if(m) return '📸 @'+m[1];
  return f.url;
}
async function loadRss(){
  const o=$('rssList'); if(!o) return;
  try{ const feeds=await api('/sources/rss');
    if(!feeds.length){ o.innerHTML='<div class="empty">Поки немає стрічок.</div>'; return; }
    o.innerHTML=feeds.map(f=>{ const broken=!!f.last_error;
      return '<div class="card" data-id="'+f.id+'"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div style="min-width:0;flex:1">'
      +'<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b style="font-size:13.5px">'+esc(f.title||f.url)+'</b>'+(broken?'<span class="ptag" style="color:var(--danger);border-color:var(--danger)" title="'+esc(f.last_error)+'">⚠ джерело недоступне</span>':'')+'</div>'
      +(f.title?'<div style="word-break:break-all;font-size:11.5px;color:var(--faint)">'+esc(rssNiceUrl(f))+'</div>':'')
      +'<div style="font-size:12px;color:var(--muted)">'+(f.last_pulled_at?('останнє: '+new Date(f.last_pulled_at).toLocaleString()):'ще не тягнулось')+'</div></div>'
      +'<div class="btnrow" style="margin:0;flex-wrap:nowrap"><label class="rchip"><input type="checkbox" class="rssActive" '+(f.active?'checked':'')+'> активна</label><label class="rchip"><input type="checkbox" class="rssAutoT" '+(f.auto_run?'checked':'')+'> авто</label><button class="ghost rssPull" title="підтягнути зараз">↓</button><button class="rssDel">🗑</button></div></div></div>'; }).join('');
    o.querySelectorAll('.card[data-id]').forEach(c=>{ const id=c.dataset.id;
      c.querySelectorAll('.rchip').forEach(l=>{ const cb=l.querySelector('input'); l.classList.toggle('on',cb.checked); cb.addEventListener('change',()=>l.classList.toggle('on',cb.checked)); });
      c.querySelector('.rssActive').addEventListener('change',e=>api('/sources/rss/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:e.target.checked})}).catch(()=>{}));
      c.querySelector('.rssAutoT').addEventListener('change',e=>{ if(e.target.checked && !confirm(AUTORUN_WARN)){ e.target.checked=false; return; } api('/sources/rss/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoRun:e.target.checked})}).catch(()=>{}); });
      c.querySelector('.rssPull').onclick=async(ev)=>{ const b=ev.target; b.disabled=true; b.textContent='…'; try{ const r=await api('/sources/rss/'+id+'/pull',{method:'POST'}); b.textContent='+'+r.created; await loadRss(); await loadRecent(); }catch(e){ b.textContent='⚠'; flash(e.message); } finally{ setTimeout(()=>{b.disabled=false;b.textContent='↓';},1500); } };
      c.querySelector('.rssDel').onclick=async()=>{ if(!confirm('Видалити стрічку?'))return; try{ await api('/sources/rss/'+id,{method:'DELETE'}); await loadRss(); }catch(e){ flash(e.message); } };
    });
  }catch(e){ o.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
// «Додати джерело» = 2 кроки: Знайти (резолв + прев'ю останніх постів) → Підключити (збереження + перший fetch)
const RSS_PLACEHOLDER={news:'тема або ключові слова, напр.: готельний бізнес Чехія',telegram:'@канал або t.me/канал (публічний)',instagram:'@сторінка або instagram.com/сторінка (бізнес/креатор)',threads:'@профіль або threads.net/@профіль',rss:'https://example.com/feed.xml (або просто адреса сайту - фід знайду сам)'};
if($('rssType')) $('rssType').onchange=()=>{ const t=$('rssType').value;
  $('rssUrl').placeholder=RSS_PLACEHOLDER[t]||RSS_PLACEHOLDER.rss;
  $('rssLang').style.display=t==='news'?'':'none'; };
if($('rssFind')) $('rssFind').onclick=async()=>{ const input=$('rssUrl').value.trim(); const m=$('rssMsg'); const pv=$('rssPreview');
  if(!input){ m.style.color='var(--danger)'; m.textContent=$('rssType').value==='news'?'Введи тему':'Встав @назву або посилання'; return; }
  m.style.color='var(--muted)'; m.textContent='шукаю джерело…'; pv.style.display='none'; const b=$('rssFind'); b.disabled=true;
  try{ const r=await api('/sources/rss/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:$('rssType').value,input,lang:$('rssLang').value})});
    m.textContent='';
    pv.style.display='block';
    pv.innerHTML='<div class="card" style="border-color:var(--brand)"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Знайдено: '+esc(r.title)+'</b>'+(r.note?'<span class="ptag">'+esc(r.note)+'</span>':'')+'</div>'
      +'<div style="font-size:12.5px;color:var(--ink2);margin-top:8px">Останні пости:</div>'
      +'<ul style="margin:6px 0 0 18px;font-size:12.5px;line-height:1.6;color:var(--muted)">'+(r.preview||[]).map(p=>'<li>'+esc(p.title)+'</li>').join('')+'</ul>'
      +'<div class="btnrow" style="margin-top:12px"><label class="rchip"><input type="checkbox" id="rssAuto"> авто-генерація чорновиків</label><button class="primary" id="rssConnect">✓ Підключити</button><button class="ghost" id="rssCancel">Скасувати</button></div></div>';
    pv.querySelector('#rssCancel').onclick=()=>{ pv.style.display='none'; pv.innerHTML=''; };
    pv.querySelector('#rssConnect').onclick=async(ev)=>{ const cb=pv.querySelector('#rssAuto'); if(cb.checked && !confirm(AUTORUN_WARN)) cb.checked=false;
      const cbtn=ev.target; cbtn.disabled=true; m.style.color='var(--muted)'; m.textContent='підключаю…';
      try{ const add=await api('/sources/rss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:r.feedUrl,title:r.title,autoRun:cb.checked,kind:r.kind||'rss'})});
        m.textContent='тягну перші пости…';
        try{ const pull=await api('/sources/rss/'+add.id+'/pull',{method:'POST'}); m.style.color='var(--brand)'; m.textContent='підключено ✓ '+(pull.created?('+'+pull.created+' у Матеріалах'):''); }
        catch(_){ m.style.color='var(--brand)'; m.textContent='підключено ✓ (пости підтягнуться протягом 15 хв)'; }
        $('rssUrl').value=''; pv.style.display='none'; pv.innerHTML=''; await loadRss(); try{await loadRecent();}catch(_){}
      }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; cbtn.disabled=false; } };
  }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } finally{ b.disabled=false; } };

// ---------- останні джерела ----------
async function loadRecent(){
  const o=$('recList'); if(!o) return;
  try{ const rows=await api('/sources/recent');
    if(!rows.length){ o.innerHTML='<div class="empty">Поки порожньо.</div>'; return; }
    const ICON={rss:'📡',fireflies:'🎙️',manual:'📝',diary:'📔',bot:'🤖',idea:'💡',topic:'✍️',plan:'📅',meeting:'🎤',takes:'🧵',gdrive:'📁'};
    // «Відкрити» веде в САМ матеріал (повний текст у стрічці Матеріалів), а не в Студію з порожнім
    // контекстом - тестер бачив лише заголовки й «перекидає на меню створення і все».
    o.innerHTML=rows.map(s=>'<div class="card" data-run="'+s.run_id+'" data-src="'+s.id+'" style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div style="min-width:0"><div>'+(ICON[s.origin]||'📄')+' '+esc(s.title||'(без назви)')+'</div><div style="font-size:12px;color:var(--muted)">'+esc(ORIGIN_LABEL[s.origin]||s.origin||'')+' · '+new Date(s.created_at).toLocaleString()+(s.excerpt?(' · '+esc(s.excerpt)):'')+'</div></div><button class="ghost recOpen" title="Відкрити повний текст у Матеріалах">Відкрити</button></div>').join('');
    o.querySelectorAll('.card[data-run]').forEach(c=>{ c.querySelector('.recOpen').onclick=async()=>{ runId=c.dataset.run; localStorage.setItem('kg_run',runId); updRunLabel(); await openMaterialDeep(c.dataset.src); }; });
  }catch(e){ o.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
$('recReload').onclick=()=>loadRecent();

// ---------- медіа ----------
let MediaSel=null; // null = звичайний режим; Set(id) = режим виділення для масового видалення
async function loadMedia(){
  const o=$('mediaGrid'); if(!o) return;
  try{ const m=await api('/media');
    if(!m.length){ MediaSel=null; o.innerHTML='<div class="empty">Порожньо.</div>'; return; }
    const sel=MediaSel;
    const bar='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:100%;margin-bottom:8px">'
      +(sel
        ?'<button class="ghost" id="mSelAll">Вибрати всі</button><button class="danger" id="mSelDel"'+(sel.size?'':' disabled')+'>🗑 Видалити обрані ('+sel.size+')</button><button class="ghost" id="mSelOff">Скасувати</button>'
        :'<button class="ghost" id="mSelOn">☑️ Вибрати кілька</button><span style="font-size:12px;color:var(--muted)">для масового видалення</span>')
      +'</div>';
    o.innerHTML=bar+m.map(x=>{ const on=sel&&sel.has(x.id);
      return '<div style="position:relative;cursor:'+(sel?'pointer':'default')+'" data-id="'+x.id+'">'
        +(x.kind==='video'?'<video src="/media/'+esc(x.filename)+'" style="height:90px;border-radius:8px'+(on?';outline:3px solid var(--brand)':'')+'"></video>':'<img loading="lazy" src="/thumb/'+esc(x.filename)+'" onerror="this.style.opacity=.3" style="height:90px;border-radius:8px;background:var(--surface2)'+(on?';outline:3px solid var(--brand)':'')+'">')
        +(sel?'<span style="position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;background:'+(on?'var(--brand)':'rgba(0,0,0,.55)')+';color:#fff">'+(on?'✓':'')+'</span>'
             :'<button class="mediaDel" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;padding:1px 6px">✕</button>')
        +'</div>'; }).join('');
    if(sel){
      o.querySelectorAll('[data-id]').forEach(c=>{ c.onclick=()=>{ const id=c.dataset.id; if(sel.has(id)) sel.delete(id); else sel.add(id); loadMedia(); }; });
      const all=$('mSelAll'); if(all) all.onclick=(e)=>{ e.stopPropagation(); m.forEach(x=>sel.add(x.id)); loadMedia(); };
      const off=$('mSelOff'); if(off) off.onclick=(e)=>{ e.stopPropagation(); MediaSel=null; loadMedia(); };
      const del=$('mSelDel'); if(del) del.onclick=async(e)=>{ e.stopPropagation(); if(!sel.size) return;
        if(!confirm('Видалити '+sel.size+' файл(ів) назавжди? Пости не зламаються - фото просто відкріпиться.')) return;
        del.disabled=true; try{ const r=await api('/media/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[...sel]})}); flash('🗑 Видалено: '+r.deleted); MediaSel=null; await loadMedia(); }catch(err){ flash('⚠ '+err.message); del.disabled=false; } };
    } else {
      const on=$('mSelOn'); if(on) on.onclick=()=>{ MediaSel=new Set(); loadMedia(); };
      o.querySelectorAll('[data-id]').forEach(c=>{ const d=c.querySelector('.mediaDel'); if(d) d.onclick=async()=>{ if(!confirm('Видалити фото?'))return; try{ await api('/media/'+c.dataset.id,{method:'DELETE'}); await loadMedia(); }catch(e){ flash(e.message); } }; });
    }
  }catch(e){ o.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
$('mediaUpload').onclick=async()=>{
  const f=$('mediaFile').files; const m=$('mediaMsg'); if(!f||!f.length){ m.style.color='var(--danger)'; m.textContent='Обери файл(и)'; return; }
  const fd=new FormData(); for(const file of f) fd.append('file',file); m.style.color='var(--muted)'; m.textContent='завантаження…';
  try{ const r=await fetch('/api/media',{method:'POST',body:fd,credentials:'same-origin'}); const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status)); $('mediaFile').value=''; m.style.color='var(--brand)'; m.textContent='завантажено: '+((j.saved||[]).length); await loadMedia(); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }
};

// ---------- Google Drive ----------

// ---------- 🏢 кабінети (бренди): перемикач у меню аватара + доступи в Профілі ----------
// Активний кабінет живе в СЕСІЇ на сервері, тож після перемикання просто перезавантажуємо сторінку:
// так гарантовано оновляться всі 20+ списків, а не половина, яку ми згадали б оновити руками.
let Wss=[], WsActive='';
async function loadWorkspaces(){
  try{ const r=await api('/workspaces'); Wss=r.items||[]; WsActive=r.active||''; renderWsSwitch(WsActive);
    const t=$('wsTitle'), cur=Wss.find(w=>w.id===WsActive); if(t&&cur&&!t.value) t.value=cur.title||''; }catch(e){}
}
function renderWsSwitch(active){
  const box=$('wsSwitch'), list=$('wsList'); if(!box||!list) return;
  if(Wss.length<2){ box.style.display='none'; return; }   // один кабінет - жодного зайвого вибору
  box.style.display='';
  list.innerHTML=Wss.map(w=>'<div class="umitem" data-ws="'+esc(w.id)+'" style="display:flex;gap:8px;align-items:center">'
    +'<span style="width:14px;color:var(--brand)">'+(w.id===active?'✓':'')+'</span>'
    +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.title)+'</span>'
    +(w.role==='owner'?'<span style="font-size:10px;color:var(--faint)">власник</span>':'')+'</div>').join('')
    +'<div class="umitem" id="wsAddMenu" style="color:var(--brand)">＋ Додати бренд</div>';
  const add=$('wsAddMenu'); if(add) add.onclick=addBrand;
  list.querySelectorAll('[data-ws]').forEach(el=>el.onclick=async()=>{
    if(el.dataset.ws===active) return;
    try{ await api('/workspaces/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:el.dataset.ws})}); location.reload(); }
    catch(e){ flash('⚠ '+e.message); }
  });
}
async function addBrand(){
  const title=(prompt('Назва нового бренду:','')||'').trim(); if(!title) return;
  try{ await api('/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})}); location.reload(); }
  catch(e){ flash('⚠ '+e.message); }
}
if($('wsAddBtn')) $('wsAddBtn').onclick=addBrand;
async function loadWsMembers(){
  const box=$('wsMembers'); if(!box) return;
  try{
    const r=await api('/workspaces/members');
    box.innerHTML=(r.items||[]).map(m=>'<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">'
      +'<span style="flex:1;font-size:13px">'+esc(m.email)+(m.role==='owner'?' <span style="font-size:10px;color:var(--faint)">власник</span>':'')+'</span>'
      +(r.owner&&m.role!=='owner'?'<button class="ghost" data-rev="'+esc(m.user_id)+'" style="padding:3px 9px;font-size:12px">Прибрати</button>':'')+'</div>').join('')
      ||'<div class="hint">Доступ має лише ти.</div>';
    box.querySelectorAll('[data-rev]').forEach(b=>b.onclick=async()=>{
      if(!confirm('Прибрати доступ до цього кабінету?')) return;
      try{ await api('/workspaces/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:b.dataset.rev})}); loadWsMembers(); flash('Доступ прибрано'); }
      catch(e){ flash('⚠ '+e.message); }
    });
  }catch(e){}
}
if($('wsGrantBtn')) $('wsGrantBtn').onclick=async()=>{
  const email=($('wsGrantEmail').value||'').trim(); if(!email) return;
  try{ await api('/workspaces/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    $('wsGrantEmail').value=''; $('wsMsg').textContent='доступ видано ✓'; loadWsMembers(); }
  catch(e){ $('wsMsg').textContent='⚠ '+e.message.replace(/^\d+:\s*/,''); }
};
if($('wsTitleSave')) $('wsTitleSave').onclick=async()=>{
  try{ await api('/workspaces/title',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('wsTitle').value})});
    flash('Назву збережено'); loadWorkspaces(); }catch(e){ flash('⚠ '+e.message); }
};

// ---------- 🔌 MCP: кабінет як інструмент Claude ----------
// Адреса конектора = пароль від кабінету, тому: показуємо лише власнику, копіюємо кнопкою (щоб не
// виділяли мишкою й не губили символ), перевипуск через підтвердження - стара адреса мре одразу.
async function loadMcp(){
  const inp=$('mcpUrl'); if(!inp) return;
  try{
    const c=await api('/integrations/mcp');
    inp.value=c.url||'';
    $('mcpCreate').textContent=c.connected?'🔄 Перевипустити адресу':'Створити адресу';
    $('mcpRevoke').style.display=c.connected?'':'none';
    const m=$('mcpMsg');
    if(m) m.textContent=!c.connected?'':(c.lastUsed?('Claude звертався: '+new Date(c.lastUsed).toLocaleString('uk-UA')+' · інструментів: '+c.tools):'Ще жодного звернення - підключи конектор у Claude (інструментів: '+c.tools+')');
  }catch(e){}
}
function openMcpHow(){
  const url=($('mcpUrl')&&$('mcpUrl').value)||'(спершу створи адресу)';
  const ov=document.createElement('div'); ov.className='modal';
  ov.innerHTML='<div class="modal-card" style="max-width:600px;padding:20px;max-height:86vh;overflow:auto">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="font-size:16px">🔌 Як підключити кабінет до Claude</b><button class="icon" id="mhX" style="margin-left:auto">✕</button></div>'
    +'<div class="hint">Працює на підписці Claude Pro/Max - окремо за API платити не треба.</div>'
    +'<ol style="font-size:13px;line-height:1.65;padding-left:18px;margin:12px 0">'
    +'<li><b>Скопіюй адресу</b> з панелі (кнопка «Копіювати»).</li>'
    +'<li>У Claude: <b>Settings → Connectors → Add custom connector</b>, встав адресу, натисни Add.</li>'
    +'<li>У чаті увімкни конектор <b>socialio</b> (іконка інструментів під полем вводу).</li>'
    +'<li>Перевір: напиши «<i>покажи мої чернетки</i>».</li>'
    +'</ol>'
    +'<div class="fld"><label class="fl">Claude Code (у терміналі) - одна команда</label><input class="txt" readonly style="font-size:12px" value="claude mcp add --transport http socialio '+esc(url)+'"></div>'
    +'<div class="ph" style="margin:14px 0 6px">Що просити в чаті</div>'
    +'<div style="font-size:13px;line-height:1.7">'
    +'• «<i>візьми голос мого бренду і напиши 3 пости про X, збережи чернетками</i>» - пише сам Claude, наші AI-кредити не витрачаються;<br>'
    +'• «<i>що в мене в чернетках?</i>», «<i>покажи матеріали</i>»;<br>'
    +'• «<i>опублікуй #a1b2c3d4 в telegram</i>», «<i>заплануй на завтра 9:00</i>»;<br>'
    +'• «<i>що вийшло за місяць?</i>» - аналітика з посиланнями.'
    +'</div>'
    +'<div class="hint" style="margin-top:12px">⚠️ Адреса = доступ до кабінету: не публікуй її і не вставляй у чужі чати. Якщо десь засвітилась - тисни «Перевипустити адресу», стара помре одразу.</div>'
    +'</div>';
  document.body.appendChild(ov); const close=()=>ov.remove();
  ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#mhX').onclick=close;
}
if($('mcpCopy')) $('mcpCopy').onclick=()=>{ const v=$('mcpUrl').value; if(v){ navigator.clipboard.writeText(v); flash('Адресу скопійовано'); } };
if($('mcpCreate')) $('mcpCreate').onclick=async()=>{
  const had=!!$('mcpUrl').value;
  if(had&&!confirm('Перевипустити адресу? Стара перестане працювати одразу - у Claude доведеться додати конектор заново.')) return;
  try{ const r=await api('/integrations/mcp/rotate',{method:'POST'}); $('mcpUrl').value=r.url; await loadMcp(); flash(had?'Нова адреса готова':'Адресу створено'); openMcpHow(); }
  catch(e){ flash('⚠ '+e.message); }
};
if($('mcpRevoke')) $('mcpRevoke').onclick=async()=>{
  if(!confirm('Відключити Claude? Адреса перестане працювати, кабінет лишиться як є.')) return;
  try{ await api('/integrations/mcp/revoke',{method:'POST'}); await loadMcp(); flash('Відключено'); }catch(e){ flash('⚠ '+e.message); }
};
if($('mcpHow')) $('mcpHow').onclick=()=>openMcpHow();
async function loadGdrive(){
  const st=$('gdStatus'); if(!st) return;
  try{ const c=await api('/integrations/gdrive'); const conn=$('gdConnect'), dis=$('gdDisconnect'), box=$('gdFolderBox');
    if(!c.configured){ st.textContent='🕓 Підключення Google Drive тимчасово недоступне.'; [conn,dis].forEach(b=>b&&(b.style.display='none')); if(box)box.style.display='none'; return; }
    if(c.connected){ st.innerHTML='✅ Підключено'+(c.email?(' ('+esc(c.email)+')'):''); if(conn)conn.style.display='none'; if(dis)dis.style.display='inline-flex'; if(box)box.style.display='block'; loadGdriveFolders(); }
    else { st.textContent='Не підключено.'; if(conn)conn.style.display='inline-flex'; if(dis)dis.style.display='none'; if(box)box.style.display='none'; }
  }catch(e){}
}
async function loadGdriveFolders(){
  const o=$('gdList'); if(!o) return;
  try{ const folders=await api('/sources/gdrive');
    if(!folders.length){ o.innerHTML='<div class="empty">Папок ще немає.</div>'; return; }
    o.innerHTML=folders.map(f=>'<div class="card" data-id="'+f.id+'"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div style="min-width:0;flex:1"><div style="word-break:break-all">'+esc(f.name||f.folder_id)+'</div><div style="font-size:12px;color:var(--muted)">'+(f.last_pulled_at?('останнє: '+new Date(f.last_pulled_at).toLocaleString()):'ще не тягнулось')+(f.last_error?(' · ⚠ '+esc(f.last_error)):'')+'</div></div><div class="btnrow" style="margin:0;flex-wrap:nowrap"><label class="rchip"><input type="checkbox" class="gdActive" '+(f.active?'checked':'')+'> активна</label><button class="ghost gdPull">↓</button><button class="gdDel">🗑</button></div></div></div>').join('');
    o.querySelectorAll('.card[data-id]').forEach(c=>{ const id=c.dataset.id;
      c.querySelectorAll('.rchip').forEach(l=>{ const cb=l.querySelector('input'); l.classList.toggle('on',cb.checked); cb.addEventListener('change',()=>l.classList.toggle('on',cb.checked)); });
      c.querySelector('.gdActive').addEventListener('change',e=>api('/sources/gdrive/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:e.target.checked})}).catch(()=>{}));
      c.querySelector('.gdPull').onclick=async(ev)=>{ const b=ev.target; b.disabled=true; b.textContent='…'; try{ const r=await api('/sources/gdrive/'+id+'/pull',{method:'POST'}); b.textContent='+'+r.created; await loadGdriveFolders(); await loadMedia(); }catch(e){ b.textContent='⚠'; flash(e.message); } finally{ setTimeout(()=>{b.disabled=false;b.textContent='↓';},1500); } };
      c.querySelector('.gdDel').onclick=async()=>{ if(!confirm('Видалити папку?'))return; try{ await api('/sources/gdrive/'+id,{method:'DELETE'}); await loadGdriveFolders(); }catch(e){ flash(e.message); } };
    });
  }catch(e){ o.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
let _pickerReady=false;
function loadPickerApi(cb){ if(_pickerReady){cb();return;} if(typeof gapi==='undefined'){ flash('Google API ще вантажиться - спробуй за мить'); return; } gapi.load('picker',()=>{ _pickerReady=true; cb(); }); }
$('gdPick').onclick=async()=>{
  const m=$('gdMsg'); m.style.color='var(--muted)'; m.textContent='відкриваю вибір…';
  let cfg; try{ cfg=await api('/integrations/gdrive/picker-token'); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; return; }
  loadPickerApi(()=>{
    m.textContent='';
    const view=new google.picker.DocsView(google.picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
    const picker=new google.picker.PickerBuilder().setOAuthToken(cfg.token).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId).addView(view)
      .setCallback(async(d)=>{ if(d.action===google.picker.Action.PICKED){ const f=d.docs[0];
        try{ const r=await api('/sources/gdrive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderId:f.id,name:f.name})});
          m.style.color='var(--brand)'; m.textContent=(r.duplicate?'папка вже додана':'додано: '+(f.name||''))+' - тягну…'; await loadGdriveFolders();
          try{ await api('/sources/gdrive/'+r.id+'/pull',{method:'POST'}); await loadGdriveFolders(); await loadMedia(); m.textContent='готово ✓'; }catch(e){ m.textContent='папку додано; фото підтягнуться за розкладом'; }
        }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }
      } }).build();
    picker.setVisible(true);
  });
};
$('gdDisconnect').onclick=async()=>{ if(!confirm('Відключити Google Drive?')) return; try{ await api('/integrations/gdrive/disconnect',{method:'POST'}); await loadGdrive(); }catch(e){} };

// ---------- Fireflies ----------
async function openTranscriberModal(){
  let cfg={}; try{ cfg=await api('/integrations/transcription'); }catch(e){}
  const PROVS=[['fireflies','Fireflies'],['grain','Grain'],['meetgeek','MeetGeek']];
  const HINTS={fireflies:'Fireflies → Settings → Developer Settings → API Key.',grain:'Grain → Settings → API → Personal Access Token.',meetgeek:'MeetGeek → Settings → API → ключ.'};
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='76';
  ov.innerHTML='<div class="modal-card" style="max-width:520px;padding:20px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-size:17px">🎙 Транскрибатор</b><button class="icon" id="trX" style="margin-left:auto">✕</button></div>'
    +'<label class="fl">Сервіс</label><select id="trProv">'+PROVS.map(p=>'<option value="'+p[0]+'"'+((cfg.provider||'fireflies')===p[0]?' selected':'')+'>'+p[1]+'</option>').join('')+'</select>'
    +'<div class="fld" style="margin-top:8px"><label class="fl">API-ключ</label><input class="txt" type="password" id="trKey" placeholder="'+(cfg.hasKey?'•••••••• (збережено)':'встав ключ')+'"></div>'
    +'<div class="hint" id="trHint" style="margin-top:6px"></div>'
    +'<div class="btnrow" style="margin-top:10px"><button class="primary" id="trSave">Підключити</button><button class="ghost" id="trImport">📥 Імпортувати зустріч</button><span id="trMsg" style="font-size:12px;color:var(--muted)"></span></div>'
    +'<div id="trList" style="margin-top:8px"></div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove(); ov.addEventListener('click',e=>{ if(e.target===ov) close(); }); ov.querySelector('#trX').onclick=close;
  const q=(s)=>ov.querySelector(s); const setHint=()=>{ q('#trHint').textContent=HINTS[q('#trProv').value]||''; }; setHint(); q('#trProv').onchange=setHint;
  q('#trSave').onclick=async()=>{ const m=q('#trMsg'); m.style.color='var(--muted)'; m.textContent='…'; try{ await api('/integrations/transcription',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:q('#trProv').value,apiKey:q('#trKey').value})}); m.style.color='var(--brand)'; m.textContent='збережено ✓'; if(typeof loadTasks==='function') loadTasks(); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } };
  q('#trImport').onclick=async()=>{ const el=q('#trList'); el.innerHTML='<div class="empty"><span class="spin"></span> завантаження…</div>'; try{ const l=await api('/transcription/list'); if(!l.length){ el.innerHTML='<div class="empty">Немає зустрічей.</div>'; return; } el.innerHTML=''; l.forEach(t=>{ const d=document.createElement('div'); d.className='card'; d.style.cssText='cursor:pointer;margin-bottom:6px'; d.innerHTML='<b>'+esc(t.title||'Без назви')+'</b>'; d.onclick=async()=>{ el.innerHTML='<div class="empty"><span class="spin"></span> імпорт…</div>'; try{ const r=await api('/transcription/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:t.id})}); runId=r.runId; localStorage.setItem('kg_run',runId); close(); if($('onboarding')) $('onboarding').style.display='none'; go('create'); setLayout('studio'); await refresh(); flash('Імпортовано: '+(r.title||'')); if(typeof loadTasks==='function') loadTasks(); }catch(e){ el.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; } }; el.appendChild(d); }); }catch(e){ el.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; } };
}
if($('ffImport')) $('ffImport').onclick=openTranscriberModal;
async function loadFF(){ loadMeeting(); try{ const c=await api('/integrations/transcription'); if(c.hasKey) $('ffKey').placeholder='•••••••• (ключ збережено)'; if($('ffHook')) $('ffHook').value=c.webhookUrl||''; if(c.hasSecret&&$('ffSecret')) $('ffSecret').placeholder='•••••••• (секрет збережено)'; if($('ffAuto')) $('ffAuto').checked=!!c.autoRun; }catch(e){} }
// ---------- 🎤 Свій транскрибатор (Vymova тощо) ----------
// Ключа провайдера тут немає свідомо: сервіс шле весь транскрипт у тілі, тож приймачу нема куди
// й нема чим ходити назад. Пароль - сам URL, тому поруч із ним завжди стоїть «перевипустити».
async function loadMeeting(){
  if(!$('mtUrl')) return;
  try{
    const c=await api('/integrations/meeting');
    $('mtUrl').value=c.url||'';
    if(c.hasSecret) $('mtSecret').placeholder='•••••••• (підпис увімкнено)';
    $('mtAuto').checked=c.auto!==false;
    if(c.imported) $('mtMsg').textContent='зустрічей імпортовано: '+c.imported;
    const p=c.pull||{};
    if($('mtPullUrl')) $('mtPullUrl').value=p.url||'';
    if(p.hasToken&&$('mtPullToken')) $('mtPullToken').placeholder='•••••••• (токен збережено)';
    if($('mtPullState')) $('mtPullState').innerHTML = p.url&&p.hasToken
      ? ('Звірка увімкнена. Остання перевірка: '+(p.at?new Date(p.at).toLocaleString('uk-UA'):'ще не було')+' · дійшли до запису #'+(p.after||0)+'.')
      : 'Звірка вимкнена - працює лише вебхук.';
  }catch(e){ $('mtMsg').textContent='⚠ '+e.message; }
}
// Звірка: перевірка й ручний прохід - щоб не чекати годину й одразу бачити, що не так.
// Токен беремо з поля, ЯКЩО його щойно ввели; інакше сервер візьме збережений.
async function mtPull(testOnly){
  const st=$('mtPullState'); st.style.color='var(--muted)'; st.textContent='…';
  try{
    const r=await api('/integrations/meeting/pull',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({url:$('mtPullUrl').value.trim(),token:$('mtPullToken').value.trim(),testOnly:!!testOnly})});
    st.style.color='var(--brand)'; st.textContent=r.message||'готово';
    if(!testOnly){ if(curView==='create') loadMaterials(); setTimeout(loadMeeting,1200); }
  }catch(e){ st.style.color='var(--danger)'; st.textContent='⚠ '+e.message; }
}
if($('mtPullTest')) $('mtPullTest').onclick=()=>mtPull(true);
if($('mtPullNow')) $('mtPullNow').onclick=()=>mtPull(false);
if($('mtPullOff')) $('mtPullOff').onclick=async()=>{
  if(!confirm('Вимкнути погодинну звірку? Лишиться тільки вебхук.')) return;
  try{ await api('/integrations/meeting',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clearPull:true})});
    $('mtPullUrl').value=''; $('mtPullToken').value=''; await loadMeeting(); }catch(e){ $('mtPullState').textContent='⚠ '+e.message; }
};
if($('mtCopy')) $('mtCopy').onclick=()=>{ const v=$('mtUrl').value; if(v){ navigator.clipboard.writeText(v); flashSaved(); } };
if($('mtRotate')) $('mtRotate').onclick=async()=>{
  if(!confirm('Перевипустити адресу? Стара одразу перестане приймати зустрічі - не забудь оновити її у своєму сервісі.')) return;
  try{ await api('/integrations/meeting',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rotate:true})}); await loadMeeting(); $('mtMsg').style.color='var(--brand)'; $('mtMsg').textContent='нова адреса ✓ встав її у свій сервіс'; }
  catch(e){ $('mtMsg').style.color='var(--danger)'; $('mtMsg').textContent='⚠ '+e.message; }
};
if($('mtSave')) $('mtSave').onclick=async()=>{
  try{ await api('/integrations/meeting',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:$('mtSecret').value,auto:$('mtAuto').checked,pullUrl:$('mtPullUrl').value.trim(),pullToken:$('mtPullToken').value.trim()})});
    $('mtSecret').value=''; $('mtMsg').style.color='var(--brand)'; $('mtMsg').textContent='збережено ✓'; await loadMeeting(); }
  catch(e){ $('mtMsg').style.color='var(--danger)'; $('mtMsg').textContent='⚠ '+e.message; }
};
if($('mtNoSig')) $('mtNoSig').onclick=async()=>{
  try{ await api('/integrations/meeting',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clearSecret:true})});
    $('mtSecret').placeholder='секрет для HMAC - лише якщо твій сервіс уміє його слати';
    $('mtMsg').style.color='var(--brand)'; $('mtMsg').textContent='підпис вимкнено - працює лише токен в адресі'; await loadMeeting(); }
  catch(e){ $('mtMsg').style.color='var(--danger)'; $('mtMsg').textContent='⚠ '+e.message; }
};
$('ffHookCopy').onclick=()=>{ const v=$('ffHook').value; if(v){ navigator.clipboard.writeText(v); flashSaved(); } };
$('ffSave').onclick=async()=>{ try{ await api('/integrations/transcription',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:$('ffKey').value,webhookSecret:$('ffSecret').value,autoRun:$('ffAuto').checked})}); $('ffKey').value=''; $('ffSecret').value=''; $('ffMsg').style.color='var(--brand)'; $('ffMsg').textContent='збережено ✓'; await loadFF(); }catch(e){ $('ffMsg').style.color='var(--danger)'; $('ffMsg').textContent='⚠ '+e.message; } };
$('ffNoSig').onclick=async()=>{ if(!confirm('Прибрати webhook-підпис? Вебхук прийматиметься лише за секретним токеном в URL - найнадійніше, якщо секрет не збігається з Fireflies.')) return; try{ await api('/integrations/transcription',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clearSecret:true})}); $('ffMsg').style.color='var(--brand)'; $('ffMsg').textContent='підпис прибрано - вебхук тепер прийме ✓'; await loadFF(); }catch(e){ $('ffMsg').style.color='var(--danger)'; $('ffMsg').textContent='⚠ '+e.message; } };
if($('ffAuto')) $('ffAuto').onchange=(e)=>{ if(e.target.checked && !confirm(AUTORUN_WARN)) e.target.checked=false; };
$('ffTest').onclick=async()=>{ $('ffMsg').style.color='var(--muted)'; $('ffMsg').textContent='перевіряю…'; try{ const l=await api('/transcription/list'); $('ffMsg').style.color='var(--brand)'; $('ffMsg').textContent='ОК, зустрічей: '+l.length; }catch(e){ $('ffMsg').style.color='var(--danger)'; $('ffMsg').textContent='⚠ '+e.message; } };
$('ffImport').onclick=async()=>{
  const ov=document.createElement('div'); ov.className='modal'; ov.style.zIndex='60';
  ov.innerHTML='<div class="modal-card" style="max-width:560px;padding:20px"><b>Імпорт із Fireflies</b><div id="ffList" class="out"><div class="empty"><span class="spin"></span> завантаження…</div></div><div class="btnrow"><button class="ghost" id="ffClose">Закрити</button></div></div>';
  document.body.appendChild(ov); const close=()=>ov.remove(); ov.addEventListener('click',e=>{if(e.target===ov)close();}); ov.querySelector('#ffClose').onclick=close;
  try{ const l=await api('/transcription/list'); const el=ov.querySelector('#ffList');
    if(!l.length){ el.innerHTML='<div class="empty">Немає зустрічей (або ще обробляються).</div>'; return; }
    el.innerHTML='';
    l.forEach(t=>{ const d=document.createElement('div'); d.className='card'; d.style.cursor='pointer'; const dt=t.date?new Date(+t.date).toISOString().slice(0,10):''; d.innerHTML='<b>'+esc(t.title||'Без назви')+'</b> <small style="color:var(--muted)"> '+dt+'</small>';
      d.onclick=async()=>{ el.innerHTML='<div class="empty"><span class="spin"></span> імпорт…</div>'; try{ const r=await api('/transcription/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:t.id})}); runId=r.runId; localStorage.setItem('kg_run',runId); $('transcript').value=''; close(); updRunLabel(); go('create'); setLayout('studio'); await refresh(); flash('Імпортовано: '+(r.title||'')+'. Тепер «Згенерувати пости».'); }catch(e){ el.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; } };
      el.appendChild(d); });
  }catch(e){ ov.querySelector('#ffList').innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
};

// ---------- Акаунт ----------
async function loadAccount(){
  try{ const a=await api('/account'); const mb=(a.media.bytes/1048576).toFixed(1);
    $('accInfo').innerHTML='Email: <b>'+esc(a.email||'')+'</b>'+(a.emailVerified?' ✓':' (не підтверджено)')+' · Медіа: '+a.media.count+' файлів ('+mb+' МБ)'+(a.hasPassword?'':' · вхід лише через Google');
    if(a.admin && $('admKeysPanel')){ $('admKeysPanel').style.display=''; loadAdminKeys(); loadAdminSpend(); loadAdminHealth(); }
  }catch(e){ $('accInfo').textContent='-'; }
}

// ---------- Стан сервісу (адмін) ----------
// Моніторингу не було зовсім: про сплеск помилок дізнавались від користувача. Тут - зріз за добу
// з того, що вже лежить у БД (app_log, llm_usage, job) плюс останні бекапи, якщо тека змонтована.
async function loadAdminHealth(){
  const box=$('admHealth'); if(!box) return;
  try{
    const h=await api('/admin/health');
    const errs=(h.errors||[]).slice(0,8);
    let out='<div class="grid2" style="gap:10px;margin-bottom:8px">'
      +'<div class="card"><b style="font-size:20px;color:'+((h.errorCount||0)>0?'var(--danger)':'var(--brand)')+'">'+(h.errorCount||0)+'</b><div class="hint">помилок за добу'+((h.warnCount||0)?' · '+h.warnCount+' попереджень':'')+'</div></div>'
      +'<div class="card"><b style="font-size:20px">$'+Number(h.spendToday||0).toFixed(2)+'</b><div class="hint">витрачено на AI сьогодні, усі кабінети</div></div>'
      +'<div class="card"><b style="font-size:20px;color:'+((h.lostJobs||0)?'var(--amber)':'inherit')+'">'+(h.runningJobs||0)+' / '+(h.lostJobs||0)+'</b><div class="hint">джоб зараз біжить / втрачено при рестарті за добу</div></div>'
      +'<div class="card"><b style="font-size:14px">'+(h.lastBackup?esc(h.lastBackup):'не видно')+'</b><div class="hint">останній бекап'+(h.lastBackup?'':' - тека не змонтована або ще жодного')+'</div></div></div>';
    if(errs.length) out+='<div style="font-size:12.5px">'+errs.map(e=>'<div style="display:flex;gap:8px;padding:3px 0;border-top:1px solid var(--line2)"><span style="color:'+(e.level==='error'?'var(--danger)':'var(--amber)')+';min-width:44px">'+esc(e.level)+'</span><span style="min-width:90px;color:var(--muted)">'+esc(e.scope)+'</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(e.message)+'">'+esc(e.message)+'</span><span style="color:var(--faint)">×'+e.n+'</span></div>').join('')+'</div>';
    else out+='<div class="hint">За добу - жодної помилки в журналі.</div>';
    out+='<div class="hint" style="margin-top:8px">Зовнішню перевірку доступності (UptimeRobot / Better Stack на <code>/health</code>) сервіс сам поставити не може - це одна дія в їхньому кабінеті.</div>';
    box.innerHTML=out;
  }catch(e){ box.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
// ---------- Витрати по кабінетах (адмін) ----------
// Стеля на кабінет живе на `workspace`, а не в settings_block: інакше кожен підняв би її собі сам.
async function loadAdminSpend(){
  const box=$('admSpend'); if(!box) return;
  try{
    const r=await api('/admin/spend'); const d=r.defaults||{};
    let h='<div class="hint" style="margin-bottom:8px">Дефолт із .env: день <b>$'+Number(d.day).toFixed(2)+'</b> · місяць <b>$'+Number(d.month).toFixed(2)+'</b> · до '+d.callsPerMin+' викликів/хв. Порожнє поле = дефолт, 0 = без обмеження.</div>';
    // 🤖 Стан сайдкара підписки. Показуємо ЗАВЖДИ, бо «чому мої генерації раптом платні» без цього
    // рядка діагностується лише в логах: фолбек на API навмисно тихий для користувача.
    const c=r.cli||{};
    h+='<div id="admCli" class="hint" style="margin-bottom:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px">🤖 <b>Claude через підписку (CLI)</b>: '
      +(c.up?'<span style="color:var(--ok,#2e7d32)">сайдкар живий</span>'+(c.tokenSet?'':' <b style="color:#c62828">але токен не заданий</b>')+(c.queued?' · у черзі '+c.queued:'')
           :'<span style="color:var(--faint)">не підключений</span> <span style="color:var(--faint)">('+esc(c.error||'сервісу немає на цьому інстансі')+')</span>')
      +(c.cooldown?'<br>⏸ '+esc(c.cooldown):'')
      +'<br><span style="color:var(--faint)">Дозвіл дається кабінету поштучно: токен підписки належить людині, а квота спільна. Вимкнено - кабінет працює через API, як і раніше.</span></div>';
    h+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px"><tr style="color:var(--muted);text-align:left"><th style="padding:4px 6px">Кабінет</th><th style="padding:4px 6px">Сьогодні</th><th style="padding:4px 6px">Місяць</th><th style="padding:4px 6px">Стеля день</th><th style="padding:4px 6px">Стеля місяць</th><th style="padding:4px 6px" title="Claude через підписку замість оплати токенів API">🤖 CLI</th><th></th></tr>';
    for(const w of (r.workspaces||[])){
      h+='<tr data-ws="'+esc(w.id)+'" style="border-top:1px solid var(--line)"><td style="padding:5px 6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(w.id)+'">'+esc(w.emails||'(без користувача)')+'</td>'
        +'<td style="padding:5px 6px;font-variant-numeric:tabular-nums">$'+Number(w.day||0).toFixed(3)+' <span style="color:var(--faint)">('+(w.calls||0)+')</span></td>'
        +'<td style="padding:5px 6px;font-variant-numeric:tabular-nums">$'+Number(w.month||0).toFixed(2)+'</td>'
        +'<td style="padding:5px 6px"><input class="txt sDay" style="width:80px;padding:4px 6px" value="'+(w.spend_cap_day!=null?esc(String(w.spend_cap_day)):'')+'" placeholder="'+Number(d.day).toFixed(0)+'"></td>'
        +'<td style="padding:5px 6px"><input class="txt sMon" style="width:80px;padding:4px 6px" value="'+(w.spend_cap_month!=null?esc(String(w.spend_cap_month)):'')+'" placeholder="'+Number(d.month).toFixed(0)+'"></td>'
        +'<td style="padding:5px 6px;text-align:center"><input type="checkbox" class="sCli"'+(w.cli_enabled?' checked':'')+'></td>'
        +'<td style="padding:5px 6px"><button class="ghost sSave" style="padding:4px 10px">Зберегти</button></td></tr>';
    }
    box.innerHTML=h+'</table></div>';
    box.querySelectorAll('tr[data-ws]').forEach(tr=>{ tr.querySelector('.sSave').onclick=async()=>{
      const ws=tr.getAttribute('data-ws');
      try{
        await api('/admin/spend/'+ws,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({day:tr.querySelector('.sDay').value.trim(),month:tr.querySelector('.sMon').value.trim()})});
        await api('/admin/cli/'+ws,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:tr.querySelector('.sCli').checked})});
        flashSaved(); loadAdminSpend();
      }
      catch(e){ alert('⚠ '+e.message); } }; });
  }catch(e){ box.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
// ---------- Ключі провайдерів (адмін) ----------
// Значення сюди НЕ приходить - лише «стоїть/не стоїть», джерело і хвіст із 4 символів.
// Тому поле завжди порожнє: воно для ВВЕДЕННЯ нового ключа, а не для редагування наявного.
const KEYGRP={text:'📝 Тексти',image:'🖼 Зображення',video:'🎬 Відео та озвучка',other:'Інше'};
async function loadAdminKeys(){
  const box=$('admKeys'); if(!box) return;
  box.innerHTML='<div class="empty">…</div>';
  try{
    const r=await api('/admin/keys');
    const groups={};
    for(const k of r.keys){ (groups[k.group]=groups[k.group]||[]).push(k); }
    let h='';
    if(r.kie.ready) h+='<div class="hint" style="margin-bottom:10px">kie.ai: ключ працює'+(r.kie.credits!=null?' · баланс <b>'+r.kie.credits+'</b> кредитів (≈ $'+(r.kie.credits*0.005).toFixed(2)+')':'')+'</div>';
    for(const g of Object.keys(KEYGRP)){
      const list=groups[g]; if(!list||!list.length) continue;
      h+='<div style="font-weight:700;font-size:13px;margin:12px 0 6px">'+KEYGRP[g]+'</div>';
      for(const k of list){
        const badge = k.source==='admin' ? '<span style="color:var(--brand)">✓ з адмінки ····'+esc(k.tail)+'</span>'
          : k.source==='env' ? '<span style="color:var(--muted)">✓ з .env ····'+esc(k.tail)+'</span>'
          : '<span style="color:var(--amber)">не заданий</span>';
        h+='<div class="card" style="margin-bottom:8px" data-key="'+esc(k.name)+'">'
          +'<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">'
          +'<b>'+esc(k.label)+'</b> '+badge+'</div>'
          +'<div class="hint" style="margin:4px 0 8px">'+esc(k.hint)+' <code>'+esc(k.name)+'</code></div>'
          +'<div class="btnrow"><input class="txt" type="password" placeholder="вставити новий ключ" autocomplete="off" style="flex:1;min-width:180px">'
          +'<button class="primary kSave">Зберегти</button>'
          +(k.source==='admin'?'<button class="ghost kDel">Прибрати</button>':'')
          +'<span class="kMsg" style="font-size:12px;color:var(--muted)"></span></div></div>';
      }
    }
    box.innerHTML=h||'<div class="empty">Немає керованих ключів.</div>';
    box.querySelectorAll('.card').forEach(c=>{
      const name=c.getAttribute('data-key'), inp=c.querySelector('input'), msg=c.querySelector('.kMsg');
      c.querySelector('.kSave').onclick=async()=>{
        const v=inp.value.trim(); if(!v){ msg.style.color='var(--danger)'; msg.textContent='порожньо'; return; }
        msg.style.color='var(--muted)'; msg.textContent='…';
        try{ await api('/admin/keys/'+name,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:v})});
          inp.value=''; loadAdminKeys(); }
        catch(e){ msg.style.color='var(--danger)'; msg.textContent='⚠ '+e.message; }
      };
      const del=c.querySelector('.kDel');
      if(del) del.onclick=async()=>{ if(!confirm('Прибрати ключ з адмінки? Повернеться значення з .env, якщо воно там є.')) return;
        try{ await api('/admin/keys/'+name,{method:'DELETE'}); loadAdminKeys(); }catch(e){ alert('⚠ '+e.message); } };
    });
  }catch(e){ box.innerHTML='<div class="empty">⚠ '+esc(e.message)+'</div>'; }
}
$('accPwSave').onclick=async()=>{ const m=$('accPwMsg'); m.style.color='var(--muted)'; m.textContent='…'; try{ await api('/account/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:$('accCurPw').value,newPassword:$('accNewPw').value})}); $('accCurPw').value=''; $('accNewPw').value=''; m.style.color='var(--brand)'; m.textContent='пароль змінено ✓'; }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } };
$('accEmailSave').onclick=async()=>{ const m=$('accEmailMsg'); m.style.color='var(--muted)'; m.textContent='…'; try{ const r=await api('/account/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('accNewEmail').value,password:$('accEmailPw').value})}); $('accEmailPw').value=''; $('accNewEmail').value=''; m.style.color='var(--brand)'; m.textContent='email змінено ✓'; if($('userEmail'))$('userEmail').textContent=r.email; loadAccount(); }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; } };
$('accExport').onclick=()=>{ window.location.href='/api/account/export'; };
$('accDelete').onclick=async()=>{ const email=prompt('Видалення акаунта.\nДані одразу зникнуть з кабінету, остаточно зітруться через 14 днів (увійди, щоб скасувати).\n\nВведи свій email для підтвердження:'); if(!email) return; try{ const r=await api('/account/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmEmail:email})}); alert(r.message||'Акаунт заплановано до видалення.'); location.href='/login'; }catch(e){ alert('⚠ '+e.message); } };
$('accReset').onclick=async()=>{ const c=prompt('Це СОТРЕ весь контент: бренд, стратегію, рубрики, джерела, пости, календар, медіа - і поверне онбординг. Канали лишаться підключені.\n\nВведи RESET для підтвердження:'); if(!c) return; try{ const r=await api('/account/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:c})}); alert(r.message||'Готово.'); location.href='/app'; }catch(e){ alert('⚠ '+e.message); } };

// ---------- Стратегія ----------
let STRAT = { data:{}, status:"none" };
const WEEK=[['mon','Пн'],['tue','Вт'],['wed','Ср'],['thu','Чт'],['fri','Пт'],['sat','Сб'],['sun','Нд']];
function renderStrategy(){
  const d=STRAT.data||{}, st=STRAT.status;
  $('stratStatus').textContent = st==='applied'?'застосовано':(st==='draft'?'чернетка':'нема');
  const o=$('stratView'); if(!o) return;
  if(!d || !Object.keys(d).length){ o.innerHTML='<div class="empty">Натисни «Згенерувати».</div>'; return; }
  const rubs=(d.rubrics||[]).map(r=>(r.emoji||'')+' '+esc(r.name||'')+' '+(r.share||0)+'%').join(' · ');
  const themes=(d.monthly_themes||[]).map(t=>esc(typeof t==='string'?t:((t&&t.themes)||[]).join(', '))).filter(Boolean).join(' · ');
  const sel=new Set((d.best_days||[]).map(x=>String(x).toLowerCase().slice(0,3)));
  const times=(Array.isArray(d.times)&&d.times.length?d.times:['11:00']).join(', ');
  o.innerHTML='<div class="card"><b>Рубрики:</b> '+(rubs||'-')+'</div>'
    +'<div class="card"><b>🗓️ Розклад постингу</b><div class="hint" style="margin:6px 0">Дні й час підібрані під нішу та канал. Скоригуй - планувальник бере саме це.</div>'
      +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">'+WEEK.map(w=>'<label class="rchip"><input type="checkbox" class="stDay" value="'+w[0]+'"'+(sel.has(w[0])?' checked':'')+'> '+w[1]+'</label>').join('')+'</div>'
      +'<label style="font-size:12px;color:var(--muted)">Час (HH:MM, через кому = кілька на день): <input id="stTimes" class="txt" value="'+esc(times)+'" style="width:170px;display:inline-block;padding:7px 9px"></label>'
      +'<div class="btnrow"><button class="primary" id="saveSched">Зберегти розклад</button><span id="schedMsg" style="font-size:12px;color:var(--muted)"></span></div>'
      +(d.schedule_rationale?'<div class="hint" style="margin-top:8px">💡 '+esc(d.schedule_rationale)+'</div>':'')+'</div>'
    +'<div class="card"><b>Частота:</b> '+((d.frequency&&d.frequency.posts_per_week)||'?')+' пост/тиж · <b>Канали:</b> '+esc((d.channels||[]).join(', ')||'-')+'</div>'
    +(themes?'<div class="card"><b>Теми:</b> '+themes+'</div>':'');
  o.querySelectorAll('.stDay').forEach(cb=>{ const l=cb.closest('.rchip'); l.classList.toggle('on',cb.checked); cb.addEventListener('change',()=>l.classList.toggle('on',cb.checked)); });
  const sb=$('saveSched'); if(sb) sb.onclick=saveSchedule;
}
async function saveSchedule(){
  const days=[...document.querySelectorAll('.stDay:checked')].map(c=>c.value);
  const times=(($('stTimes')||{}).value||'').split(',').map(s=>s.trim()).filter(s=>/^\d{1,2}:\d{2}$/.test(s));
  STRAT.data=STRAT.data||{}; STRAT.data.best_days=days; STRAT.data.times=times;
  const m=$('schedMsg'); if(m){m.style.color='var(--muted)'; m.textContent='зберігаю…';}
  try{ await api('/strategy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:STRAT.data})}); if(m){m.style.color='var(--brand)'; m.textContent='збережено ✓';} }
  catch(e){ if(m){m.style.color='var(--danger)'; m.textContent='⚠ '+e.message;} }
}
async function loadStrategy(){ try{ STRAT=await api('/strategy'); }catch(e){ STRAT={data:{},status:'none'}; } renderStrategy(); }
$('genStrat').onclick=async()=>{ const m=$('stratMsg'); m.style.color='var(--muted)'; m.textContent='генерую…'; aiBusy('🧠 Генерую стратегію бренду…'); try{ const r=await api('/strategy/generate',{method:'POST'}); STRAT={data:r.data,status:r.status||'applied'}; renderStrategy(); await loadRubrics(); await loadSettings(); m.style.color='var(--brand)'; m.textContent='готово - рубрики застосовано ✓'; }catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }finally{ aiDone(); } };
// ---------- Контент-план по каналах (v2) ----------
function renderChannelPlan(rows){ const o=$('cpView'); if(!o) return; if(!rows||!rows.length){ o.innerHTML='<div class="empty">Порожньо.</div>'; return; }
  o.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">'
    +'<thead><tr style="text-align:left;color:var(--muted)"><th style="padding:6px 8px">День</th><th>Пілер</th><th>H-H-H</th><th>Воронка</th><th>Формат</th><th>Гачок</th><th>CTA</th><th>KPI</th></tr></thead><tbody>'
    +rows.map(r=>'<tr style="border-top:1px solid var(--line)"><td style="padding:6px 8px">'+esc(String(r.day??''))+'</td><td>'+esc(r.pillar||'')+'</td><td>'+esc(r.hhh||'')+'</td><td>'+esc(r.funnel||'')+'</td><td>'+esc(r.format||'')+'</td><td><b>'+esc(r.hook||'')+'</b><div style="color:var(--muted)">'+esc(r.message||'')+'</div></td><td>'+esc(r.cta||'')+'</td><td>'+esc(r.kpi||'')+'</td></tr>').join('')
    +'</tbody></table></div>';
}
async function loadChannelPlan(){ const ch=($('cpChannel')||{}).value||'telegram'; try{ const r=await api('/channel-plan/'+ch); renderChannelPlan(r.rows); }catch(e){ renderChannelPlan([]); } }
if($('cpChannel')) $('cpChannel').onchange=loadChannelPlan;
if($('cpGen')) $('cpGen').onclick=async()=>{ const m=$('cpMsg'); const ch=$('cpChannel').value; m.style.color='var(--muted)'; m.textContent='будую план для '+(CP_LABEL[ch]||ch)+'…'; aiBusy('📅 Будую контент-план для '+(CP_LABEL[ch]||ch)+'…');
  try{ const r=await api('/channel-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:ch,horizon:+$('cpHorizon').value||30,posts_per_week:+$('cpPpw').value||4})}); renderChannelPlan(r.rows); m.style.color='var(--brand)'; m.textContent='готово ✓ ('+(r.rows||[]).length+' пунктів)'; }
  catch(e){ m.style.color='var(--danger)'; m.textContent='⚠ '+e.message; }finally{ aiDone(); } };

// ---------- Рубрики ----------
const RUB_COLORS = ['var(--brand)','var(--tg)','var(--amber)','var(--ig)','var(--fb)','var(--brand2)','var(--danger)'];
function rubSum(){ return Rubrics.reduce((a,r)=>a+(+r.share||0),0); }
function renderRubBar(){ const s=rubSum(); const el=$('rubSum'); el.textContent='сума: '+s+'%'+(s===100?' ✓':' (бажано 100%)'); el.style.color=s===100?'var(--brand)':'var(--amber)'; $('rubBar').innerHTML=Rubrics.map((r,i)=>'<div style="width:'+(+r.share||0)+'%;background:'+RUB_COLORS[i%RUB_COLORS.length]+'"></div>').join(''); }
function renderRubrics(){
  const list=$('rubList'); if(!list) return; renderRubBar(); list.innerHTML='';
  Rubrics.forEach((r,i)=>{ const c=document.createElement('div'); c.className='card'; c.style.cssText='display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    c.innerHTML='<input class="txt" style="width:46px;text-align:center" data-f="emoji" value="'+esc(r.emoji||'')+'"><input class="txt" style="flex:1;min-width:110px" data-f="name" value="'+esc(r.name||'')+'" placeholder="Назва"><input class="txt" style="flex:2;min-width:150px" data-f="description" value="'+esc(r.description||'')+'" placeholder="Опис тем"><input class="txt" type="number" min="0" max="100" style="width:62px" data-f="share" value="'+(+r.share||0)+'"><span style="color:var(--muted)">%</span><button class="ghost" data-rm="'+i+'" style="padding:8px 11px">✕</button>';
    c.querySelectorAll('[data-f]').forEach(inp=>inp.oninput=()=>{ Rubrics[i][inp.dataset.f]= inp.dataset.f==='share'?(+inp.value||0):inp.value; if(inp.dataset.f==='share') renderRubBar(); });
    c.querySelector('[data-rm]').onclick=()=>{ Rubrics.splice(i,1); renderRubrics(); };
    list.appendChild(c);
  });
}
async function loadRubrics(){ try{ Rubrics=await api('/rubrics')||[]; }catch(e){ Rubrics=[]; } renderRubrics(); renderIdeaRubrics(); }
$('addRubric').onclick=()=>{ Rubrics.push({name:'',emoji:'',description:'',share:0}); renderRubrics(); };
$('saveRubrics').onclick=async()=>{ try{ await api('/rubrics',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rubrics:Rubrics})}); flashSaved(); flash('Рубрики збережено ✓'); }catch(e){ flash('Не вдалося зберегти рубрики: '+e.message); } };

// ---------- онбординг ----------
const OB_STEPS=[
  {title:'Звідки взяти твій голос?', desc:'Найшвидше - з твоїх постів: або з Instagram, або вставиш їх текстом на наступному кроці. Тисни «Далі», щоб пропустити.', key:'connect', type:'connect'},
  {title:'Про що ваш бренд і для кого?', desc:'Кілька речень про те, чим ти займаєшся і для кого. Ми використаємо це як контекст у кожному пості.', key:'marketing_context', ph:'Ніша + аудиторія: хто ви, для кого пишете, який результат даєте…', req:true},
  {title:'Ваш голос - встав 3-5 своїх постів', desc:'За ними AI виведе твій тон голосу, щоб тексти звучали як ти, а не як AI.', key:'voice_examples', ph:'Приклади постів, щоб AI вивів ваш стиль…'},
  {title:'Перше джерело (необовʼязково)', desc:'Встав транскрипт сесії або просто думку - і ми одразу покажемо готові пости.', key:'__transcript', ph:'Встав транскрипт/нотатку - зробимо перший контент…'},
];
let obIdx=0;
function showOnboarding(){ obIdx=0; $('onboarding').style.display='grid'; renderOb(); }
function renderOb(){
  const s=OB_STEPS[obIdx];
  $('obStep').textContent='Крок '+(obIdx+1)+' з '+OB_STEPS.length;
  $('obTitle').textContent=s.title; $('obDesc').textContent=s.desc;
  if(s.key==='voice_examples' && obVoiceImported) $('obDesc').textContent='✅ Голос уже виведено з твого Instagram. Можеш одразу «Далі» - або додай ще приклади постів.';
  $('obBar').style.width=((obIdx+1)/OB_STEPS.length*100)+'%';
  $('obBack').style.display=obIdx>0?'inline-flex':'none';
  $('obNext').textContent=obIdx===OB_STEPS.length-1?'Завершити ✨':'Далі →';
  $('obMsg').textContent='';
  const oc=$('obConnect');
  if(s.type==='connect'){
    $('obInput').style.display='none'; oc.style.display='block'; renderObConnect(oc);
  } else {
    $('obInput').style.display=''; oc.style.display='none';
    $('obInput').placeholder=s.ph||''; $('obInput').value=s._val||'';
  }
  const oe=$('obExtra'); if(oe){ if(s.key==='__transcript'){ oe.style.display='block'; oe.innerHTML='<button class="ghost" id="obTrBtn" style="font-size:13px">🎙 Підключити транскрибатор</button>'; const tb=$('obTrBtn'); if(tb) tb.onclick=openTranscriberModal; } else { oe.style.display='none'; oe.innerHTML=''; } }
}
$('obBack').onclick=()=>{ OB_STEPS[obIdx]._val=$('obInput').value; if(obIdx>0){obIdx--;renderOb();} };
$('obSkip').onclick=async()=>{ OB_STEPS[obIdx]._val=($('obInput').style.display!=='none'?$('obInput').value:''); await finishOnboarding(); };
$('obNext').onclick=async()=>{
  const s=OB_STEPS[obIdx]; const val=$('obInput').value.trim(); s._val=val;
  if(s.req && !val){ $('obMsg').textContent='Заповніть це поле'; return; }
  if(s.key==='marketing_context'){ await saveSetting('marketing_context',val); if($('mkt'))$('mkt').value=val; }
  else if(s.key==='voice_examples'){ await saveSetting('voice_examples',val); if($('voiceExamples'))$('voiceExamples').value=val; }
  if(obIdx<OB_STEPS.length-1){ obIdx++; renderOb(); return; }
  await finishOnboarding();
};
// завершити онбординг тим, що ВЖЕ маємо (включно з «Пропустити»): голос/бренд → run → генерація
async function finishOnboarding(){
  if($('obNext')) $('obNext').disabled=true;
  // одразу видимий стан «працюємо» на всю модалку, а не сірий рядок унизу, який виглядає як зависання
  const obCard=$('onboarding').querySelector('.modal-card');
  if(obCard) obCard.innerHTML='<div style="padding:44px;text-align:center">'
    +'<div style="font-size:40px;line-height:1;animation:obPulse 1.2s ease-in-out infinite">✨</div>'
    +'<h2 style="font-size:20px;font-weight:600;margin:14px 0 8px">Налаштовую твій кабінет</h2>'
    +'<div style="color:var(--muted);font-size:13.5px">Виводжу голос бренду і готую стратегію…</div>'
    +'<div style="margin-top:18px"><span class="spin"></span></div></div>';
  const valByKey=(k)=>{ const x=OB_STEPS.find(o=>o.key===k); return ((x&&x._val)||'').trim(); };
  try{ if(valByKey('voice_examples')){ try{ await api('/brand/derive-voice',{method:'POST'}); }catch(e){} }
       try{ await api('/strategy/generate',{method:'POST'}); }catch(e){}
       await saveSetting('onboarded','1');
       await loadSettings(); await loadStrategy(); await loadRubrics();
  }catch(e){}
  // run з транскрипту, інакше з Бази бренду (вона вже містить голос з IG, якщо підключав)
  const tr=valByKey('__transcript'); let rid=null;
  try{ const r=tr?await api('/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:tr})}):await api('/generate/from-brand',{method:'POST'}); rid=r.runId; }catch(e){}
  if(rid){ runId=rid; localStorage.setItem('kg_run',rid); updRunLabel(); await runOnbProgress(rid); }
  $('onboarding').style.display='none';
  go('create'); setLayout('studio'); try{ await refresh(); }catch(e){}
  flash(rid?'Готово - ось твої перші пости 🎉':'Готово! Додай джерело й натисни «Згенерувати пости».');
}
async function runOnbProgress(rid){
  const cnt=Number(($('ideaCount')||{}).value)||6;
  const card=$('onboarding').querySelector('.modal-card');
  if(card) card.innerHTML='<div style="padding:34px"><h2 style="font-size:21px;font-weight:600;margin:0 0 14px;text-align:center">Готуємо твій старт ✨</h2>'
    +'<div style="display:flex;flex-direction:column;gap:11px;font-size:14px;color:var(--ink2)">'
    +'<div>📝 Генеруємо перші <b>'+cnt+' постів</b> у твоєму голосі</div>'
    +'<div>🎨 Малюємо до них <b>зображення у стилі бренду</b></div>'
    +'<div>📷 Далі зможеш підключити <b>свій банк фото</b> й покращувати зображення для постів</div>'
    +'<div>🔗 У <b>Налаштуваннях</b> підключиш інші соцмережі (Telegram, Facebook, Threads)</div>'
    +'<div>📥 У <b>Джерелах</b> додаси інші джерела контенту (транскрипти, RSS, фото з Google Drive)</div>'
    +'</div><div style="text-align:center;margin-top:20px"><span class="spin"></span> <span style="color:var(--muted);font-size:13px">зачекай ~30-60 секунд…</span></div></div>';
  const minWait=new Promise(z=>setTimeout(z,3500)); // щоб встиг прочитати тези
  try{ await Promise.all([ api('/runs/'+rid+'/generate-lite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:cnt,images:true,provider:'gemini'})}), minWait ]); }catch(e){ await minWait; }
}

// ---------- OAuth у поп-апі (кабінет не закривається) ----------
function connectPopup(url){ try{ const w=Math.min(620,screen.width||620), h=Math.min(740,screen.height||740); const x=Math.max(0,((screen.width||w)-w)/2), y=Math.max(0,((screen.height||h)-h)/2); const p=window.open(url,'oauth_connect','width='+w+',height='+h+',left='+x+',top='+y); if(!p) location.href=url; }catch(e){ location.href=url; } return false; }
window.addEventListener('message',(ev)=>{ if(ev.origin!==location.origin) return; const d=ev.data||{}; if(!d.oauth) return;
  if(d.meta!=null){ try{loadMeta();}catch(e){} try{loadChanStatus();}catch(e){} const cs=(typeof OB_STEPS!=='undefined')&&OB_STEPS[obIdx]; if($('onboarding')&&$('onboarding').style.display!=='none'&&cs&&cs.type==='connect'){ obVoiceImported=false; renderOb(); } else flash(d.meta==='ok'?'Instagram/Facebook підключено ✓':'Не вдалося підключити Instagram/Facebook.'); }
  if(d.threads!=null){ try{loadThreads();}catch(e){} try{loadChanStatus();}catch(e){} flash(d.threads==='ok'?'Threads підключено ✓':'Не вдалося підключити Threads.'); }
  if(d.linkedin!=null){ try{loadLinkedin();}catch(e){} try{loadChanStatus();}catch(e){} flash(d.linkedin==='ok'?'LinkedIn підключено ✓':'Не вдалося підключити LinkedIn.'); }
  if(d.youtube!=null){ try{loadYoutube();}catch(e){} try{loadChanStatus();}catch(e){} flash(d.youtube==='ok'?'YouTube підключено ✓':'Не вдалося підключити YouTube.'); }
  if(d.tiktok!=null){ try{loadTiktok();}catch(e){} try{loadChanStatus();}catch(e){} flash(d.tiktok==='ok'?'TikTok підключено ✓':'Не вдалося підключити TikTok.'); }
  if(d.gdrive!=null){ try{loadGdrive();}catch(e){} flash(d.gdrive==='ok'?'Google Drive підключено ✓':'Не вдалося підключити Google Drive.'); }
});
async function renderObConnect(oc){
  oc.innerHTML='<div style="font-size:13px;color:var(--muted)">Перевіряю підключення…</div>';
  let st={}; try{ st=await api('/channels/status'); }catch(e){}
  if(!(st&&st.instagram)){
    // До схвалення App Review Meta OAuth проходить лише тестерам. Показувати стороннім
    // «Підключити Instagram» першою кнопкою = перший же дотик до сервісу закінчується помилкою.
    // Тож поки META_PUBLIC не задано, головна дія - текст, Instagram - друга і з чесною поміткою.
    const igBtn='<button class="btn'+(st.metaPublic?' primary':'')+'" style="display:inline-flex" onclick="return connectPopup(\'/api/integrations/meta/connect\')">📸 Підключити Instagram</button>';
    const igHint=st.metaPublic
      ? '<div style="font-size:12.5px;color:var(--muted);margin-top:8px">Відкриється в окремому вікні - кабінет не закриється. Після підключення автоматично виведемо твій голос.</div>'
      : '<div style="font-size:12.5px;color:var(--muted);margin-top:8px">Підключення Instagram зараз працює лише для запрошених тестерів - ми чекаємо на схвалення Meta. Голос так само добре виводиться з твоїх текстів.</div>';
    const txtBtn='<button class="btn'+(st.metaPublic?'':' primary')+'" id="obNoIg" style="display:inline-flex">✍️ Розповісти про бренд текстом</button>'
      +'<div style="font-size:12px;color:var(--faint);margin-top:6px">На наступних кроках опишеш бренд і вставиш 3-5 своїх постів - голос виведемо з них.</div>';
    oc.innerHTML = st.metaPublic
      ? igBtn+igHint+'<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">'+txtBtn+'</div>'
      : txtBtn+'<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">'+igBtn+igHint+'</div>';
    const ni=$('obNoIg'); if(ni) ni.onclick=()=>{ obIdx=1; renderOb(); };
    return; }
  let pages=[]; try{ pages=await api('/integrations/meta/pages'); }catch(e){}
  let html='<div style="padding:12px;border-radius:10px;background:var(--brand-soft);color:var(--brand);font-weight:600">✅ Instagram підключено</div>';
  if(pages.length>1) html+='<label style="display:block;font-size:12.5px;color:var(--ink2);margin:10px 0 4px">Акаунт для цього бренду:</label><select id="obIgSel" style="width:100%">'+pages.map(p=>'<option value="'+p.id+'"'+(p.current?' selected':'')+'>'+esc(p.name)+(p.ig?(' · IG @'+esc(p.ig)):'')+'</option>').join('')+'</select>';
  html+='<div id="obIgMsg" style="font-size:13px;color:var(--muted);margin-top:8px"></div>';
  oc.innerHTML=html;
  const doImport=async()=>{ const m=$('obIgMsg'); if(m)m.innerHTML='<span class="spin"></span> Вивчаю твої пости (голос, ніша, мова)…'; try{ const r=await api('/integrations/meta/import-voice',{method:'POST'}); if(r.marketing_context){ const st=OB_STEPS.find(o=>o.key==='marketing_context'); if(st) st._val=r.marketing_context; } if(r.language){ ensureLangOption(r.language); if($('langSel')) $('langSel').value=r.language; } if(m)m.textContent='✨ Голос, нішу й мову ('+(r.language||'?')+') виведено з '+r.count+' постів.'; }catch(e){ if(m)m.textContent='Не вдалося прочитати пости: '+e.message; } };
  if($('obIgSel')) $('obIgSel').onchange=async(e)=>{ const m=$('obIgMsg'); if(m)m.textContent='Перемикаю акаунт…'; try{ await api('/integrations/meta/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId:e.target.value})}); obVoiceImported=true; await doImport(); }catch(err){ if(m)m.textContent='⚠ '+err.message; } };
  if(!obVoiceImported){ obVoiceImported=true; await doImport(); }
}

// ---------- прогресивне розкриття: другорядні «професійні» панелі згорнуті ----------
// Фідбек Олега «сервіс виглядає важким»: просунуті панелі (ДНК, паспорт голосу, магніти, сходи,
// CTA, формат, b-roll) за замовчуванням - один рядок-заголовок; клік розгортає. Дані не чіпаються.
(function(){
  const FOLD=['🧬','🪪','🧲','🪜','📮 Конверсійні','📏','🎥'];
  document.querySelectorAll('.panel .ph').forEach(ph=>{
    const t=(ph.textContent||'').trim();
    if(!FOLD.some(f=>t.startsWith(f))) return;
    const panel=ph.closest('.panel'); if(!panel||panel.querySelector('.pfh')) return;
    const sum=document.createElement('div'); sum.className='pfh';
    sum.innerHTML='<span>'+esc(t.split('\n')[0].slice(0,60))+'</span><span style="margin-left:auto;color:var(--faint);font-size:12px;font-weight:400">налаштувати ▾</span>';
    sum.onclick=()=>{ panel.classList.remove('folded'); sum.style.display='none'; };
    panel.prepend(sum); panel.classList.add('folded');
  });
})();

// ---------- 🦉 Розум: сова-провідник ----------
// Обчислює «наступний крок» (сервер), летить до потрібної кнопки, показує репліку з дією.
// Idle: сидить на «R», кліпає, вдягає/знімає окуляри, інколи жартує. Реагує на зміну розділу й дії.
const GUIDE_JOKES=['🦉 Мудра сова не постить у неділю ввечері. Ну, майже.','🦉 Кажуть, я схожа на логотип. Це комплімент?','🦉 Пораджу як друг: спершу цінність, потім продаж.','🦉 *поправляє окуляри* Готовий до контенту?','🦉 Пам-пам… я тут, якщо загубишся.'];
function owlLog(tip,event){ try{ api('/guide/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tip,event})}); }catch(e){} }
function owlEmote(e){ const o=owlEl(); if(o) o.dataset.emote=e||'idle'; }
function owlBlink(){ const o=owlEl(); if(!o||o.dataset.emote==='sleep') return; o.classList.add('owl-blink'); setTimeout(()=>o.classList.remove('owl-blink'),140); }
function owlSpecs(on){ const o=owlEl(); if(o) o.classList.toggle('owl-specs',on!==false); }
function owlPerch(on){ const o=owlEl(); if(o) o.classList.toggle('owl-perch',!!on); }
// координати гнізда (домашня точка) - завжди ліворуч-внизу, над мобільною нижньою навігацією
function owlNestXY(){ const mobile=window.innerWidth<=700; const mx=mobile?12:20, mb=mobile?74:84;
  return { left:mx, top:window.innerHeight-mb-84 }; }
// підбір боку бульбашки (щоб не вилазила за екран, коли сова близько до краю)
function owlUpdateBubbleSide(leftPx){ const b=$('owlBubble'); if(!b) return;
  const bw=window.innerWidth<=700?210:250;
  b.classList.toggle('flip', leftPx+76+bw > window.innerWidth-10); }
// пряме позиціювання (без польоту) - для першої появи й під час перетягування
function owlMoveTo(left,top){ const o=owlEl(); if(!o) return;
  o.style.right='auto'; o.style.bottom='auto'; o.style.left=left+'px'; o.style.top=top+'px';
  owlUpdateBubbleSide(left);
  const b=$('owlBubble'); if(b) b.classList.toggle('below', top<170);
}
// короткий політ (розправлені крила, активний змах) від поточної точки до нової
function owlFlyTo(left,top,cb){ const o=owlEl(); if(!o) return;
  o.classList.add('owl-flying'); owlMoveTo(left,top);
  clearTimeout(o._flyT); o._flyT=setTimeout(()=>{ o.classList.remove('owl-flying'); if(cb) cb(); },620);
}
// координати цілі для селектора кнопки (з відступами від країв екрана)
function owlTargetXY(sel){ const el=sel&&document.querySelector(sel);
  if(!el||!el.offsetParent) return null;
  const r=el.getBoundingClientRect(), ow=76, oh=84;
  const left=Math.max(10,Math.min(window.innerWidth-ow-10, r.left+r.width/2-ow/2));
  const top=Math.max(10,Math.min(window.innerHeight-oh-10, r.bottom+8));
  return { left, top };
}
// долетіти до цілі селектора (чи в гніздо, якщо цілі нема на екрані) - не літає повторно в ту саму точку
function owlPosition(sel){ const o=owlEl(); const t=owlTargetXY(sel); const xy=t||owlNestXY();
  if(o){ o.dataset.atHome=t?'0':'1';
    const curL=parseFloat(o.style.left)||0, curT=parseFloat(o.style.top)||0;
    if(Math.round(curL)!==Math.round(xy.left)||Math.round(curT)!==Math.round(xy.top)) owlFlyTo(xy.left,xy.top);
  }
  owlPerch(!t);
  return xy.top<170?'below':'above';
}
// повернутися в гніздо (самостійно): якщо вже вдома - просто сідає, інакше короткий політ назад
function owlGoHome(after){ const o=owlEl(); if(!o){ if(after) after(); return; }
  if(o.dataset.atHome==='1'){ owlPerch(true); if(after) after(); return; }
  const n=owlNestXY(); owlFlyTo(n.left,n.top,()=>{ o.dataset.atHome='1'; owlPerch(true); if(after) after(); });
}
function owlHideBubble(fly){ const b=$('owlBubble'); if(b) b.style.display='none'; if(fly!==false) owlGoHome(); }
function owlShowTip(idx){ const o=owlEl(); if(!o||!Guide.tips.length) return;
  Guide.i=((idx==null?Guide.i:idx)%Guide.tips.length+Guide.tips.length)%Guide.tips.length;
  const t=Guide.tips[Guide.i];
  const firstReveal = (o.style.display==='none'||!o.style.display);
  const b=$('owlBubble'), tx=$('owlText'), acts=$('owlActs');
  const reveal=()=>{
    owlEmote(t.emote);
    const pos=owlPosition(t.target);
    b.classList.toggle('below',pos==='below');
    tx.textContent=t.text;
    const a=t.action||{};
    acts.innerHTML='<button id="owlDo">'+esc(a.label||'Гаразд')+'</button>';
    b.style.display='block'; Guide.shownAt=Date.now(); owlLog(t.id,'shown');
    const doBtn=$('owlDo'); if(doBtn) doBtn.onclick=()=>owlAct(t);
    $('owlNext').style.display=Guide.tips.length>1?'':'none';
  };
  if(firstReveal){
    // перша поява: матеріалізується в гнізді, даємо браузеру намалювати кадр - і аж тоді летить (інакше «телепорт» без анімації)
    const n=owlNestXY(); owlMoveTo(n.left,n.top); o.dataset.atHome='1'; o.style.display='block'; owlPerch(true);
    requestAnimationFrame(()=>requestAnimationFrame(reveal));
  } else reveal();
}
async function owlAct(t){ const a=t.action||{}; owlLog(t.id,'clicked'); owlHop();
  if(a.do==='takes'){ owlHideBubble(); if($('genTakes')){ selectView('create'); setCTab('posts'); setTimeout(()=>$('genTakes').click(),200); } return; }
  if(a.do==='addmaterial'){ owlHideBubble(); if(typeof openAddMaterial==='function') openAddMaterial(); return; }
  // вкладку тепер ставить сам selectView (маршрутизатор знає всі розділи) - без setTimeout-хаку
  // і без розгалуження по мережах; заодно працює й для Бренду, якого в старому переліку не було
  if(a.view) selectView(a.view, a.tab);
  owlHideBubble(); setTimeout(()=>loadGuide(),900); // спершу летить у гніздо, тоді - до наступного кроку
}
function owlHop(){ const o=owlEl(); if(!o) return; o.classList.add('owl-hop'); setTimeout(()=>o.classList.remove('owl-hop'),500); }
// silent=true: тихо освіжити дані з сервера (після дій юзера поза совою - затвердив/додав фото/запланував),
// без непроханого вильоту; якщо зараз показана підказка, що вже нерелевантна - тихо перейти на актуальну чи сховати.
async function loadGuide(silent){ if(!Guide.on) return;
  const prevId=Guide.tips[Guide.i]&&Guide.tips[Guide.i].id;
  let r; try{ r=await api('/guide/next'); }catch(e){ return; }
  if(r.off){ Guide.on=false; const o=owlEl(); if(o&&!silent) o.style.display='none'; return; }
  Guide.tips=r.tips||[];
  const b=$('owlBubble'), bubbleOpen=b&&b.style.display!=='none';
  if(silent){
    if(!bubbleOpen) return; // нічого не показано - просто освіжили масив на майбутнє
    if(!Guide.tips.length){ owlHideBubble(); return; }
    if(!Guide.tips.some(t=>t.id===prevId)){ Guide.i=0; owlShowTip(0); }
    return;
  }
  if(!Guide.tips.length){ const o=owlEl(); if(!o) return;
    if(o.style.display==='none'||!o.style.display){ const n=owlNestXY(); owlMoveTo(n.left,n.top); o.dataset.atHome='1'; o.style.display='block'; }
    else owlGoHome();
    owlEmote('sleep'); return; }
  Guide.i=0; owlShowTip(0);
}
// idle-петлі: кліпання, окуляри, рідкісний жарт (лише коли підказки нема й сова вдома)
function owlIdleLoops(){
  setInterval(owlBlink, 4200+Math.random()*2600);
  setInterval(()=>{ const o=owlEl(); if(o&&o.style.display!=='none') owlSpecs(!o.classList.contains('owl-specs')); }, 22000);
  setInterval(()=>{ const o=owlEl(), b=$('owlBubble'); if(!o||o.style.display==='none'||o.dataset.atHome!=='1') return;
    if(b&&b.style.display==='none'&&Math.random()<0.5){
      const tx=$('owlText'), acts=$('owlActs'); tx.textContent=GUIDE_JOKES[Math.floor(Math.random()*GUIDE_JOKES.length)]; acts.innerHTML=''; owlHop();
      b.classList.remove('below'); owlUpdateBubbleSide(owlNestXY().left); b.style.display='block'; $('owlNext').style.display='none';
      setTimeout(()=>{ if(b) b.style.display='none'; },6000);
    } }, 45000);
}
// перетягування: пороговий рух відрізняє drag від кліку (клік лишається на toggle бульбашки)
function owlEnableDrag(){
  const body=$('owlBody'), o=owlEl(); if(!body||!o) return;
  let sx=0,sy=0,ol=0,ot=0,active=false,moved=false;
  const xy=(e)=>({x:e.clientX,y:e.clientY});
  const onMove=(e)=>{ if(!active) return; const p=xy(e); const dx=p.x-sx, dy=p.y-sy;
    if(!moved&&(Math.abs(dx)>6||Math.abs(dy)>6)){ moved=true; o.classList.add('owl-dragging'); clearTimeout(o._flyT); o.classList.remove('owl-flying'); }
    if(!moved) return;
    const nl=Math.max(6,Math.min(window.innerWidth-82,ol+dx)), nt=Math.max(6,Math.min(window.innerHeight-90,ot+dy));
    owlMoveTo(nl,nt); o.dataset.atHome='0';
  };
  const onUp=()=>{ active=false; o.classList.remove('owl-dragging'); document.removeEventListener('pointermove',onMove); document.removeEventListener('pointerup',onUp);
    if(moved){ o._suppressClick=true; setTimeout(()=>{ o._suppressClick=false; },80); } };
  body.addEventListener('pointerdown',(e)=>{ if(e.button!=null&&e.button!==0) return;
    const r=o.getBoundingClientRect(); sx=e.clientX; sy=e.clientY; ol=r.left; ot=r.top; active=true; moved=false;
    document.addEventListener('pointermove',onMove); document.addEventListener('pointerup',onUp);
  });
}
function owlInit(){ const o=owlEl(); if(!o||o._wired) return; o._wired=true;
  $('owlBody').onclick=()=>{ if(o._suppressClick) return; const b=$('owlBubble'); if(b.style.display==='none'){ if(Guide.tips.length) owlShowTip(Guide.i); else loadGuide(); } else owlHideBubble(); };
  $('owlBubbleX').onclick=()=>owlHideBubble();
  $('owlNext').onclick=()=>owlShowTip(Guide.i+1);
  // єдиний перемикач увімк/вимк лишився в меню аватара (по кліку на саму сову вона просто ховається в гніздо, не вимикається)
  const umgState=$('umGuideState');
  const setGuideState=(on)=>{ if(umgState) umgState.textContent=on?'увімк.':'вимк.'; };
  const umg=$('umGuide'); if(umg) umg.onclick=()=>{ const um=$('userMenu'); if(um) um.style.display='none';
    if(Guide.on){ Guide.on=false; owlHideBubble(false); o.style.display='none'; setGuideState(false);
      api('/guide/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tip:'menu',event:'off'})}).catch(()=>{}); flash('Помічника вимкнено. Увімкнути знову - в меню аватара.'); }
    else{ Guide.on=true; const n=owlNestXY(); owlMoveTo(n.left,n.top); o.dataset.atHome='1'; o.style.display='block'; setGuideState(true);
      api('/guide/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tip:'menu',event:'on'})}).catch(()=>{}); loadGuide(); flash('🦉 Помічник Розум увімкнено'); }
  };
  owlSpecs(true); owlEnableDrag(); owlIdleLoops();
  window.addEventListener('resize',()=>{ if(o.style.display==='none') return;
    if(Guide.tips.length&&$('owlBubble').style.display!=='none'){ const t=Guide.tips[Guide.i]; if(t) owlMoveTo((owlTargetXY(t.target)||owlNestXY()).left,(owlTargetXY(t.target)||owlNestXY()).top); return; }
    if(o.dataset.atHome==='1'){ const n=owlNestXY(); owlMoveTo(n.left,n.top); }
  });
}

// ---------- init ----------
(async()=>{
  try{ const _q=new URLSearchParams(location.search); if(window.opener && window.opener!==window && (_q.has('meta')||_q.has('threads')||_q.has('gdrive')||_q.has('linkedin')||_q.has('youtube')||_q.has('tiktok'))){ window.opener.postMessage({oauth:true, meta:_q.get('meta'), threads:_q.get('threads'), gdrive:_q.get('gdrive'), linkedin:_q.get('linkedin'), youtube:_q.get('youtube'), tiktok:_q.get('tiktok')}, location.origin); document.body.innerHTML='<div style="padding:40px;text-align:center;font-family:sans-serif;color:#333">Готово ✓ Можна закрити це вікно.</div>'; try{window.close();}catch(e){} return; } }catch(e){}
  setTheme(localStorage.getItem('kg_theme')||'light');
  // маркер БЕТИ: щоб завжди було видно, в якому середовищі ти (прод не зачіпає)
  if(location.hostname.startsWith('beta.')){ document.title='[BETA] '+document.title;
    const bb=document.createElement('div'); bb.textContent='BETA';
    bb.style.cssText='position:fixed;bottom:76px;right:12px;z-index:95;background:#e67e22;color:#fff;font-weight:800;font-size:11px;padding:4px 10px;border-radius:20px;letter-spacing:.06em;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none';
    document.body.appendChild(bb); }
  // Пріоритет: АДРЕСА (#/publish/plan) → останній розділ із localStorage → «Сьогодні».
  // Саме адреса головна: оновлення сторінки, «назад», закладка й надісланий комусь лінк повертають
  // РІВНО той екран, а не дефолтну вкладку розділу.
  if(!applyRoute()){
    const _views=['today','create','publish','brand','strategy','sources','analytics','settings','tools'];
    const _lastView=localStorage.getItem('kg_view');
    const _lastTab=localStorage.getItem('kg_ctab');
    selectView(_views.includes(_lastView)?_lastView:'today', _lastView==='create'?_lastTab:undefined);
  }
  setLayout('studio'); renderCountChips();
  renderStudio(); renderInbox(); renderStudioSteps({}); renderSourceCard(null);
  try{ const me=await api('/auth/me'); $('userEmail').textContent=me.email; if(me.email) $('avatar').textContent=(me.email[0]||'О').toUpperCase(); }
  catch(e){ location.href='/login'; return; }
  await loadSettings();
  await loadTelegram(); loadThreads(); loadMeta(); loadLinkedin(); loadYoutube(); loadTiktok();
  const _sp=new URLSearchParams(location.search); const _thq=_sp.get('threads'), _mtq=_sp.get('meta'), _gdq=_sp.get('gdrive');
  if(_thq||_mtq||_gdq) history.replaceState(null,'',location.pathname);
  if(_thq){ go('settings'); alert(_thq==='ok'?'Threads підключено ✓':'Не вдалося підключити Threads. Перевірте дозволи й Redirect URI у Meta.'); }
  if(_mtq){ go('settings'); alert(_mtq==='ok'?'Facebook/Instagram підключено ✓':(_mtq==='nopage'?'Немає FB-Сторінки під цим акаунтом (потрібна Сторінка, де ти адмін).':'Не вдалося підключити Facebook/Instagram.')); }
  if(_gdq){ go('sources'); alert(_gdq==='ok'?'Google Drive підключено ✓':'Не вдалося підключити Google Drive.'); }
  await loadPrompts();
  loadRubrics(); loadStrategy(); loadFF(); loadMcp(); loadWorkspaces(); loadWsMembers(); loadRss(); loadRecent(); loadMedia(); loadGdrive(); loadImageProvider(); loadSttProvider(); loadTasks(); loadStudioPosts(); loadGoalCta(); loadMagnets();
  loadMaterials(); // стрічка + лічильник
  // ⚠️ вкладку Створення тут БІЛЬШЕ НЕ смикаємо: раніше цей рядок безумовно кликав setCTab і
  // перебивав адресу (#/create/ideas відкривався й одразу з'їжджав на Чорновики). Початкову вкладку
  // тепер ставить applyRoute/фолбек вище; сюди лишився лише сам завантажувач плану.
  loadPlan();
  await loadChanStatus();
  let _onb=true; try{ const st=await api('/settings'); if(!st.some(r=>r.key==='onboarded')){ _onb=false; showOnboarding(); } }catch(e){}
  // 🦉 сова-провідник (лише після онбордингу; не заважає першому налаштуванню)
  if(_onb){ try{ owlInit(); setTimeout(loadGuide,1500); }catch(e){} }
  updRunLabel();
  if(runId){ try{ await refresh(); }catch(e){ runId=null; localStorage.removeItem('kg_run'); updRunLabel(); } }
  loadPublish();
})();
