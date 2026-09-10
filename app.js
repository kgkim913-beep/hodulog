/* =========================================================
   호두로그 MVP — app.js
   기존 index.html의 UI/구조/전역 함수(showScreen, recordPhotos,
   openDetail, walnutSVG, starIcon, updateFinalScore 등)를 그대로
   활용하면서, 이 파일에서 "실제 기능"만 추가로 연결합니다.
   이 스크립트는 index.html 안의 기존 <script> 다음에 로드되어야
   합니다 (전역 함수/변수가 이미 정의되어 있어야 하므로).
========================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
   * -1. 화면에 직접 에러를 보여주는 함수 (모바일은 콘솔을 볼 수 없으므로
   *     문제가 생기면 무조건 화면에 문구로 남긴다)
   * ------------------------------------------------------- */
  function showFatalError(message) {
    console.error('[호두로그 치명적 오류]', message);
    let el = document.getElementById('hodulog-fatal-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hodulog-fatal-error';
      el.style.cssText =
        'position:fixed; left:12px; right:12px; top:12px; z-index:9999; ' +
        'background:#B3432B; color:#fff; padding:14px 16px; border-radius:12px; ' +
        'font-size:13px; line-height:1.5; box-shadow:0 4px 16px rgba(0,0,0,0.3);';
      document.body.appendChild(el);
    }
    el.textContent = '⚠️ 호두로그 오류: ' + message;
  }

  /* ---------------------------------------------------------
   * 0. Supabase 클라이언트
   * ------------------------------------------------------- */
  const CFG = window.HODULOG_CONFIG || {};
  let supabase = null;
  let supabaseReady = false;

  try {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error(
        'Supabase 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하거나, ' +
          '이 페이지를 file://로 직접 열지 말고 https 주소로 접속해주세요.'
      );
    }
    if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
      throw new Error('config.js에 SUPABASE_URL / SUPABASE_ANON_KEY를 아직 입력하지 않았어요.');
    }
    supabase = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    supabaseReady = true;
  } catch (e) {
    showFatalError(e.message);
  }
  const BUCKET = (CFG && CFG.STORAGE_BUCKET) || 'hodulog-photos';

  let currentUserId = null;
  let editingRecordId = null; // null이면 신규 등록, 값이 있으면 수정
  let currentGPS = null; // {lat, lng, accuracy} | null
  let existingPhotoUrls = []; // 수정 시 기존에 이미 올라가 있던 사진 URL 목록
  const recordsCache = new Map(); // id -> record (상세 모달에서 재사용)

  /* ---------------------------------------------------------
   * 1. IndexedDB 임시저장 (통신 불안정 대응)
   * ------------------------------------------------------- */
  const DB_NAME = 'hodulog-db';
  const STORE = 'drafts';
  const DRAFT_KEY = 'current';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSaveDraft(draft) {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(draft, DRAFT_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[임시저장 실패]', e);
    }
  }
  async function idbGetDraft() {
    try {
      const db = await idbOpen();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(DRAFT_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }
  async function idbDeleteDraft() {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(DRAFT_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      /* noop */
    }
  }

  let draftSaveTimer = null;
  function scheduleDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraftNow, 800);
  }
  async function saveDraftNow() {
    // record-record 화면이 아니면 저장하지 않음(다른 화면 조작 중 불필요한 draft 방지)
    if (!document.getElementById('screen-record').classList.contains('active')) return;
    const data = getFormData();
    data.photoFiles = recordPhotos.filter((p) => p.file).map((p) => p.file); // File은 IndexedDB에 그대로 저장 가능
    data.editingRecordId = editingRecordId;
    data.existingPhotoUrls = existingPhotoUrls;
    data.savedAt = Date.now();
    await idbSaveDraft(data);
  }

  /* ---------------------------------------------------------
   * 2. 인증 (익명 로그인) — RLS에서 auth.uid() 로 내 데이터만 구분
   * ------------------------------------------------------- */
  async function ensureAuth() {
    if (!supabaseReady) return;
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      currentUserId = data.session.user.id;
      return;
    }
    const { data: signInData, error } = await supabase.auth.signInAnonymously();
    if (error) {
      showFatalError(
        '로그인에 실패했어요. Supabase 대시보드에서 Authentication → Anonymous Sign-Ins가 켜져 있는지 확인해주세요. (' +
          error.message +
          ')'
      );
      return;
    }
    currentUserId = signInData.user.id;
  }

  /* ---------------------------------------------------------
   * 3. 사진: 카메라 촬영 / 앨범 선택 / 리사이즈 / 미리보기
   * ------------------------------------------------------- */
  function openFileInput({ capture }) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (capture) input.setAttribute('capture', capture);
      input.style.display = 'none';
      input.addEventListener(
        'change',
        () => {
          const file = input.files && input.files[0] ? input.files[0] : null;
          document.body.removeChild(input);
          resolve(file);
        },
        { once: true }
      );
      document.body.appendChild(input);
      input.click();
    });
  }

  /** 큰 사진을 업로드 전에 적당한 크기로 리사이즈 (최대 1600px, JPEG 0.82) */
  function resizeImageFile(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            resolve(blob || file);
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file); // 리사이즈 실패해도 원본으로 진행
      };
      img.src = url;
    });
  }

  // photo-sheet(사진 찍기/앨범에서 선택)는 "기록" 사진과 "새 여행 만들기" 사진이
  // 공용으로 사용한다. 어느 쪽에서 열었는지를 이 플래그로 구분한다.
  let photoSheetTarget = 'record'; // 'record' | 'trip'

  async function addPhotoFromSource(kind) {
    const isTrip = photoSheetTarget === 'trip';
    const currentCount = isTrip
      ? tripNewPhotoFiles.length
      : recordPhotos.length + existingPhotoUrls.length;
    const maxCount = isTrip ? TRIP_NEW_MAX_PHOTOS : MAX_PHOTOS;
    if (currentCount >= maxCount) { closePhotoSheet(); return; }

    const file = kind === 'camera'
      ? await openFileInput({ capture: 'environment' })
      : await openFileInput({ capture: null });
    if (!file) { closePhotoSheet(); return; }

    const resizedBlob = await resizeImageFile(file);
    const resizedFile = new File([resizedBlob], (file.name || 'photo') + '.jpg', { type: 'image/jpeg' });
    const previewUrl = URL.createObjectURL(resizedBlob);

    if (isTrip) {
      tripNewPhotoFiles.push({ file: resizedFile, previewUrl });
      renderTripNewPhotos();
    } else {
      recordPhotos.push({ file: resizedFile, previewUrl });
      renderRecordPhotos();
      scheduleDraftSave();
    }
    closePhotoSheet();
  }

  // 기존 mock 핸들러(addPhotoPlaceholder) 대신 실제 카메라/앨범 연결
  function rebindClickOnly(id, handler) {
    const el = document.getElementById(id);
    if (!el) { console.warn('[호두로그] 요소를 찾을 수 없음:', id); return; }
    const fresh = el.cloneNode(true);
    el.replaceWith(fresh);
    fresh.addEventListener('click', handler);
  }
  rebindClickOnly('photo-take-row', () => addPhotoFromSource('camera'));
  rebindClickOnly('photo-pick-row', () => addPhotoFromSource('library'));

  // renderRecordPhotos()를 실제 썸네일(이미지)이 보이도록 재정의
  // (기존 index.html의 renderRecordPhotos는 "사진 1" 텍스트만 표시하는 mock 이었음)
  window.renderRecordPhotos = function renderRecordPhotosReal() {
    const empty = document.getElementById('photo-empty');
    const wrap = document.getElementById('photo-list-wrap');
    const row = document.getElementById('photo-thumb-row');
    const count = document.getElementById('photo-count');

    const totalCount = existingPhotoUrls.length + recordPhotos.length;

    if (totalCount === 0) {
      empty.style.display = 'flex';
      wrap.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    wrap.style.display = 'block';

    const existingHtml = existingPhotoUrls
      .map(
        (url, i) =>
          `<div class="photo-thumb" data-existing-idx="${i}"><img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"><span class="photo-del" data-existing-idx="${i}">✕</span></div>`
      )
      .join('');
    const newHtml = recordPhotos
      .map(
        (p, i) =>
          `<div class="photo-thumb" data-idx="${i}"><img src="${p.previewUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"><span class="photo-del" data-idx="${i}">✕</span></div>`
      )
      .join('');

    row.innerHTML =
      existingHtml + newHtml + (totalCount < MAX_PHOTOS ? `<div class="photo-add-btn" id="photo-add-more">+</div>` : '');

    row.querySelectorAll('.photo-del[data-existing-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        existingPhotoUrls.splice(parseInt(btn.dataset.existingIdx), 1);
        renderRecordPhotos();
        scheduleDraftSave();
      });
    });
    row.querySelectorAll('.photo-del[data-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        recordPhotos.splice(parseInt(btn.dataset.idx), 1);
        renderRecordPhotos();
        scheduleDraftSave();
      });
    });
    const addMore = document.getElementById('photo-add-more');
    if (addMore) addMore.addEventListener('click', openPhotoSheet);

    count.textContent = `${totalCount} / ${MAX_PHOTOS}`;
  };

  /* ---------------------------------------------------------
   * 3-B. 새 여행 만들기: 사진 촬영/앨범 선택을 실제로 연결
   * (기존 index.html의 tripNewPhotos는 {id}만 담는 mock이었고,
   *  "이미지 추가" 버튼도 실제 카메라/앨범을 열지 않았음)
   * ------------------------------------------------------- */
  let tripNewPhotoFiles = []; // [{file, previewUrl}]

  function openPhotoSheetForTrip() {
    if (tripNewPhotoFiles.length >= TRIP_NEW_MAX_PHOTOS) return;
    photoSheetTarget = 'trip';
    document.getElementById('photo-sheet-scrim').classList.add('active');
    document.getElementById('photo-sheet').classList.add('active');
  }
  // 사진 촬영/앨범 선택 완료 후에는 다음 open 전까지 'record'로 되돌려 둔다.
  const _origClosePhotoSheet = closePhotoSheet;
  closePhotoSheet = function () {
    _origClosePhotoSheet();
    photoSheetTarget = 'record';
  };
  rebindClickOnly('trip-new-photo-add', openPhotoSheetForTrip);

  // renderTripNewPhotos()를 실제 썸네일(이미지)이 보이도록 재정의
  window.renderTripNewPhotos = function renderTripNewPhotosReal() {
    const row = document.getElementById('trip-new-photo-row');
    const count = document.getElementById('trip-new-photo-count');
    if (!row) return;

    const thumbsHtml = tripNewPhotoFiles
      .map(
        (p, i) =>
          `<div class="photo-thumb" data-idx="${i}"><img src="${p.previewUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"><span class="photo-del" data-idx="${i}">✕</span></div>`
      )
      .join('');
    const addBtnHtml =
      '<div class="trip-photo-upload" id="trip-new-photo-add">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.5-2h5L16 7"/><circle cx="12" cy="13.5" r="3.2"/></svg>' +
      '<span>이미지 추가</span></div>';

    row.innerHTML = (tripNewPhotoFiles.length < TRIP_NEW_MAX_PHOTOS ? addBtnHtml : '') + thumbsHtml;

    row.querySelectorAll('.photo-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const removed = tripNewPhotoFiles.splice(idx, 1)[0];
        if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        renderTripNewPhotos();
      });
    });

    const addBtn = document.getElementById('trip-new-photo-add');
    if (addBtn) addBtn.addEventListener('click', openPhotoSheetForTrip);

    count.textContent = `${tripNewPhotoFiles.length} / ${TRIP_NEW_MAX_PHOTOS}`;
  };

  // resetTripNewPhotos()도 실제 파일 배열/미리보기 URL을 정리하도록 재정의
  window.resetTripNewPhotos = function resetTripNewPhotosReal() {
    tripNewPhotoFiles.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    tripNewPhotoFiles.length = 0;
    renderTripNewPhotos();
  };
  // app.js 로드 시점까지 쌓여있던(placeholder) 상태를 실제 상태로 초기화
  resetTripNewPhotos();

  /** 새 여행 사진들을 Storage에 업로드하고 공개 URL 목록을 반환 */
  async function uploadTripPhotos(photoObjs) {
    if (!supabaseReady || !currentUserId || photoObjs.length === 0) return [];
    const urls = [];
    for (const p of photoObjs) {
      const path = `${currentUserId}/trips/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, p.file, {
        cacheControl: '3600',
        upsert: false,
        contentType: 'image/jpeg',
      });
      if (error) throw error;
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  }

  // 기존 mock 제출 핸들러(사진을 그대로 저장하지 않던 것) 대신,
  // 사진을 실제로 업로드한 뒤 여행을 생성하는 로직으로 교체.
  // 그 외 여행 생성/목록 갱신 흐름은 기존과 동일하게 유지한다.
  async function submitTripNew() {
    const title = document.getElementById('trip-new-title').value.trim() || '새 여행';
    const start = document.getElementById('trip-new-start').value;
    const end = document.getElementById('trip-new-end').value;
    const companionChip = document.querySelector('#trip-new-sheet .chip[data-companion].selected');
    const companion = companionChip ? companionChip.textContent : '혼자';
    const people = document.getElementById('trip-new-people').value.trim();
    const selectedTags = Array.from(document.querySelectorAll('#trip-new-tags .chip.selected')).map(
      (c) => c.dataset.tag
    );
    const memo = document.getElementById('trip-new-memo').value.trim();
    const dateRange = start ? (end && end !== start ? `${start} ~ ${end}` : start) : '날짜 미정';

    const btn = document.getElementById('trip-new-submit');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '저장 중…';

    try {
      const photoUrls = await uploadTripPhotos(tripNewPhotoFiles);
      const newId = 'trip_' + Date.now();
      tripsData[newId] = {
        title,
        dateRange,
        companion,
        people,
        tags: selectedTags,
        memo,
        photos: photoUrls,
        days: [],
      };
      renderTripList();
      closeTripNewSheet();
      document.getElementById('trip-new-title').value = '';
      document.getElementById('trip-new-start').value = '';
      document.getElementById('trip-new-end').value = '';
      document.getElementById('trip-new-people').value = '';
      document.getElementById('trip-new-memo').value = '';
      document.querySelectorAll('#trip-new-tags .chip').forEach((c) => c.classList.remove('selected'));
      resetTripNewPhotos();
    } catch (err) {
      console.error('[여행 사진 업로드 실패]', err);
      alert('사진 업로드에 실패했어요. 잠시 후 다시 시도해주세요.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
  rebindClickOnly('trip-new-submit', submitTripNew);

  /* ---------------------------------------------------------
   * 4. GPS
   * ------------------------------------------------------- */
  function requestGPS() {
    currentGPS = null;
    updateGpsIndicator('위치 확인 중…');
    if (!('geolocation' in navigator)) {
      updateGpsIndicator('이 기기에서는 위치를 사용할 수 없어요');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentGPS = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        updateGpsIndicator(`위치 확인됨 (오차 ±${Math.round(pos.coords.accuracy)}m)`);
        scheduleDraftSave();
      },
      (err) => {
        currentGPS = null;
        updateGpsIndicator('위치 권한이 없어도 기록은 등록할 수 있어요');
        console.warn('[GPS 오류]', err.message);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  /** 기존 화면 구조를 바꾸지 않기 위해, GPS 상태 문구는
   *  "휴게소 이름" 필드 바로 아래에 아주 작은 안내 텍스트로만 추가합니다. */
  function ensureGpsIndicatorEl() {
    let el = document.getElementById('gps-indicator');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'gps-indicator';
    el.style.cssText = 'font-size:11.5px; color:var(--text-400); margin-top:4px;';
    const placeField = document.getElementById('place-name-input').closest('.field');
    placeField.appendChild(el);
    return el;
  }
  function updateGpsIndicator(text) {
    ensureGpsIndicatorEl().textContent = '📍 ' + text;
  }

  /* ---------------------------------------------------------
   * 5. 기록 폼 read / write 헬퍼
   * ------------------------------------------------------- */
  function getSelectedCompanion() {
    const el = document.querySelector('#companion-chip-row .chip.selected');
    return el ? el.textContent.trim() : null;
  }
  function getSelectedTags() {
    return Array.from(document.querySelectorAll('#tag-chip-row .chip.selected')).map((c) =>
      c.textContent.replace('✕', '').trim()
    );
  }
  function getRatingsFromForm() {
    return {
      taste: parseInt(document.getElementById('rate-taste')?.dataset.rate || '4', 10),
      warm: parseInt(document.getElementById('temp-slider')?.value || '70', 10),
      red: parseInt(document.getElementById('rate-red')?.dataset.rate || '4', 10),
      walnut: parseInt(document.getElementById('rate-walnut')?.dataset.rate || '3', 10),
      texture: parseInt(document.getElementById('rate-texture')?.dataset.rate || '4', 10),
    };
  }
  function getFormData() {
    return {
      placeName: document.getElementById('place-name-input').value.trim(),
      tripName: document.getElementById('trip-value').textContent.trim(),
      companion: getSelectedCompanion(),
      ratings: getRatingsFromForm(),
      finalScore: parseInt(document.getElementById('final-score-num').textContent || '0', 10),
      tags: getSelectedTags(),
      memo: document.getElementById('memo-input').value.trim(),
      gps: currentGPS,
    };
  }

  function setRatingRow(rowId, value) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const isStar = row.id === 'rate-taste';
    const warm = row.classList.contains('warm');
    row.dataset.rate = value;
    row.querySelectorAll('.wn').forEach((el, idx) => {
      el.innerHTML = isStar ? starIcon(idx < value) : walnutSVG(idx < value, warm);
    });
    if (row.id === 'rate-taste') {
      document.getElementById('taste-score-text').textContent = value.toFixed(1) + ' / 5.0';
    }
  }

  function resetRecordForm() {
    editingRecordId = null;
    existingPhotoUrls = [];
    recordPhotos.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    recordPhotos.length = 0;
    renderRecordPhotos();
    document.getElementById('place-name-input').value = '';
    document.getElementById('memo-input').value = '';
    document.getElementById('trip-value').textContent = '여행 선택 안 함';
    document.querySelectorAll('#companion-chip-row .chip').forEach((c) => c.classList.remove('selected'));
    document.querySelectorAll('#tag-chip-row .chip[data-tag-type="custom"]').forEach((c) => c.remove());
    document.querySelectorAll('#tag-chip-row .chip').forEach((c) => c.classList.remove('selected'));
    setRatingRow('rate-taste', 4);
    setRatingRow('rate-red', 4);
    setRatingRow('rate-walnut', 3);
    setRatingRow('rate-texture', 4);
    const tempSlider = document.getElementById('temp-slider');
    tempSlider.value = 70;
    updateTempSliderFill(tempSlider);
    updateFinalScore();
    document.getElementById('record-submit').textContent = '등록';
    hideSubmitError();
  }

  function fillRecordForm(record) {
    editingRecordId = record.id;
    existingPhotoUrls = (record.photo_urls || []).slice();
    recordPhotos.length = 0;
    renderRecordPhotos();
    document.getElementById('place-name-input').value = record.place_name || '';
    document.getElementById('memo-input').value = record.memo || '';
    document.getElementById('trip-value').textContent = record.trip_name || '여행 선택 안 함';
    document.querySelectorAll('#companion-chip-row .chip').forEach((c) => {
      c.classList.toggle('selected', c.textContent.trim() === record.companion);
    });
    document.querySelectorAll('#tag-chip-row .chip[data-tag-type="custom"]').forEach((c) => c.remove());
    document.querySelectorAll('#tag-chip-row .chip[data-tag-type="preset"]').forEach((c) => {
      c.classList.toggle('selected', (record.tags || []).includes(c.textContent.trim()));
    });
    (record.tags || [])
      .filter((t) => !Array.from(document.querySelectorAll('#tag-chip-row .chip[data-tag-type="preset"]')).some((c) => c.textContent.trim() === t))
      .forEach((t) => addCustomTag(t));
    const r = record.ratings || {};
    setRatingRow('rate-taste', r.taste || 4);
    setRatingRow('rate-red', r.red || 4);
    setRatingRow('rate-walnut', r.walnut || 3);
    setRatingRow('rate-texture', r.texture || 4);
    const tempSlider = document.getElementById('temp-slider');
    tempSlider.value = r.warm != null ? r.warm : 70;
    updateTempSliderFill(tempSlider);
    updateFinalScore();
    currentGPS = record.gps || null;
    updateGpsIndicator(currentGPS ? '이전에 기록된 위치를 사용합니다' : '위치 정보 없음');
    document.getElementById('record-submit').textContent = '수정 완료';
    hideSubmitError();
  }

  /* ---------------------------------------------------------
   * 6. 화면 진입 지점 재배선 (새 기록 / 수정)
   * ------------------------------------------------------- */
  function openNewRecordScreen() {
    resetRecordForm();
    showScreen('screen-record');
    requestGPS();
  }
  // 기존에 showScreen('screen-record')로 직접 연결되어 있던 진입점들을
  // "새 기록 시작" 흐름(폼 초기화 + GPS 요청)으로 교체
  document.querySelector('.hero-banner-cta')?.setAttribute('onclick', '');
  document.querySelector('.hero-banner-cta')?.addEventListener('click', openNewRecordScreen);
  document.getElementById('fab-record')?.addEventListener('click', openNewRecordScreen);
  document.getElementById('trip-add-place')?.addEventListener('click', openNewRecordScreen);

  // 폼 변경 시 임시저장 예약
  ['place-name-input', 'memo-input'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', scheduleDraftSave);
  });
  document.getElementById('temp-slider')?.addEventListener('input', scheduleDraftSave);
  document.addEventListener('click', (e) => {
    if (e.target.closest('.chip') || e.target.closest('.rate-icons')) scheduleDraftSave();
  });

  /* ---------------------------------------------------------
   * 7. 사진 업로드 + Storage
   * ------------------------------------------------------- */
  async function uploadNewPhotos() {
    const urls = [];
    for (const p of recordPhotos) {
      const path = `${currentUserId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, p.file, {
        cacheControl: '3600',
        upsert: false,
        contentType: 'image/jpeg',
      });
      if (error) throw error;
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  }

  function showSubmitError(message, onRetry) {
    let el = document.getElementById('submit-error-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'submit-error-banner';
      el.style.cssText =
        'margin:var(--sp-3) var(--sp-4); padding:var(--sp-3); background:#FBEAE6; border:1px solid #E8B4A8; border-radius:var(--r-md); color:#B3432B; font-size:13px;';
      document.getElementById('record-cta-bar').insertAdjacentElement('beforebegin', el);
    }
    el.innerHTML = '';
    const msgDiv = document.createElement('div');
    msgDiv.textContent = message;
    msgDiv.style.marginBottom = '8px';
    el.appendChild(msgDiv);
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn primary';
    retryBtn.style.height = '38px';
    retryBtn.textContent = '다시 업로드';
    retryBtn.addEventListener('click', onRetry);
    el.appendChild(retryBtn);
    el.style.display = 'block';
  }
  function hideSubmitError() {
    const el = document.getElementById('submit-error-banner');
    if (el) el.style.display = 'none';
  }

  async function submitRecord() {
    const form = getFormData();
    if (!form.placeName) {
      alert('휴게소(장소) 이름을 입력해주세요.');
      return;
    }
    const btn = document.getElementById('record-submit');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '등록 중…';
    hideSubmitError();
    await saveDraftNow(); // 업로드 도중 끊겨도 복구 가능하도록 우선 저장

    try {
      const newUrls = await uploadNewPhotos();
      const photo_urls = [...existingPhotoUrls, ...newUrls];

      const payload = {
        place_name: form.placeName,
        trip_name: form.tripName,
        companion: form.companion,
        ratings: form.ratings,
        final_score: form.finalScore,
        tags: form.tags,
        memo: form.memo || null,
        gps_lat: form.gps ? form.gps.lat : null,
        gps_lng: form.gps ? form.gps.lng : null,
        gps_accuracy: form.gps ? form.gps.accuracy : null,
        photo_urls,
        user_id: currentUserId,
      };

      if (editingRecordId) {
        const { error } = await supabase.from('records').update(payload).eq('id', editingRecordId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('records').insert(payload);
        if (error) throw error;
      }

      await idbDeleteDraft();
      btn.disabled = false;
      btn.textContent = originalLabel;
      document.getElementById('dialog-scrim').classList.add('active');
      await loadMyRecords();
    } catch (err) {
      console.error('[등록 실패]', err);
      btn.disabled = false;
      btn.textContent = originalLabel;
      showSubmitError(
        '네트워크 문제로 저장하지 못했어요. 작성한 내용은 기기에 안전하게 남아있어요.',
        submitRecord
      );
    }
  }

  // 기존 mock 제출 핸들러 제거 후 실제 로직으로 교체
  rebindClickOnly('record-submit', submitRecord);

  // record-cancel도 폼을 초기화하도록 보강 (기존 동작인 홈 이동은 유지)
  document.getElementById('record-cancel')?.addEventListener('click', () => {
    idbDeleteDraft();
  });

  /* ---------------------------------------------------------
   * 8. 실제 기록 목록 (홈 화면) + 상세보기 + 수정 + 삭제
   * ------------------------------------------------------- */
  function ensureMyRecordsCard() {
    let card = document.getElementById('my-records-card');
    if (card) return card;
    card = document.createElement('div');
    card.className = 'trip-card';
    card.id = 'my-records-card';
    card.innerHTML = `
      <div class="trip-card-header">내가 기록한 호두과자</div>
      <div class="list-group inset" id="my-records-list"></div>
    `;
    const homeFilled = document.getElementById('home-filled');
    // 순서: '내가 기록한 호두과자'를 먼저, '나의 여행 기록'(기존 정적 마크업)을 다음에 배치
    homeFilled.insertBefore(card, homeFilled.firstChild);
    return card;
  }

  /**
   * 종합맛(final_score) 내림차순 정렬. 동점 기준:
   * 1) final_score 높은 순 → 2) 맛(taste) 별점 높은 순 → 3) 먼저 기록한 순(created_at 오름차순)
   */
  function sortForRanking(records) {
    return [...records].sort((a, b) => {
      const scoreDiff = (b.final_score || 0) - (a.final_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const tasteDiff = ((b.ratings && b.ratings.taste) || 0) - ((a.ratings && a.ratings.taste) || 0);
      if (tasteDiff !== 0) return tasteDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });
  }

  function renderRankingEmptyState(container, message) {
    container.innerHTML =
      `<div class="empty" style="padding:var(--sp-6) var(--sp-4);">` +
      `<div class="empty-char"></div>` +
      `<div class="empty-title">${message}</div>` +
      `</div>`;
    const charEl = container.querySelector('.empty-char');
    if (charEl && typeof walnutChar === 'function') {
      charEl.innerHTML = walnutChar({ size: 100, sad: true, body: '#D8C7A8' });
    }
  }

  function podiumColHtml(record, rank) {
    const thumb = record.photo_urls && record.photo_urls[0]
      ? `<img src="${record.photo_urls[0]}" style="width:52px;height:52px;border-radius:10px;object-fit:cover;">`
      : `<div class="thumb" style="width:52px;height:52px;">사진</div>`;
    const scoreOutOf5 = ((record.final_score || 0) / 20).toFixed(1);
    return `<div class="podium-col rank-${rank}" data-real-record-id="${record.id}">
      ${thumb}
      <div class="podium-name">${escapeHtml(record.place_name)}</div>
      <div class="podium-route">${escapeHtml(record.trip_name || '')}</div>
      <div class="podium-score">${scoreOutOf5}</div>
      <div class="podium-stand">${rank}</div>
    </div>`;
  }

  /** 호두랭킹 화면(전체)을 실제 데이터로 그린다. 등록/수정/삭제 시마다 재호출되어 즉시 동기화된다. */
  function renderRanking(records) {
    const podiumEl = document.getElementById('ranking-podium');
    const listEl = document.getElementById('ranking-list');
    if (!podiumEl || !listEl) return;

    const ranked = sortForRanking(records || []);
    if (ranked.length === 0) {
      renderRankingEmptyState(podiumEl, '아직 기록된 호두과자가 없어요');
      listEl.innerHTML = '';
      return;
    }

    const top3 = ranked.slice(0, 3);
    const rest = ranked.slice(3);
    // 기존 디자인과 동일하게 2위·1위·3위 순서로 배치(1위가 가운데, 가장 크게)
    const order = [top3[1], top3[0], top3[2]].filter(Boolean);
    podiumEl.innerHTML = order.map((r) => podiumColHtml(r, top3.indexOf(r) + 1)).join('');
    podiumEl.querySelectorAll('[data-real-record-id]').forEach((el) => {
      el.addEventListener('click', () => openRealDetail(recordsCache.get(el.dataset.realRecordId)));
    });

    if (rest.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = rest
      .map((r, i) => {
        const thumb = r.photo_urls && r.photo_urls[0]
          ? `<img src="${r.photo_urls[0]}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
          : '사진';
        const scoreOutOf5 = ((r.final_score || 0) / 20).toFixed(1);
        return `<div class="list-item" data-real-record-id="${r.id}">
          <div style="width:20px; font-size:13px; color:var(--text-400); flex-shrink:0;">${i + 4}</div>
          <div class="thumb">${thumb}</div>
          <div class="list-body"><div class="list-title">${escapeHtml(r.place_name)}</div><div class="list-sub">${escapeHtml(r.trip_name || '')}</div></div>
          <div class="list-trail"><span class="wn-static"></span> ${scoreOutOf5}</div>
        </div>`;
      })
      .join('');
    listEl.querySelectorAll('[data-real-record-id]').forEach((el) => {
      el.addEventListener('click', () => openRealDetail(recordsCache.get(el.dataset.realRecordId)));
    });
  }

  /** 메인 화면의 "나의 호두 랭킹" 1위 미리보기를 실제 데이터로 그린다. */
  function renderHomeRankPreview(records) {
    const el = document.getElementById('home-rank-preview');
    if (!el) return;
    const ranked = sortForRanking(records || []);
    if (ranked.length === 0) {
      el.innerHTML =
        '<div class="nearby-empty"><div class="nearby-empty-text">아직 기록된 호두과자가 없어요. 첫 기록을 남겨보세요!</div></div>';
      return;
    }
    const top = ranked[0];
    const thumb = top.photo_urls && top.photo_urls[0]
      ? `<img class="featured-char" src="${top.photo_urls[0]}" style="object-fit:cover;">`
      : '<div class="featured-char" style="display:flex;align-items:center;justify-content:center;color:var(--text-400);font-size:11px;">사진</div>';
    const scoreOutOf5 = ((top.final_score || 0) / 20).toFixed(1);
    el.innerHTML = `<div class="featured" data-real-record-id="${top.id}">
      ${thumb}
      <div class="list-body">
        <div class="rank-preview-label">1위</div>
        <div class="list-title">${escapeHtml(top.place_name)}</div>
        <div class="list-sub">${escapeHtml(top.trip_name || '')}</div>
      </div>
      <div class="list-trail"><span class="wn-static"></span> ${scoreOutOf5}</div>
    </div>`;
    const clickTarget = el.querySelector('[data-real-record-id]');
    if (clickTarget) clickTarget.addEventListener('click', () => openRealDetail(recordsCache.get(top.id)));
  }

  async function loadMyRecords() {
    ensureMyRecordsCard();
    const listEl = document.getElementById('my-records-list');
    listEl.innerHTML = '<div style="padding:16px; color:var(--text-400); font-size:13px;">불러오는 중…</div>';

    const { data, error } = await supabase
      .from('records')
      .select('*')
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false });

    if (error) {
      listEl.innerHTML = `<div style="padding:16px; color:#B3432B; font-size:13px;">불러오기 실패: ${error.message}</div>`;
      return;
    }

    recordsCache.clear();
    (data || []).forEach((r) => recordsCache.set(r.id, r));

    // 메인의 "나의 호두 랭킹" 미리보기와 호두랭킹 화면은 항상 이 데이터와 동기화된다.
    renderHomeRankPreview(data || []);
    renderRanking(data || []);

    if (!data || data.length === 0) {
      listEl.innerHTML =
        '<div style="padding:16px; color:var(--text-400); font-size:13px;">아직 기록이 없어요. "+ 새로운 호두과자 등록하기"로 첫 기록을 남겨보세요.</div>';
      return;
    }

    listEl.innerHTML = data
      .map((r) => {
        const thumb = r.photo_urls && r.photo_urls[0]
          ? `<img src="${r.photo_urls[0]}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
          : '사진';
        const scoreOutOf5 = ((r.final_score || 0) / 20).toFixed(1);
        const sub = [r.tags && r.tags[0], r.companion].filter(Boolean).join(' · ');
        return `<div class="list-item" data-real-record-id="${r.id}">
          <div class="thumb">${thumb}</div>
          <div class="list-body"><div class="list-title">${escapeHtml(r.place_name)}</div><div class="list-sub">${escapeHtml(sub)}</div></div>
          <div class="list-trail"><span class="wn-static"></span> ${scoreOutOf5}</div>
        </div>`;
      })
      .join('');

    attachRecordListInteractions(listEl);
  }

  /**
   * 내가 직접 등록한 기록 목록 전용: 길게 누르기 또는 오른쪽 스와이프 시 삭제 버튼을 노출한다.
   * 세로 스크롤/탭 제스처와 구분해 가로 이동이 뚜렷할 때만 반응하며,
   * 취소하면 원래 상태로 복원된다. 랭킹·추천 등 시스템이 채우는 목록에는 적용하지 않는다.
   */
  function attachRecordListInteractions(container) {
    const LONG_PRESS_MS = 500;
    const SWIPE_THRESHOLD = 60;
    const MOVE_CANCEL = 10;

    container.querySelectorAll('.list-item[data-real-record-id]').forEach((item) => {
      item.style.position = 'relative';
      item.style.touchAction = 'pan-y'; // 세로 스크롤은 브라우저가 그대로 처리하도록 둔다
      item.style.overflow = 'hidden';

      let startX = 0;
      let startY = 0;
      let longPressTimer = null;
      let revealed = false;

      const reveal = () => {
        if (revealed) return;
        revealed = true;
        const btn = document.createElement('button');
        btn.className = 'swipe-del-btn';
        btn.textContent = '삭제';
        btn.style.cssText =
          'position:absolute; top:0; right:0; height:100%; width:64px; border:none; ' +
          'background:var(--warm-accent); color:#fff; font-size:13px; font-weight:600; cursor:pointer;';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = item.dataset.realRecordId;
          if (confirm('이 기록을 삭제할까요? 되돌릴 수 없어요.')) {
            performDeleteRecord(id);
          } else {
            unreveal();
          }
        });
        item.appendChild(btn);
        item.style.paddingRight = '64px';
      };
      const unreveal = () => {
        revealed = false;
        const btn = item.querySelector('.swipe-del-btn');
        if (btn) btn.remove();
        item.style.paddingRight = '';
      };

      item.addEventListener('pointerdown', (e) => {
        startX = e.clientX;
        startY = e.clientY;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(reveal, LONG_PRESS_MS);
      });
      item.addEventListener('pointermove', (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > MOVE_CANCEL || Math.abs(dy) > MOVE_CANCEL) {
          clearTimeout(longPressTimer);
        }
        // 오른쪽으로 뚜렷하게 스와이프할 때만 반응 (세로 스크롤과 구분)
        if (dx > SWIPE_THRESHOLD && dx > Math.abs(dy) * 1.5) {
          reveal();
        }
      });
      const clearTimer = () => clearTimeout(longPressTimer);
      item.addEventListener('pointerup', clearTimer);
      item.addEventListener('pointercancel', clearTimer);
      item.addEventListener('pointerleave', clearTimer);

      item.addEventListener('click', (e) => {
        if (revealed) {
          e.preventDefault();
          e.stopPropagation();
          unreveal();
          return;
        }
        openRealDetail(recordsCache.get(item.dataset.realRecordId));
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openRealDetail(record) {
    if (!record) return;
    document.getElementById('detail-title').textContent = record.place_name;
    document.getElementById('detail-meta').innerHTML = `<div class="detail-meta-route">${escapeHtml(
      record.trip_name || ''
    )}</div><div class="detail-meta-sub">${new Date(record.created_at).toLocaleDateString('ko-KR')} · ${escapeHtml(
      record.companion || ''
    )}</div>`;
    renderDetailCarouselUrls(record.photo_urls || []);
    document.getElementById('detail-ratings').innerHTML = renderDetailRatings(record.ratings || {});
    document.getElementById('detail-tags').innerHTML = (record.tags || [])
      .map((t) => `<span class="chip selected">${escapeHtml(t)}</span>`)
      .join('');
    document.getElementById('detail-memo').textContent = record.memo || '';

    const deleteBtn = document.getElementById('detail-delete-btn');
    deleteBtn.style.display = 'flex';
    deleteBtn.onclick = () => deleteRecord(record.id);

    document.getElementById('detail-edit').onclick = () => {
      closeDetail();
      fillRecordForm(record);
      showScreen('screen-record');
    };
    document.getElementById('detail-confirm').onclick = closeDetail;

    document.getElementById('detail-scrim').classList.add('active');
    document.getElementById('detail-sheet').classList.add('active');
  }

  /** 실제 사진 URL 배열로 캐러셀을 그림 (기존 renderDetailCarousel은 mock 개수만 받음) */
  function renderDetailCarouselUrls(urls) {
    const track = document.getElementById('detail-carousel-track');
    const dots = document.getElementById('detail-carousel-dots');
    const n = urls.length;
    detailCarouselIndex = 0;
    detailCarouselCount = n === 0 ? 1 : n;

    track.style.width = detailCarouselCount * 100 + '%';
    track.innerHTML =
      n === 0
        ? `<div class="carousel-slide">사진</div>`
        : urls
            .map(
              (u) =>
                `<div class="carousel-slide"><img src="${u}" style="width:100%;height:100%;object-fit:cover;"></div>`
            )
            .join('');
    Array.from(track.children).forEach((el) => (el.style.width = 100 / detailCarouselCount + '%'));
    track.style.transform = 'translateX(0%)';

    if (n <= 1) {
      dots.innerHTML = '';
      dots.style.display = 'none';
    } else {
      dots.style.display = 'flex';
      dots.innerHTML = Array.from({ length: n })
        .map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}"></span>`)
        .join('');
    }
  }

  /** 확인창 없이 실제 삭제만 수행 (스와이프/길게 누르기 흐름에서 재사용) */
  async function performDeleteRecord(id) {
    const record = recordsCache.get(id);
    const { error } = await supabase.from('records').delete().eq('id', id);
    if (error) {
      alert('삭제에 실패했습니다: ' + error.message);
      return false;
    }
    if (record && record.photo_urls && record.photo_urls.length) {
      const paths = record.photo_urls.map(urlToStoragePath).filter(Boolean);
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    }
    await loadMyRecords();
    return true;
  }
  async function deleteRecord(id) {
    if (!confirm('이 기록을 삭제할까요? 되돌릴 수 없어요.')) return;
    const ok = await performDeleteRecord(id);
    if (ok) closeDetail();
  }
  function urlToStoragePath(publicUrl) {
    const marker = `/object/public/${BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(publicUrl.slice(idx + marker.length));
  }

  /* ---------------------------------------------------------
   * 9. 이어서 작성하기 (초안 복구)
   * ------------------------------------------------------- */
  async function maybeRestoreDraft() {
    const draft = await idbGetDraft();
    if (!draft || !draft.placeName) return;
    const ageMin = Math.round((Date.now() - (draft.savedAt || 0)) / 60000);
    const ok = confirm(`이전에 작성하던 기록이 있어요 (약 ${ageMin}분 전). 이어서 작성할까요?`);
    if (!ok) {
      await idbDeleteDraft();
      return;
    }
    editingRecordId = draft.editingRecordId || null;
    existingPhotoUrls = draft.existingPhotoUrls || [];
    recordPhotos.length = 0;
    (draft.photoFiles || []).forEach((file) => {
      recordPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
    });
    renderRecordPhotos();
    document.getElementById('place-name-input').value = draft.placeName || '';
    document.getElementById('memo-input').value = draft.memo || '';
    document.getElementById('trip-value').textContent = draft.tripName || '여행 선택 안 함';
    document.querySelectorAll('#companion-chip-row .chip').forEach((c) => {
      c.classList.toggle('selected', c.textContent.trim() === draft.companion);
    });
    const r = draft.ratings || {};
    setRatingRow('rate-taste', r.taste || 4);
    setRatingRow('rate-red', r.red || 4);
    setRatingRow('rate-walnut', r.walnut || 3);
    setRatingRow('rate-texture', r.texture || 4);
    const tempSlider = document.getElementById('temp-slider');
    tempSlider.value = r.warm != null ? r.warm : 70;
    updateTempSliderFill(tempSlider);
    updateFinalScore();
    currentGPS = draft.gps || null;
    updateGpsIndicator(currentGPS ? '이전 위치 정보를 사용합니다' : '위치 정보 없음');
    showScreen('screen-record');
  }

  /* ---------------------------------------------------------
   * 10. 서비스워커 등록 (PWA 설치 요건)
   * ------------------------------------------------------- */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[SW 등록 실패]', e));
    }
  }

  /* ---------------------------------------------------------
   * 11. 초기화
   * ------------------------------------------------------- */
  async function init() {
    try { registerServiceWorker(); } catch (e) { console.warn('[SW]', e); }

    if (!supabaseReady) {
      // Supabase 연결 자체가 안 되어도, 사진/GPS 등 나머지 UI는 계속 쓸 수 있게 여기서 멈춘다.
      return;
    }
    try {
      await ensureAuth();
    } catch (e) {
      showFatalError('로그인 처리 중 문제가 발생했어요: ' + e.message);
      return;
    }
    if (!currentUserId) return;

    try {
      await loadMyRecords();
    } catch (e) {
      console.error('[기록 목록 로드 실패]', e);
    }
    try {
      await maybeRestoreDraft();
    } catch (e) {
      console.error('[임시저장 복구 실패]', e);
    }
  }

  init().catch((e) => showFatalError('초기화 중 예상치 못한 오류: ' + e.message));
})();
