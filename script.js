'use strict';

const KAKAO_JS_KEY   = 'f7de42f6f30f90f4cd48b807c40608be';
const KAKAO_REST_KEY = 'c4ba953ded83884b69a66c084cd77317';
const KAKAO_REDIRECT = 'https://stashmap-iota.vercel.app';

// ── Firebase (동일 프로젝트, 컬렉션명 분리) ──────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyBcTMKjYDFOZ0MK7dvCJEkj-4aZzRub1L0',
  authDomain:        'placelog-75bbe.firebaseapp.com',
  projectId:         'placelog-75bbe',
  storageBucket:     'placelog-75bbe.firebasestorage.app',
  messagingSenderId: '715846954889',
  appId:             '1:715846954889:web:3f10bbac1e17bf66933b58',
};
let db;

// ── 카테고리 ──────────────────────────────────────────────────────────────────
const CATS = {
  vintage:  { label: '빈티지샵',   emoji: '◈', color: '#c4a8e0' },
  select:   { label: '편집샵',     emoji: '◇', color: '#f4a5c0' },
  flagship: { label: '플래그십',   emoji: '◆', color: '#85c0f0' },
  dept:     { label: '백화점',     emoji: '▪', color: '#82dfc4' },
  outlet:   { label: '아울렛',     emoji: '✦', color: '#f0a878' },
  popup:    { label: '팝업스토어', emoji: '◉', color: '#f0d878' },
};

const TAG_SVG = `<svg class="pin-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>`;

