(() => {
  const $ = (id) => document.getElementById(id);
  const intro = $('intro');
  document.body.classList.add('intro-open');
  const closeIntro = () => { intro.classList.add('dismissed'); document.body.classList.remove('intro-open'); };
  $('enterExperience').addEventListener('click', closeIntro);
  $('skipIntro').addEventListener('click', closeIntro);

  const videoEl = $('cameraVideo');
  const imagePreview = $('previewImage');
  const videoPreview = $('previewVideo');
  const placeholder = $('cameraPlaceholder');
  const cameraStatus = $('cameraStatus');
  const actionButton = $('mainCameraAction');
  const actionLabel = $('cameraActionLabel');
  const recordingBadge = $('recordingBadge');
  const recordTimer = $('recordTimer');
  const fileInput = $('fileInput');
  const submitButton = $('submitButton');
  const formStatus = $('formStatus');
  let currentMode = 'video';
  let facingMode = 'user';
  let stream = null;
  let recorder = null;
  let chunks = [];
  let selectedFile = null;
  let previewUrl = null;
  let recordTimeout = null;
  let timerInterval = null;
  let recordingStartedAt = 0;
  let mediaSerial = 0;
  const MAX_VIDEO_SECONDS = 30;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;

  const showToast = (message) => {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    window.clearTimeout(showToast.timeout); showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 3500);
  };
  const setStatus = (message, type = '') => { formStatus.textContent = message; formStatus.className = `form-status ${type}`.trim(); };
  const stopStream = () => {
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    videoEl.srcObject = null;
  };
  const clearTimers = () => { window.clearTimeout(recordTimeout); window.clearInterval(timerInterval); recordTimeout = null; timerInterval = null; };
  const releasePreview = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; };
  const resetPreviewElements = () => { imagePreview.hidden = true; videoPreview.hidden = true; videoEl.hidden = true; placeholder.hidden = false; videoEl.srcObject = stream; };
  const updateSubmitState = () => { submitButton.disabled = !(selectedFile && $('consentSubmit').checked); };
  const formatTime = (seconds) => `00:${String(Math.max(0, seconds)).padStart(2, '0')}`;

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('المتصفح مش بيدعم الكاميرا هنا. افتح الموقع من رابط HTTPS أو ارفع ملف من المعرض.');
      cameraStatus.textContent = 'الكاميرا محتاجة متصفح مدعوم ورابط آمن HTTPS'; return;
    }
    if (recorder && recorder.state === 'recording') return;
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: currentMode === 'video'
      });
      videoEl.srcObject = stream; videoEl.hidden = false; imagePreview.hidden = true; videoPreview.hidden = true; placeholder.hidden = true;
      cameraStatus.textContent = facingMode === 'user' ? 'الكاميرا الأمامية شغالة' : 'الكاميرا الخلفية شغالة';
      actionButton.disabled = false;
      if (currentMode === 'video') actionLabel.textContent = 'ابدأ التسجيل';
      else actionLabel.textContent = 'التقط الصورة';
    } catch (error) {
      stopStream();
      const msg = error && (error.name === 'NotAllowedError' ? 'اسمح للموقع باستخدام الكاميرا والميكروفون من إعدادات المتصفح.' : error.name === 'NotFoundError' ? 'مش لاقيين كاميرا أو ميكروفون متاح على الجهاز.' : 'مش قادرين نشغّل الكاميرا. جرّب تاني أو ارفع ملف من المعرض.');
      cameraStatus.textContent = 'تعذّر تشغيل الكاميرا'; showToast(msg);
    }
  }

  function stopRecordingUI() {
    clearTimers(); recordingBadge.hidden = true; actionButton.classList.remove('recording');
    actionButton.disabled = false;
    actionLabel.textContent = currentMode === 'photo' ? 'التقط الصورة' : 'ابدأ التسجيل';
  }

  function saveSelectedFile(file, fromRecorder = false) {
    if (!file) return;
    if (!['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'].includes(file.type)) {
      showToast('نوع الملف مش مدعوم. استخدم JPG أو PNG أو WebP أو MP4 أو WebM أو MOV.'); return;
    }
    if (file.size > MAX_FILE_BYTES) { showToast('حجم الملف أكبر من 100 ميجابايت. اختار ملف أصغر.'); return; }
    const serial = ++mediaSerial;
    releasePreview(); selectedFile = file;
    resetPreviewElements(); stopStream();
    previewUrl = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
      imagePreview.src = previewUrl; imagePreview.hidden = false; placeholder.hidden = true;
      cameraStatus.textContent = fromRecorder ? 'الصورة اتصورت وجاهزة للمراجعة' : 'الصورة المختارة جاهزة للمراجعة';
    } else {
      videoPreview.src = previewUrl; videoPreview.hidden = false; placeholder.hidden = true;
      videoPreview.onloadedmetadata = () => {
        if (serial !== mediaSerial) return;
        if (Number.isFinite(videoPreview.duration) && videoPreview.duration > MAX_VIDEO_SECONDS + 0.5) {
          selectedFile = null; releasePreview(); videoPreview.removeAttribute('src'); videoPreview.load(); videoPreview.hidden = true; placeholder.hidden = false; cameraStatus.textContent = 'الفيديو أطول من 30 ثانية'; updateSubmitState();
          showToast('الفيديو لازم يكون 30 ثانية أو أقل. قصّه وجرب تاني.');
        }
      };
      cameraStatus.textContent = fromRecorder ? 'الفيديو اتسجل وجاهز للمراجعة' : 'الفيديو المختار جاهز للمراجعة';
    }
    updateSubmitState(); setStatus('');
  }

  async function beginRecording() {
    if (!stream) { await startCamera(); if (!stream) return; }
    const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live');
    if (!hasVideo) { await startCamera(); if (!stream) return; }
    if (currentMode === 'photo') {
      if (!videoEl.videoWidth || !videoEl.videoHeight) { showToast('استنى لحظة لحد ما الصورة تظهر في الكاميرا.'); return; }
      const canvas = document.createElement('canvas'); canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => { if (blob) saveSelectedFile(new File([blob], `neferdidi-photo-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }), true); }, 'image/jpeg', .92);
      return;
    }
    if (!window.MediaRecorder) { showToast('تسجيل الفيديو مش مدعوم في المتصفح ده. استخدم رفع فيديو من المعرض.'); return; }
    const supportedTypes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    const mimeType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type));
    try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
    catch { showToast('مش قادرين نبدأ التسجيل على الجهاز ده. جرّب رفع فيديو من المعرض.'); return; }
    chunks = [];
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { stopRecordingUI(); showToast('حصلت مشكلة أثناء التسجيل. جرّب تاني.'); };
    recorder.onstop = () => {
      stopRecordingUI();
      if (!chunks.length) { cameraStatus.textContent = 'ما اتسجلش فيديو'; return; }
      const type = recorder.mimeType || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([new Blob(chunks, { type })], `neferdidi-video-${Date.now()}.${ext}`, { type, lastModified: Date.now() });
      saveSelectedFile(file, true); chunks = [];
    };
    recorder.start(250); recordingStartedAt = Date.now();
    actionButton.classList.add('recording'); actionLabel.textContent = 'إيقاف التسجيل'; recordingBadge.hidden = false;
    recordTimer.textContent = '00:00'; cameraStatus.textContent = 'بنسجل لحظتك دلوقتي…';
    timerInterval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
      recordTimer.textContent = formatTime(elapsed);
      if (elapsed >= MAX_VIDEO_SECONDS && recorder?.state === 'recording') stopRecording();
    }, 250);
    recordTimeout = window.setTimeout(() => { if (recorder?.state === 'recording') stopRecording(); }, MAX_VIDEO_SECONDS * 1000);
  }
  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
    clearTimers();
  }

  actionButton.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') stopRecording(); else beginRecording();
  });
  $('startCamera').addEventListener('click', startCamera);
  $('switchCamera').addEventListener('click', async () => { facingMode = facingMode === 'user' ? 'environment' : 'user'; await startCamera(); });
  document.querySelectorAll('.mode-button').forEach(button => button.addEventListener('click', async () => {
    currentMode = button.dataset.mode;
    document.querySelectorAll('.mode-button').forEach(el => { const active = el === button; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
    actionLabel.textContent = currentMode === 'video' ? 'ابدأ التسجيل' : 'التقط الصورة';
    fileInput.accept = currentMode === 'video' ? 'video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime';
    if (stream) await startCamera();
  }));
  $('clearMedia').addEventListener('click', () => {
    if (recorder?.state === 'recording') stopRecording();
    clearTimers(); selectedFile = null; releasePreview(); resetPreviewElements(); stopStream();
    fileInput.value = ''; recordingBadge.hidden = true; actionButton.classList.remove('recording');
    cameraStatus.textContent = 'الكاميرا جاهزة لما تكون إنت جاهز'; actionLabel.textContent = currentMode === 'video' ? 'ابدأ التسجيل' : 'التقط الصورة';
    updateSubmitState(); setStatus('');
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0]; if (!file) return;
    if (file.type.startsWith('video/')) {
      const probe = document.createElement('video'); const url = URL.createObjectURL(file); probe.preload = 'metadata'; probe.src = url;
      probe.onloadedmetadata = () => { const tooLong = Number.isFinite(probe.duration) && probe.duration > MAX_VIDEO_SECONDS + 0.5; URL.revokeObjectURL(url); if (tooLong) { fileInput.value = ''; showToast('الفيديو لازم يكون 30 ثانية أو أقل. قصّه وجرب تاني.'); } else saveSelectedFile(file); };
      probe.onerror = () => { URL.revokeObjectURL(url); saveSelectedFile(file); };
    } else saveSelectedFile(file);
  });
  $('consentSubmit').addEventListener('change', updateSubmitState);

  $('submissionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedFile) { setStatus('صوّر أو اختار صورة/فيديو الأول.', 'error'); showToast('لسه ما اخترتش صورة أو فيديو.'); return; }
    if (!$('consentSubmit').checked) { setStatus('لازم توافق على إرسال المشاركة علشان نكمل.', 'error'); return; }
    if (!navigator.onLine) { setStatus('مفيش اتصال بالإنترنت. اتصل بالإنترنت وجرب تاني.', 'error'); return; }
    const name = $('customerName').value.trim();
    if (!name) { $('customerName').focus(); return; }
    const formData = new FormData();
    formData.append('media', selectedFile, selectedFile.name);
    formData.append('name', name);
    formData.append('branch', $('branch').value);
    formData.append('note', $('momentNote').value.trim());
    formData.append('consentSubmit', 'true');
    formData.append('consentMarketing', $('consentMarketing').checked ? 'true' : 'false');
    submitButton.disabled = true; submitButton.innerHTML = '<span class="spinner" aria-hidden="true"></span> بنبعت لحظتك…'; setStatus('جاري رفع الملف. سيب الصفحة مفتوحة لحد ما الرفع يكتمل.');
    try {
      const response = await fetch('/api/submissions', { method: 'POST', body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'حصلت مشكلة أثناء الإرسال. جرّب تاني.');
      setStatus('وصلت لحظتك لفريق Neferdidi بنجاح. شكرًا إنك جزء من الحكاية!', 'success');
      showToast('لحظتك وصلت بنجاح. شكرًا ليك!');
      $('submissionForm').reset(); selectedFile = null; releasePreview(); resetPreviewElements(); stopStream(); fileInput.value = ''; updateSubmitState();
      cameraStatus.textContent = 'مستنيين لحظتك الجاية';
      actionButton.classList.remove('recording'); actionLabel.textContent = currentMode === 'video' ? 'ابدأ التسجيل' : 'التقط الصورة';
    } catch (error) {
      setStatus(error.message || 'تعذّر الإرسال. اتأكد من الإنترنت وحاول تاني.', 'error'); showToast(error.message || 'تعذّر إرسال المشاركة.'); updateSubmitState();
    } finally {
      submitButton.innerHTML = 'ابعت لحظتي <span aria-hidden="true">←</span>'; updateSubmitState();
    }
  });
  window.addEventListener('pagehide', () => { clearTimers(); stopStream(); releasePreview(); });
})();