// ── IndexedDB (사진) ──────────────────────────────────────────────────────────
const photoDB = (() => {
  let _db = null;
  const open = () => new Promise((res, rej) => {
    const req = indexedDB.open('stashmap_v1', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('photos');
    req.onsuccess = e => { _db = e.target.result; res(); };
    req.onerror = () => rej(req.error);
  });
  const save = (id, blob) => new Promise((res, rej) => {
    const tx = _db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(blob, id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  const get = id => new Promise((res, rej) => {
    const tx = _db.transaction('photos', 'readonly');
    const req = tx.objectStore('photos').get(id);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  const remove = id => new Promise((res, rej) => {
    const tx = _db.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  return { open, save, get, remove };
})();

// ── 상태 ─────────────────────────────────────────────────────────────────────
let map;
let cards             = [];
let markers           = {};
let addMode           = false;
let tempMarker        = null;
let tempLatLng        = null;
let tempAddr          = '';
let activeId          = null;
let addTab            = 'store';
let selCat            = 'vintage';
let selStatus         = 'keep';
let pendingStorePhoto = null;
let pendingItemPhoto  = null;
let searchResults     = [];

let currentUser      = null;
let myCollections    = [];
let collectionsUnsub = null;
let placesUnsubList  = [];
let cardBuckets      = new Map();
let pendingInviteCol = null;

let sheetDrag   = false;
let sheetStartY = 0;

let currentTab = 'map';
let feedFilter = { cat: 'all', status: 'all' };

// ── Firestore ─────────────────────────────────────────────────────────────────
function initFirestore() {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
}

function setCardBucket(key, newCards) {
  cardBuckets.set(key, newCards);
  const merged = new Map();
  cardBuckets.forEach(bucket => bucket.forEach(c => merged.set(c.id, c)));
  cards = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (map) refreshPins();
  updateBadge();
  if (currentTab === 'feed')        renderFeed();
  if (currentTab === 'collections') renderCollectionsView();
}

function refreshPlacesSubscriptions() {
  placesUnsubList.forEach(u => u());
  placesUnsubList = [];
  cardBuckets.clear();

  const u1 = db.collection('spots')
    .where('userId', '==', currentUser.id)
    .onSnapshot(
      snap => setCardBucket('personal', snap.docs.map(d => d.data())),
      err  => toast('데이터 로드 오류: ' + err.message)
    );
  placesUnsubList.push(u1);

  myCollections.forEach(col => {
    const u = db.collection('spots')
      .where('collectionId', '==', col.id)
      .onSnapshot(
        snap => setCardBucket(col.id, snap.docs.map(d => d.data())),
        err  => console.error('[col spots]', err)
      );
    placesUnsubList.push(u);
  });
}

function subscribeToCollections() {
  if (collectionsUnsub) collectionsUnsub();
  collectionsUnsub = db.collection('stash_collections')
    .where('members', 'array-contains', currentUser.id)
    .onSnapshot(
      snap => {
        myCollections = snap.docs.map(d => d.data());
        updateCollectionSelector();
        refreshPlacesSubscriptions();
        if (currentTab === 'collections') renderCollectionsView();
      },
      err => toast('컬렉션 로드 오류: ' + err.message)
    );
}

// ── 인증 ─────────────────────────────────────────────────────────────────────
function initAuth() {
  if (!Kakao.isInitialized()) Kakao.init(KAKAO_JS_KEY);

  const params = new URLSearchParams(location.search);
  const code   = params.get('code');
  const invite = params.get('invite');

  if (invite) localStorage.setItem('stashmap_pending_invite', invite);

  if (code) {
    history.replaceState({}, '', location.pathname);
    handleOAuthCallback(code);
    return;
  }

  if (invite) history.replaceState({}, '', location.pathname);

  const stored = localStorage.getItem('stashmap_user');
  if (stored) {
    try { currentUser = JSON.parse(stored); onAuthReady(); return; } catch {}
  }
  showLoginScreen();
}

function showLoginScreen() { document.getElementById('login-screen').classList.remove('hidden'); }
function hideLoginScreen() { document.getElementById('login-screen').classList.add('hidden'); }

function setPopupHint(msg) {
  const el = document.getElementById('login-popup-hint');
  if (el) el.textContent = msg;
}

function loginWithKakao() {
  const url = new URL('https://kauth.kakao.com/oauth/authorize');
  url.searchParams.set('client_id',    KAKAO_REST_KEY);
  url.searchParams.set('redirect_uri', KAKAO_REDIRECT);
  url.searchParams.set('response_type', 'code');
  window.location.href = url.toString();
}

async function handleOAuthCallback(code) {
  try {
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        client_id:    KAKAO_REST_KEY,
        redirect_uri: KAKAO_REDIRECT,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || '토큰 오류');

    const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    if (userData.code < 0) throw new Error(`사용자 조회 실패 (${userData.code})`);

    currentUser = {
      id:           String(userData.id),
      nickname:     userData.kakao_account?.profile?.nickname || '사용자',
      profileImage: userData.kakao_account?.profile?.thumbnail_image_url || null,
    };
    localStorage.setItem('stashmap_user', JSON.stringify(currentUser));
    onAuthReady();
  } catch (e) {
    showLoginScreen();
    setPopupHint('⚠️ ' + e.message);
  }
}

function onAuthReady() {
  hideLoginScreen();
  updateUserUI();
  subscribeToCollections();
  handlePendingInvite();
}

function updateUserUI() {
  if (!currentUser) return;
  const avatar = document.getElementById('user-avatar');
  if (!avatar) return;
  avatar.classList.remove('hidden');
  if (currentUser.profileImage) {
    avatar.innerHTML = `<img src="${currentUser.profileImage}" alt="">`;
  } else {
    avatar.textContent = (currentUser.nickname[0] || '?').toUpperCase();
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById('profile-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) {
    updateProfileMenu();
    menu.classList.remove('hidden');
  } else {
    menu.classList.add('hidden');
  }
}

function updateProfileMenu() {
  if (!currentUser) return;
  const pmAvatar = document.getElementById('pm-avatar');
  if (pmAvatar) {
    if (currentUser.profileImage) {
      pmAvatar.innerHTML = `<img src="${currentUser.profileImage}" alt="">`;
    } else {
      pmAvatar.textContent = (currentUser.nickname[0] || '?').toUpperCase();
    }
  }
  const pmName  = document.getElementById('pm-name');
  if (pmName)  pmName.textContent  = currentUser.nickname;
  const pmCount = document.getElementById('pm-count');
  if (pmCount) pmCount.textContent = `저장한 매장 ${cards.length}곳`;
}

function logout() {
  document.getElementById('profile-menu')?.classList.add('hidden');
  localStorage.removeItem('stashmap_user');
  currentUser = null;
  if (collectionsUnsub) { collectionsUnsub(); collectionsUnsub = null; }
  placesUnsubList.forEach(u => u());
  placesUnsubList = []; cardBuckets.clear(); myCollections = []; cards = [];
  Object.keys(markers).forEach(id => removePin(id));
  updateBadge();
  const el = document.getElementById('user-avatar');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  switchTab('map');
  showLoginScreen();
}

// ── 부트스트랩 ────────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const wrap = document.getElementById('profile-wrap');
  const menu = document.getElementById('profile-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (wrap && !wrap.contains(e.target)) menu.classList.add('hidden');
});

document.addEventListener('DOMContentLoaded', async () => {
  await photoDB.open().catch(() => {});
  try {
    initFirestore();
    initMap();
    buildCatPills();
    setupListeners();
    document.getElementById('add-date').value = today();
  } catch (e) {
    console.error('[init]', e);
  }
  initAuth();
  requestAnimationFrame(() => document.body.classList.add('ready'));
});

// ── 지도 ─────────────────────────────────────────────────────────────────────
function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 6,
  });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p => { map.setCenter(new kakao.maps.LatLng(p.coords.latitude, p.coords.longitude)); map.setLevel(4); },
      () => {}
    );
  }
  kakao.maps.event.addListener(map, 'click', e => { if (addMode) placeTempPin(e.latLng); });
  document.getElementById('btn-zoomin').onclick  = () => map.setLevel(map.getLevel() - 1);
  document.getElementById('btn-zoomout').onclick = () => map.setLevel(map.getLevel() + 1);
}

function makeOverlayContent(cat, active, clickId) {
  const c = CATS[cat] || CATS.vintage;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="map-pin${active ? ' is-active' : ''}" style="--pc:${c.color}">
    <div class="pin-bub">${TAG_SVG}</div>
  </div>`;
  const pin = wrap.firstChild;
  if (clickId) pin.addEventListener('click', () => openViewSheet(clickId));
  return pin;
}

function makeTempContent() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="map-pin pin-temp" style="--pc:var(--acc);touch-action:none">
    <div class="pin-bub">${TAG_SVG}</div>
  </div>`;
  return wrap.firstChild;
}

function refreshPins() {
  Object.keys(markers).forEach(id => {
    if (!cards.find(c => c.id === id)) { removePin(id); if (activeId === id) closeSheet(); }
  });
  cards.forEach(card => { if (!markers[card.id]) addPin(card); });
}

function addPin(card) {
  const content = makeOverlayContent(card.category, false, card.id);
  const overlay = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(card.lat, card.lon),
    content, xAnchor: 0.5, yAnchor: 1, clickable: true, zIndex: 1,
  });
  overlay.setMap(map);
  markers[card.id] = overlay;
}

function removePin(id) {
  if (markers[id]) { markers[id].setMap(null); delete markers[id]; }
}

// ── 추가 모드 ─────────────────────────────────────────────────────────────────
function onFabClick() { addMode ? cancelAddMode() : startAddMode(); }

function startAddMode() {
  addMode = true;
  document.getElementById('add-banner').classList.remove('hidden');
  document.getElementById('btn-fab').classList.add('is-cancel');
  document.getElementById('fab-plus').classList.add('hidden');
  document.getElementById('fab-x').classList.remove('hidden');
  document.getElementById('map').classList.add('add-mode');
  document.getElementById('search-wrap').classList.add('hidden');
  clearSearch(); closeSheet();
}

function cancelAddMode() {
  addMode = false;
  document.getElementById('add-banner').classList.add('hidden');
  document.getElementById('btn-fab').classList.remove('is-cancel');
  document.getElementById('fab-plus').classList.remove('hidden');
  document.getElementById('fab-x').classList.add('hidden');
  document.getElementById('map').classList.remove('add-mode');
  document.getElementById('search-wrap').classList.remove('hidden');
  clearTempPin(); closeSheet();
}

function clearTempPin() {
  if (tempMarker) { tempMarker.setMap(null); tempMarker = null; }
  tempLatLng = null; tempAddr = '';
}

function placeTempPin(latlng) {
  clearTempPin();
  tempLatLng = latlng;
  const content = makeTempContent();
  tempMarker = new kakao.maps.CustomOverlay({
    position: latlng, content, xAnchor: 0.5, yAnchor: 1, clickable: true, zIndex: 10,
  });
  tempMarker.setMap(map);
  setupTempPinDrag(content, tempMarker);
  openAddSheet();
  reverseGeocode(latlng.getLat(), latlng.getLng());
  setTimeout(() => map.panBy(0, 80), 100);
}

function setupTempPinDrag(el, overlay) {
  let dragging = false;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); dragging = true; el.setPointerCapture(e.pointerId);
    map.setDraggable(false);
  }, { passive: false });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = document.getElementById('map').getBoundingClientRect();
    const pos  = map.getProjection().coordsFromContainerPoint(
      new kakao.maps.Point(e.clientX - rect.left, e.clientY - rect.top)
    );
    overlay.setPosition(pos); tempLatLng = pos;
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false; map.setDraggable(true);
    reverseGeocode(tempLatLng.getLat(), tempLatLng.getLng());
  });
}

function reverseGeocode(lat, lon) {
  const addrEl = document.getElementById('add-addr');
  addrEl.textContent = '주소 불러오는 중...';
  new kakao.maps.services.Geocoder().coord2Address(lon, lat, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      const addr = result[0].road_address?.address_name || result[0].address.address_name;
      tempAddr = addr; addrEl.textContent = addr;
      const nameEl = document.getElementById('add-name');
      if (!nameEl.value) nameEl.value = shortName(addr);
    } else { addrEl.textContent = ''; }
  });
}

// ── 시트 ─────────────────────────────────────────────────────────────────────
function openViewSheet(id) {
  activeId = id;
  populateView(id);
  showPanel('p-view');
  openSheet();
  Object.keys(markers).forEach(k => {
    const c = cards.find(c => c.id === k);
    if (c) markers[k].setContent(makeOverlayContent(c.category, k === id, c.id));
  });
  const card = cards.find(c => c.id === id);
  if (card) { map.panTo(new kakao.maps.LatLng(card.lat, card.lon)); setTimeout(() => map.panBy(0, 100), 350); }
}

function openAddSheet() { resetAddForm(); showPanel('p-add'); openSheet(); }

function showPanel(id) {
  document.querySelectorAll('.s-panel').forEach(p => p.classList.toggle('hidden', p.id !== id));
}

function openSheet() {
  document.getElementById('sheet').classList.add('is-open');
  liftMapControls(true);
  setTimeout(() => map && map.relayout(), 360);
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('is-open');
  liftMapControls(false);
  if (activeId) {
    const c = cards.find(c => c.id === activeId);
    if (c && markers[activeId]) markers[activeId].setContent(makeOverlayContent(c.category, false, c.id));
    activeId = null;
  }
  setTimeout(() => map && map.relayout(), 360);
}

function liftMapControls(up) {
  const h = up ? document.getElementById('sheet').offsetHeight : 0;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  document.querySelector('.zoom-ctrl').classList.toggle('lifted', up);
  document.querySelector('.btn-myloc').classList.toggle('lifted', up);
}

// ── 보기 패널 ─────────────────────────────────────────────────────────────────
async function populateView(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;

  const cat = CATS[card.category] || CATS.vintage;
  const catEl = document.getElementById('sv-cat');
  catEl.textContent = `${cat.emoji} ${cat.label}`;
  catEl.style.color = cat.color;

  document.getElementById('sv-name').textContent = card.name;
  document.getElementById('sv-addr').textContent = card.address || '';
  document.getElementById('sv-date').textContent = card.date || '';
  document.getElementById('sv-memo').textContent = card.memo || '';
  document.getElementById('sv-maplink').href = `https://maps.google.com/?q=${card.lat},${card.lon}`;

  const statusEl = document.getElementById('sv-status');
  const isBought = card.itemStatus === 'bought';
  statusEl.textContent = isBought ? '● BOUGHT' : '○ KEEP';
  statusEl.className   = `sv-status ${isBought ? 'is-bought' : 'is-keep'}`;

  const priceEl = document.getElementById('sv-price');
  const parts   = [card.brand, card.price ? formatPrice(card.price) : ''].filter(Boolean);
  priceEl.textContent = parts.join('  ·  ');

  const photosEl = document.getElementById('sv-photos');
  photosEl.innerHTML = '';
  const [storeBlob, itemBlob] = await Promise.all([
    photoDB.get(`${id}_store`).catch(() => null),
    photoDB.get(`${id}_item`).catch(() => null),
  ]);
  if (storeBlob || itemBlob) {
    photosEl.innerHTML = `<div class="sv-photo-grid">
      ${storeBlob ? `<div class="sv-photo"><img src="${URL.createObjectURL(storeBlob)}" alt="매장"></div>` : ''}
      ${itemBlob  ? `<div class="sv-photo"><img src="${URL.createObjectURL(itemBlob)}"  alt="아이템"></div>` : ''}
    </div>`;
  }
}

// ── 추가 폼 ───────────────────────────────────────────────────────────────────
function resetAddForm() {
  document.getElementById('add-name').value     = '';
  document.getElementById('add-addr').textContent = '';
  document.getElementById('add-brand').value    = '';
  document.getElementById('add-price').value    = '';
  document.getElementById('add-memo').value     = '';
  document.getElementById('add-date').value     = today();
  document.getElementById('add-collection').value = '';
  document.getElementById('store-prev').innerHTML = '';
  document.getElementById('item-prev').innerHTML  = '';
  document.getElementById('store-upzone').style.display = '';
  document.getElementById('item-upzone').style.display  = '';
  pendingStorePhoto = null; pendingItemPhoto = null;
  selCat = 'vintage'; selStatus = 'keep';
  switchAddTab('store');
  document.querySelectorAll('.cat-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.cat === 'vintage')
  );
  setStatus('keep');
}

function cancelAdd() { clearTempPin(); closeSheet(); }

function buildCatPills() {
  const wrap = document.getElementById('cat-pills');
  Object.entries(CATS).forEach(([key, c]) => {
    const btn = document.createElement('button');
    btn.className = `cat-pill${key === 'vintage' ? ' active' : ''}`;
    btn.dataset.cat = key;
    btn.textContent = `${c.emoji} ${c.label}`;
    btn.onclick = () => {
      selCat = key;
      document.querySelectorAll('.cat-pill').forEach(p => p.classList.toggle('active', p.dataset.cat === key));
    };
    wrap.appendChild(btn);
  });
}

function switchAddTab(tab) {
  addTab = tab;
  document.querySelectorAll('.s-tab').forEach(t => t.classList.toggle('active', t.dataset.stab === tab));
  document.querySelectorAll('.s-tabp').forEach(p => p.classList.toggle('hidden', p.id !== `sp-${tab}`));
}

function setStatus(status) {
  selStatus = status;
  document.getElementById('st-keep').classList.toggle('active',   status === 'keep');
  document.getElementById('st-bought').classList.toggle('active', status === 'bought');
}

// ── 사진 처리 ─────────────────────────────────────────────────────────────────
function handlePhoto(file, prevId, zoneId, which) {
  if (!file?.type.startsWith('image/')) { toast('이미지 파일만 업로드할 수 있어요'); return; }
  if (file.size > 20 * 1024 * 1024)    { toast('20MB 이하 파일만 업로드 가능해요'); return; }

  if (which === 'store') pendingStorePhoto = file;
  else                   pendingItemPhoto  = file;

  const zone = document.getElementById(zoneId);
  const prev = document.getElementById(prevId);
  if (zone) zone.style.display = 'none';

  prev.innerHTML = `<div class="upl-done">
    <img src="${URL.createObjectURL(file)}" alt="">
    <button class="btn-clr" onclick="clearPhoto('${prevId}','${zoneId}','${which}')">✕</button>
  </div>`;
}

function clearPhoto(prevId, zoneId, which) {
  if (which === 'store') pendingStorePhoto = null;
  else                   pendingItemPhoto  = null;
  document.getElementById(prevId).innerHTML = '';
  const zone = document.getElementById(zoneId);
  if (zone) zone.style.display = '';
}

// ── 저장 ─────────────────────────────────────────────────────────────────────
async function saveCard() {
  const name = document.getElementById('add-name').value.trim();
  if (!name)       { toast('매장명을 입력해주세요'); return; }
  if (!tempLatLng) { toast('지도를 탭해서 위치를 선택해주세요'); return; }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  const id   = uid();
  const card = {
    id,
    name,
    brand:         document.getElementById('add-brand').value.trim(),
    price:         document.getElementById('add-price').value.trim(),
    address:       tempAddr,
    region:        extractRegion(tempAddr),
    category:      selCat,
    itemStatus:    selStatus,
    lat:           tempLatLng.getLat(),
    lon:           tempLatLng.getLng(),
    hasStorePhoto: !!pendingStorePhoto,
    hasItemPhoto:  !!pendingItemPhoto,
    date:          document.getElementById('add-date').value,
    memo:          document.getElementById('add-memo').value.trim(),
    createdAt:     new Date().toISOString(),
    userId:        currentUser.id,
    userNickname:  currentUser.nickname,
    collectionId:  document.getElementById('add-collection').value || null,
  };

  await Promise.all([
    pendingStorePhoto ? photoDB.save(`${id}_store`, pendingStorePhoto).catch(() => {}) : null,
    pendingItemPhoto  ? photoDB.save(`${id}_item`,  pendingItemPhoto).catch(() => {})  : null,
  ].filter(Boolean));

  try {
    await db.collection('spots').doc(card.id).set(card);
    clearTempPin(); cancelAddMode(); closeSheet();
    toast(`${name} 저장됐어요`);
  } catch {
    btn.disabled = false;
    btn.innerHTML = '저장';
    toast('저장에 실패했어요. 다시 시도해주세요');
  }
}

// ── 삭제 ─────────────────────────────────────────────────────────────────────
async function deleteActive() {
  if (!activeId) return;
  const card = cards.find(c => c.id === activeId);
  if (!card || !confirm(`"${card.name}" 을(를) 삭제할까요?`)) return;
  const id = activeId;
  closeSheet();
  await Promise.allSettled([
    db.collection('spots').doc(id).delete(),
    photoDB.remove(`${id}_store`),
    photoDB.remove(`${id}_item`),
  ]);
  toast('삭제됐어요');
}

// ── 상태 토글 ─────────────────────────────────────────────────────────────────
async function toggleStatus() {
  if (!activeId) return;
  const card = cards.find(c => c.id === activeId);
  if (!card) return;
  const next = card.itemStatus === 'bought' ? 'keep' : 'bought';
  try {
    await db.collection('spots').doc(activeId).update({ itemStatus: next });
    toast(next === 'bought' ? 'BOUGHT으로 변경됐어요' : 'KEEP으로 변경됐어요');
  } catch { toast('변경에 실패했어요'); }
}

// ── 공유 ─────────────────────────────────────────────────────────────────────
async function shareActive() {
  const card = cards.find(c => c.id === activeId);
  if (!card) return;
  const cat  = CATS[card.category] || CATS.vintage;
  const text = [
    `${cat.emoji} ${card.name}`,
    card.brand, card.price ? formatPrice(card.price) : '',
    card.address, card.memo,
    `🗺️ https://maps.google.com/?q=${card.lat},${card.lon}`,
    '', 'via Stashmap',
  ].filter(Boolean).join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: card.name, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(text).catch(() => {});
  toast('클립보드에 복사됐어요');
}

// ── 내 위치 ───────────────────────────────────────────────────────────────────
function goMyLocation() {
  if (!navigator.geolocation) { toast('위치 권한이 필요해요'); return; }
  navigator.geolocation.getCurrentPosition(
    p => { map.setCenter(new kakao.maps.LatLng(p.coords.latitude, p.coords.longitude)); map.setLevel(3); },
    () => toast('위치를 가져올 수 없어요')
  );
}

// ── 검색 ─────────────────────────────────────────────────────────────────────
const doSearch = debounce(q => {
  const drop = document.getElementById('search-drop');
  if (!q.trim()) { hideDrop(); return; }
  drop.innerHTML = '<li class="no-res"><span class="spin"></span></li>';
  drop.classList.remove('hidden');
  new kakao.maps.services.Places().keywordSearch(q, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      searchResults = result; renderDrop(result);
    } else {
      drop.innerHTML = `<li class="no-res">${
        status === kakao.maps.services.Status.ZERO_RESULT ? '검색 결과가 없어요' : '검색 중 오류가 발생했어요'
      }</li>`;
      drop.classList.remove('hidden');
    }
  }, { size: 5 });
}, 420);

function renderDrop(results) {
  const drop = document.getElementById('search-drop');
  drop.innerHTML = results.map((r, i) => `
    <li onclick="selectResult(${i})">
      <span class="res-name">${esc(r.place_name)}</span>
      <span class="res-full">${esc(r.road_address_name || r.address_name)}</span>
    </li>`).join('');
  drop.classList.remove('hidden');
}

function hideDrop() { document.getElementById('search-drop').classList.add('hidden'); }

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('btn-sc').classList.add('hidden');
  hideDrop(); searchResults = [];
}

function selectResult(idx) {
  const r = searchResults[idx];
  if (!r) return;
  const latlng = new kakao.maps.LatLng(parseFloat(r.y), parseFloat(r.x));
  clearSearch();
  map.setCenter(latlng); map.setLevel(3);

  addMode = true;
  document.getElementById('btn-fab').classList.add('is-cancel');
  document.getElementById('fab-plus').classList.add('hidden');
  document.getElementById('fab-x').classList.remove('hidden');
  document.getElementById('map').classList.add('add-mode');

  clearTempPin();
  tempLatLng = latlng;
  tempAddr   = r.road_address_name || r.address_name;

  const content = makeTempContent();
  tempMarker = new kakao.maps.CustomOverlay({
    position: latlng, content, xAnchor: 0.5, yAnchor: 1, clickable: true, zIndex: 10,
  });
  tempMarker.setMap(map);
  setupTempPinDrag(content, tempMarker);

  setTimeout(() => {
    openAddSheet();
    setTimeout(() => {
      document.getElementById('add-name').value = r.place_name;
      document.getElementById('add-addr').textContent = r.road_address_name || r.address_name;
    }, 20);
    map.panBy(0, 80);
  }, 350);
}

// ── 이벤트 리스너 ─────────────────────────────────────────────────────────────
function setupListeners() {
  const sinp = document.getElementById('search-input');
  sinp.addEventListener('input', e => {
    document.getElementById('btn-sc').classList.toggle('hidden', !e.target.value);
    doSearch(e.target.value);
  });
  sinp.addEventListener('keydown', e => {
    if (e.key === 'Escape') clearSearch();
    if (e.key === 'Enter' && searchResults.length) selectResult(0);
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('search-wrap').contains(e.target)) hideDrop();
  });

  setupPhotoZone('store-inp', 'store-prev', 'store-upzone', 'store');
  setupPhotoZone('item-inp',  'item-prev',  'item-upzone',  'item');

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('sheet').classList.contains('is-open')) closeSheet();
      else if (addMode) cancelAddMode();
    }
  });

  setupSheetDrag();
}

function setupPhotoZone(inputId, prevId, zoneId, which) {
  const inp  = document.getElementById(inputId);
  const zone = document.getElementById(zoneId);
  inp.addEventListener('change', e => {
    if (e.target.files[0]) handlePhoto(e.target.files[0], prevId, zoneId, which);
  });
  zone.addEventListener('click', () => inp.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handlePhoto(e.dataTransfer.files[0], prevId, zoneId, which);
  });
}

function setupSheetDrag() {
  const dragEl = document.getElementById('sheet-drag');
  const sheet  = document.getElementById('sheet');
  const onStart = e => { sheetStartY = (e.touches||[e])[0].clientY; sheetDrag = true; sheet.style.transition = 'none'; };
  const onMove  = e => {
    if (!sheetDrag) return;
    const dy = (e.touches||[e])[0].clientY - sheetStartY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = e => {
    if (!sheetDrag) return;
    sheetDrag = false;
    const dy = (e.changedTouches||[e])[0].clientY - sheetStartY;
    sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 90) closeSheet();
  };
  dragEl.addEventListener('touchstart', onStart, { passive: true });
  dragEl.addEventListener('touchmove',  onMove,  { passive: true });
  dragEl.addEventListener('touchend',   onEnd,   { passive: true });
  dragEl.addEventListener('mousedown',  onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onEnd);
}

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  const isMap  = tab === 'map';
  const isFeed = tab === 'feed';
  const isColl = tab === 'collections';

  document.getElementById('map').style.display       = isMap ? '' : 'none';
  document.getElementById('btn-fab').style.display   = isMap ? '' : 'none';
  document.querySelector('.btn-myloc').style.display = isMap ? '' : 'none';
  document.querySelector('.zoom-ctrl').style.display = isMap ? '' : 'none';
  document.getElementById('search-wrap').classList.toggle('hidden', !isMap);
  if (!isMap && addMode) cancelAddMode();

  document.getElementById('feed-view').classList.toggle('hidden', !isFeed);
  document.getElementById('coll-view').classList.toggle('hidden', !isColl);

  document.getElementById('tab-map').classList.toggle('active',  isMap);
  document.getElementById('tab-feed').classList.toggle('active', isFeed);
  document.getElementById('tab-coll').classList.toggle('active', isColl);

  if (isFeed)      renderFeed();
  else if (isColl) renderCollectionsView();
  else             setTimeout(() => map && map.relayout(), 50);
}

// ── 지역 추출 ─────────────────────────────────────────────────────────────────
function extractRegion(addr) {
  if (!addr) return '기타';
  const parts = addr.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '기타';
  const p1 = parts[1], p2 = parts[2] || '';
  if (/시$/.test(p1) && /구$/.test(p2)) return `${p1} ${p2}`;
  if (/[구군시]$/.test(p1)) return `${parts[0]} ${p1}`;
  return parts[0];
}

// ── 피드 ─────────────────────────────────────────────────────────────────────
function renderFeed() {
  renderFeedFilters();
  renderFeedList();
}

function renderFeedFilters() {
  const bar = document.getElementById('feed-filter-bar');
  bar.innerHTML = '';

  const chip = (label, key, val) => {
    const btn = document.createElement('button');
    btn.className = `chip${feedFilter[key] === val ? ' active' : ''}`;
    btn.textContent = label;
    btn.onclick = () => { feedFilter[key] = val; renderFeed(); };
    bar.appendChild(btn);
  };

  chip('전체', 'cat', 'all');
  Object.entries(CATS).forEach(([k, c]) => chip(`${c.emoji} ${c.label}`, 'cat', k));

  const sep = document.createElement('div');
  sep.className = 'filter-sep';
  bar.appendChild(sep);

  chip('KEEP', 'status', 'keep');
  chip('BOUGHT', 'status', 'bought');
  if (feedFilter.status !== 'all') {
    const all = document.createElement('button');
    all.className = 'chip';
    all.textContent = '전체';
    all.onclick = () => { feedFilter.status = 'all'; renderFeed(); };
    bar.appendChild(all);
  }
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  let filtered = [...cards];
  if (feedFilter.cat    !== 'all') filtered = filtered.filter(c => c.category   === feedFilter.cat);
  if (feedFilter.status !== 'all') filtered = filtered.filter(c => c.itemStatus === feedFilter.status);
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!filtered.length) {
    list.innerHTML = '<p class="feed-empty">저장된 스팟이 없어요</p>';
    return;
  }
  list.innerHTML = filtered.map(feedCard).join('');
  setTimeout(loadFeedPhotos, 80);
}

function feedCard(card) {
  const cat    = CATS[card.category] || CATS.vintage;
  const col    = card.collectionId ? myCollections.find(c => c.id === card.collectionId) : null;
  const bought = card.itemStatus === 'bought';
  return `<div class="fc${bought ? ' is-bought' : ''}" onclick="openFromFeed('${card.id}')">
    <div class="fc-photo-wrap" id="fc-photo-${card.id}"></div>
    <div class="fc-body">
      <div class="fc-top-row">
        <span class="fc-cat" style="color:${cat.color}">${cat.emoji} ${cat.label}</span>
        ${col ? `<span class="fc-coll"># ${esc(col.name)}</span>` : ''}
        <span class="fc-status ${bought ? 'bought' : 'keep'}">${bought ? 'BOUGHT' : 'KEEP'}</span>
      </div>
      <div class="fc-name">${esc(card.name)}</div>
      ${card.brand ? `<div class="fc-brand">${esc(card.brand)}</div>` : ''}
      ${card.price ? `<div class="fc-price">${formatPrice(card.price)}</div>` : ''}
      ${card.address ? `<div class="fc-addr">${esc(card.address)}</div>` : ''}
      ${card.memo   ? `<div class="fc-memo">${esc(card.memo)}</div>`   : ''}
    </div>
  </div>`;
}

async function loadFeedPhotos() {
  for (const card of cards) {
    const el = document.getElementById(`fc-photo-${card.id}`);
    if (!el) continue;
    if (!card.hasStorePhoto && !card.hasItemPhoto) continue;
    const blob = await photoDB.get(`${card.id}_store`).catch(() => null)
               || await photoDB.get(`${card.id}_item`).catch(() => null);
    if (!blob) continue;
    el.innerHTML = `<img class="fc-photo" src="${URL.createObjectURL(blob)}" alt="" loading="lazy">`;
  }
}

function openFromFeed(id) { switchTab('map'); setTimeout(() => openViewSheet(id), 120); }

// ── 컬렉션 ───────────────────────────────────────────────────────────────────
function renderCollectionsView() {
  const list = document.getElementById('coll-list');
  if (!list) return;
  if (!myCollections.length) {
    list.innerHTML = '<p class="coll-empty">아직 컬렉션이 없어요.<br>새 컬렉션을 만들거나 초대 링크로 참여해보세요.</p>';
    return;
  }
  list.innerHTML = myCollections.map(col => {
    const count   = cards.filter(c => c.collectionId === col.id).length;
    const isOwner = col.ownerId === currentUser.id;
    return `<div class="coll-item">
      <div class="ci-body">
        <div class="ci-name">${esc(col.name)}</div>
        <div class="ci-meta"><span>${col.members.length}명 · ${count}곳</span>
          ${!isOwner ? '<span class="ci-badge">참여중</span>' : ''}
        </div>
      </div>
      <div class="ci-btns">
        <button class="ci-btn ci-share" onclick="shareCollection('${col.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>
          초대
        </button>
        ${isOwner
          ? `<button class="ci-btn ci-del"   onclick="deleteCollection('${col.id}')">삭제</button>`
          : `<button class="ci-btn ci-leave" onclick="leaveCollection('${col.id}')">나가기</button>`}
      </div>
    </div>`;
  }).join('');
}

function updateCollectionSelector() {
  const sel = document.getElementById('add-collection');
  if (!sel) return;
  sel.innerHTML = '<option value="">개인 스태시</option>' +
    myCollections.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function showCreateCollection() {
  document.getElementById('coll-name-inp').value = '';
  document.getElementById('create-coll-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('coll-name-inp').focus(), 80);
}
function closeCreateCollection() { document.getElementById('create-coll-modal').classList.add('hidden'); }

async function saveCollection() {
  const name = document.getElementById('coll-name-inp').value.trim();
  if (!name) { toast('컬렉션 이름을 입력해주세요'); return; }
  const id = uid();
  const col = {
    id, name,
    inviteCode:    Math.random().toString(36).slice(2, 10).toUpperCase(),
    ownerId:       currentUser.id,
    ownerNickname: currentUser.nickname,
    members:       [currentUser.id],
    createdAt:     new Date().toISOString(),
  };
  try {
    await db.collection('stash_collections').doc(id).set(col);
    closeCreateCollection(); toast(`"${name}" 컬렉션을 만들었어요`);
  } catch { toast('만들기에 실패했어요'); }
}

async function shareCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col) return;
  const link = `${location.origin}${location.pathname}?invite=${col.inviteCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: col.name, url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  await navigator.clipboard.writeText(link).catch(() => {});
  toast('초대 링크가 복사됐어요');
}

async function deleteCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col || col.ownerId !== currentUser.id) return;
  if (!confirm(`"${col.name}" 컬렉션을 삭제할까요?`)) return;
  try {
    await db.collection('stash_collections').doc(colId).delete(); toast('컬렉션이 삭제됐어요');
  } catch { toast('삭제에 실패했어요'); }
}

async function leaveCollection(colId) {
  const col = myCollections.find(c => c.id === colId);
  if (!col || !confirm(`"${col.name}" 컬렉션에서 나갈까요?`)) return;
  try {
    await db.collection('stash_collections').doc(colId).update({
      members: firebase.firestore.FieldValue.arrayRemove(currentUser.id),
    });
    toast('컬렉션에서 나왔어요');
  } catch { toast('처리에 실패했어요'); }
}

// ── 초대 ─────────────────────────────────────────────────────────────────────
async function handlePendingInvite() {
  const code = localStorage.getItem('stashmap_pending_invite');
  if (!code) return;
  localStorage.removeItem('stashmap_pending_invite');
  try {
    const snap = await db.collection('stash_collections')
      .where('inviteCode', '==', code).limit(1).get();
    if (snap.empty) { toast('유효하지 않은 초대 링크예요'); return; }
    const col = snap.docs[0].data();
    if (col.members.includes(currentUser.id)) { toast(`이미 "${col.name}" 컬렉션의 멤버예요`); return; }
    pendingInviteCol = col;
    const msg = document.getElementById('invite-msg');
    if (msg) msg.innerHTML =
      `<strong>${esc(col.ownerNickname)}</strong>님의 <strong>${esc(col.name)}</strong> 컬렉션에 초대됐어요. 참여할까요?`;
    document.getElementById('invite-modal')?.classList.remove('hidden');
  } catch { toast('초대 링크 확인 중 오류가 발생했어요'); }
}

async function acceptInvite() {
  if (!pendingInviteCol) return;
  const btn = document.getElementById('btn-accept-invite');
  btn.disabled = true;
  try {
    await db.collection('stash_collections').doc(pendingInviteCol.id).update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.id),
    });
    document.getElementById('invite-modal').classList.add('hidden');
    toast(`"${pendingInviteCol.name}" 컬렉션에 참여했어요!`);
    pendingInviteCol = null;
  } catch { toast('참여에 실패했어요. 다시 시도해주세요'); }
  finally { btn.disabled = false; }
}

function declineInvite() {
  pendingInviteCol = null;
  document.getElementById('invite-modal').classList.add('hidden');
}

function updateBadge() {
  document.getElementById('pin-badge').textContent = `${cards.length} SPOTS`;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function uid()   { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function today() { return new Date().toISOString().slice(0, 10); }

function shortName(addr) {
  if (!addr) return '새 매장';
  const parts = addr.trim().split(/\s+/);
  return parts.slice(1, 3).join(' ') || parts[0] || '새 매장';
}

function formatPrice(p) {
  const n = parseInt(String(p).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? p : `₩${n.toLocaleString('ko-KR')}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
